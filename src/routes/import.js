/**
 * POST /api/import/csv
 * Accepts a JSON array of parsed CSV rows, validates them, and inserts as transactions.
 * CSV parsing is done client-side (Papa.parse) and sent as JSON to avoid server-side deps.
 *
 * Phase B: Uses shared transactionIntelligence pipeline for categorization + cleaning.
 * Also runs duplicate detection on all newly imported transactions.
 *
 * Expected row shape (all strings, we coerce):
 * {
 *   date:     'YYYY-MM-DD' or 'MM/DD/YYYY',
 *   name:     string (merchant/description),
 *   amount:   string (e.g. '-42.50' or '42.50'),
 *   category: string (optional — falls back to pipeline),
 *   account:  string (account name or id, optional),
 *   note:     string (optional),
 * }
 */
const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const {
  cleanMerchantName,
  categorizeTransaction,
  detectDuplicates,
} = require('../utils/transactionIntelligence')

router.use(requireAuth)

// POST /api/import/csv — bulk import parsed CSV rows
router.post('/csv', async (req, res) => {
  const { rows, account_id } = req.body
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows array is required' })
  }

  const results  = { imported: 0, skipped: 0, errors: [] }
  const inserted = []

  // Fetch user's accounts for name-to-id matching
  const { rows: accounts } = await pool.query(
    'SELECT id, name FROM accounts WHERE user_id = $1',
    [req.user.id]
  )

  for (const row of rows) {
    try {
      // Parse date
      const date = parseDate(row.date)
      if (!date) {
        results.skipped++
        results.errors.push(`Row "${row.name}": invalid date "${row.date}"`)
        continue
      }

      // Parse amount
      const rawAmt = String(row.amount || '').replace(/[$,\s]/g, '')
      const amount = parseFloat(rawAmt)
      if (isNaN(amount)) {
        results.skipped++
        results.errors.push(`Row "${row.name}": invalid amount "${row.amount}"`)
        continue
      }

      // Resolve account
      let resolvedAccountId = account_id || null
      if (!resolvedAccountId && row.account) {
        const match = accounts.find(a =>
          a.name.toLowerCase().includes(row.account.toLowerCase()) ||
          String(a.id) === String(row.account)
        )
        if (match) resolvedAccountId = match.id
      }

      // Phase B-1: Clean merchant name
      const { cleanedName, category: merchantCategory, icon: merchantIcon } =
        await cleanMerchantName(row.name, req.user.id)
          .catch(() => ({ cleanedName: row.name, category: null, icon: null }))

      // Phase B-2: Categorize via full pipeline (rules → corrections → AI)
      let finalCategory = row.category || null
      if (!finalCategory) {
        const { category: cat } = await categorizeTransaction(row.name, amount, req.user.id)
          .catch(() => ({ category: merchantCategory || (amount > 0 ? 'Income' : 'Other') }))
        finalCategory = cat || merchantCategory || (amount > 0 ? 'Income' : 'Other')
      }

      const finalCleanedName = (cleanedName && cleanedName !== row.name) ? cleanedName : null
      const finalIcon        = merchantIcon || null

      const { rows: tx } = await pool.query(
        `INSERT INTO transactions (user_id, account_id, name, cleaned_name, amount, category, icon, date, note, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'csv')
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [req.user.id, resolvedAccountId, row.name, finalCleanedName, amount,
         finalCategory, finalIcon, date, row.note || null]
      )

      if (tx.length) {
        inserted.push(tx[0])
        results.imported++
      } else {
        results.skipped++ // duplicate (DB-level ON CONFLICT)
      }
    } catch (err) {
      results.skipped++
      results.errors.push(`Row "${row.name}": ${err.message}`)
    }
  }

  // Phase B-3: Duplicate detection on all newly imported transactions
  if (inserted.length) {
    const newIds = inserted.map(t => t.id)
    detectDuplicates(req.user.id, newIds).catch(e =>
      console.warn('[Phase B] CSV duplicate detection error:', e.message)
    )
  }

  res.json({ ...results, transactions: inserted })
})

// POST /api/import/csv/preview — validate rows without inserting
router.post('/csv/preview', async (req, res) => {
  const { rows } = req.body
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows array is required' })
  }

  const preview = rows.slice(0, 10).map(row => ({
    date:     parseDate(row.date) || row.date,
    name:     row.name,
    amount:   parseFloat(String(row.amount || '').replace(/[$,\s]/g, '')),
    category: row.category || 'Auto-detect',
    note:     row.note || null,
    valid:    !!(parseDate(row.date) && !isNaN(parseFloat(String(row.amount || '').replace(/[$,\s]/g, ''))))
  }))

  res.json({ preview, total: rows.length })
})

// POST /api/import/csv/recategorize — re-run Phase B categorization on existing transactions
// Useful after user sets up rules or makes several corrections
router.post('/csv/recategorize', async (req, res) => {
  try {
    const { limit = 100 } = req.body

    // Get recent uncategorized or 'Other' transactions
    const { rows: txs } = await pool.query(
      `SELECT id, name, amount FROM transactions
       WHERE user_id = $1
         AND (category = 'Other' OR category = 'Uncategorized')
         AND source = 'csv'
       ORDER BY date DESC
       LIMIT $2`,
      [req.user.id, limit]
    )

    let updated = 0
    for (const tx of txs) {
      const { category } = await categorizeTransaction(tx.name, Number(tx.amount), req.user.id)
        .catch(() => ({ category: null }))
      if (category && category !== 'Other') {
        await pool.query(
          'UPDATE transactions SET category = $1 WHERE id = $2 AND user_id = $3',
          [category, tx.id, req.user.id]
        )
        updated++
      }
    }

    res.json({ success: true, updated, total: txs.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null
  // Try YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  // Try MM/DD/YYYY
  const mmddyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mmddyyyy) {
    const [, m, d, y] = mmddyyyy
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  // Try MM-DD-YYYY
  const mmddyyyy2 = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (mmddyyyy2) {
    const [, m, d, y] = mmddyyyy2
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return null
}

module.exports = router
