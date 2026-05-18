const express     = require('express')
const router      = express.Router()
const plaidClient = require('../db/plaid')
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { Products, CountryCode } = require('plaid')

// All Plaid routes require auth
router.use(requireAuth)

// POST /api/plaid/link-token — create a Plaid Link token to open the widget
router.post('/link-token', async (req, res, next) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: String(req.user.id) },
      client_name: 'Lumen',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
    })
    res.json({ link_token: response.data.link_token })
  } catch (err) {
    console.error('Plaid link-token error:', err.response?.data || err.message)
    next(err)
  }
})

// POST /api/plaid/exchange — exchange public token after user connects bank
router.post('/exchange', async (req, res, next) => {
  try {
    const { public_token, institution_id, institution_name } = req.body

    // Exchange for permanent access token
    const exchangeRes = await plaidClient.itemPublicTokenExchange({ public_token })
    const { access_token, item_id } = exchangeRes.data

    // Save the item
    const { rows } = await pool.query(
      `INSERT INTO plaid_items (user_id, access_token, item_id, institution_id, institution_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id) DO UPDATE SET access_token = EXCLUDED.access_token
       RETURNING id`,
      [req.user.id, access_token, item_id, institution_id || null, institution_name || null]
    )
    const plaidItemId = rows[0].id

    // Fetch accounts from Plaid and save them
    const accountsRes = await plaidClient.accountsGet({ access_token })
    const plaidAccounts = accountsRes.data.accounts

    for (const acct of plaidAccounts) {
      const type = mapAccountType(acct.type, acct.subtype)
      const isDebt = ['credit', 'loan'].includes(type)
      const balance = isDebt
        ? acct.balances.current || 0
        : acct.balances.available || acct.balances.current || 0

      await pool.query(
        `INSERT INTO accounts
           (user_id, plaid_item_id, plaid_account_id, name, type, institution, balance,
            mask, is_debt, limit_amt, icon, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (plaid_account_id) DO UPDATE SET
           balance = EXCLUDED.balance,
           name    = EXCLUDED.name`,
        [
          req.user.id, plaidItemId, acct.account_id,
          acct.name, type, institution_name || 'Bank',
          balance, acct.mask, isDebt,
          acct.balances.limit || null,
          iconForType(type), colorForType(type),
        ]
      )
    }

    // Do an initial transaction sync
    await syncTransactions(req.user.id, plaidItemId, access_token, item_id)

    res.json({ success: true, accountCount: plaidAccounts.length })
  } catch (err) {
    console.error('Plaid exchange error:', err.response?.data || err.message)
    next(err)
  }
})

// POST /api/plaid/sync — pull latest transactions for all user's items
router.post('/sync', async (req, res, next) => {
  try {
    const { rows: items } = await pool.query(
      'SELECT * FROM plaid_items WHERE user_id = $1',
      [req.user.id]
    )

    if (!items.length) {
      return res.json({ message: 'No connected accounts', synced: 0 })
    }

    let totalSynced = 0
    for (const item of items) {
      totalSynced += await syncTransactions(
        req.user.id, item.id, item.access_token, item.item_id, item.cursor
      )
    }

    res.json({ success: true, synced: totalSynced })
    // Apply rules to newly synced transactions in background
    if (totalSynced > 0) applyRulesToUser(req.user.id).catch(e => console.error("[Rules]", e.message))
  } catch (err) {
    console.error('Plaid sync error:', err.response?.data || err.message)
    next(err)
  }
})

// ── Helpers ────────────────────────────────────────────────

async function syncTransactions(userId, plaidItemId, accessToken, itemId, cursor = null) {
  let added = 0
  let nextCursor = cursor
  let hasMore = true
  const newTxIds = []  // track IDs for Gmail enrichment

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor || undefined,
    })

    const { added: newTxs, modified, removed, next_cursor, has_more } = response.data

    // Insert new transactions
    for (const tx of newTxs) {
      const accountRes = await pool.query(
        'SELECT id FROM accounts WHERE plaid_account_id = $1 AND user_id = $2',
        [tx.account_id, userId]
      )
      if (!accountRes.rows.length) continue

      const accountId = accountRes.rows[0].id
      const amount = -tx.amount // Plaid: positive = debit, we store negative = expense
      const category = tx.personal_finance_category?.primary || tx.category?.[0] || 'Other'

      const { rows: inserted } = await pool.query(
        `INSERT INTO transactions
           (user_id, account_id, plaid_transaction_id, name, amount, category, icon, date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (plaid_transaction_id) DO NOTHING
         RETURNING id`,
        [userId, accountId, tx.transaction_id, tx.name, amount, category, null, tx.date]
      )
      if (inserted.length) {
        newTxIds.push(inserted[0].id)
        added++
      }
    }

    // Update modified
    for (const tx of modified) {
      const amount = -tx.amount
      await pool.query(
        `UPDATE transactions SET name=$1, amount=$2, date=$3
         WHERE plaid_transaction_id=$4 AND user_id=$5`,
        [tx.name, amount, tx.date, tx.transaction_id, userId]
      )
    }

    // Remove deleted
    for (const tx of removed) {
      await pool.query(
        'DELETE FROM transactions WHERE plaid_transaction_id=$1 AND user_id=$2',
        [tx.transaction_id, userId]
      )
    }

    nextCursor = next_cursor
    hasMore = has_more
  }

  // Save cursor for next sync
  await pool.query(
    'UPDATE plaid_items SET cursor=$1, last_synced=NOW() WHERE id=$2',
    [nextCursor, plaidItemId]
  )

  // Phase 3 — enrich new transactions with Gmail receipt data (fire and forget)
  if (newTxIds.length) {
    const { enrichNewTransactions } = require('./gmail-parser')
    enrichNewTransactions(userId, newTxIds).catch(e =>
      console.warn('[Gmail enrichment]', e.message)
    )
  }

  return added
}

function mapAccountType(type, subtype) {
  if (type === 'depository') {
    return subtype === 'savings' ? 'savings' : 'checking'
  }
  if (type === 'credit') return 'credit'
  if (type === 'loan')   return 'loan'
  return 'checking'
}

function iconForType(type) {
  const map = { checking: '🏦', savings: '💰', credit: '💳', loan: '🎓' }
  return map[type] || '🏦'
}

function colorForType(type) {
  const map = { checking: 'safe', savings: 'calm', credit: 'goal', loan: 'debt' }
  return map[type] || 'safe'
}


// Exported for cron job — syncs all plaid items for one user
async function syncTransactionsForUser(userId) {
  const { rows: items } = await pool.query(
    'SELECT * FROM plaid_items WHERE user_id = $1',
    [userId]
  )
  let total = 0
  for (const item of items) {
    total += await syncTransactions(userId, item.id, item.access_token, item.item_id, item.cursor)
  }
  return total
}

// Also apply rules after user-triggered sync (fire and forget)
const { applyRulesToUser } = require("./rules")

module.exports = router
module.exports.syncTransactionsForUser = syncTransactionsForUser
