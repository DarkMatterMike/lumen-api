/**
 * POST /api/import/csv
 * Accepts a JSON array of parsed CSV rows, validates them, and inserts as transactions.
 * CSV parsing is done client-side (Papa.parse) and sent as JSON to avoid server-side deps.
 *
 * Expected row shape (all strings, we coerce):
 * {
 *   date:     'YYYY-MM-DD' or 'MM/DD/YYYY',
 *   name:     string (merchant/description),
 *   amount:   string (e.g. '-42.50' or '42.50'),
 *   category: string (optional — falls back to AI categorization),
 *   account:  string (account name or id, optional),
 *   note:     string (optional),
 * }
 */
const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic   = require('@anthropic-ai/sdk')

router.use(requireAuth)

// POST /api/import/csv — bulk import parsed CSV rows
router.post('/csv', async (req, res) => {
  const { rows, account_id } = req.body
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows array is required' })
  }

  const results = { imported: 0, skipped: 0, errors: [] }
  const inserted = []

  // Fetch user's accounts for name-to-id matching
  const { rows: accounts } = await pool.query(
    `SELECT id, name FROM accounts WHERE user_id = $1`,
    [req.user.id]
  )

  // Fetch category corrections for AI context
  const { rows: corrections } = await pool.query(
    `SELECT DISTINCT merchant_name, corrected_category FROM category_corrections
     WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 200`,
    [req.user.id]
  )
  const correctionMap = {}
  for (const c of corrections) correctionMap[c.merchant_name] = c.corrected_category

  for (const row of rows) {
    try {
      // Parse date
      let date = parseDate(row.date)
      if (!date) { results.skipped++; results.errors.push(`Row "${row.name}": invalid date "${row.date}"`); continue }

      // Parse amount
      const rawAmt = String(row.amount || '').replace(/[$,\s]/g, '')
      const amount = parseFloat(rawAmt)
      if (isNaN(amount)) { results.skipped++; results.errors.push(`Row "${row.name}": invalid amount "${row.amount}"`); continue }

      // Resolve account
      let resolvedAccountId = account_id || null
      if (!resolvedAccountId && row.account) {
        const match = accounts.find(a =>
          a.name.toLowerCase().includes(row.account.toLowerCase()) ||
          String(a.id) === String(row.account)
        )
        if (match) resolvedAccountId = match.id
      }

      // Determine category
      let category = row.category || null
      if (!category) {
        // Check correction map first
        const normalized = (row.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
        category = correctionMap[normalized] || null
      }
      if (!category) {
        category = await aiCategorize(row.name, amount, req.user.id)
      }

      const { rows: tx } = await pool.query(
        `INSERT INTO transactions (user_id, account_id, name, amount, category, date, note, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'csv')
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [req.user.id, resolvedAccountId, row.name, amount, category, date, row.note || null]
      )

      if (tx.length) {
        inserted.push(tx[0])
        results.imported++
      } else {
        results.skipped++ // duplicate
      }
    } catch (err) {
      results.skipped++
      results.errors.push(`Row "${row.name}": ${err.message}`)
    }
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
    date:    parseDate(row.date) || row.date,
    name:    row.name,
    amount:  parseFloat(String(row.amount || '').replace(/[$,\s]/g, '')),
    category: row.category || 'Uncategorized',
    note:    row.note || null,
    valid:   !!(parseDate(row.date) && !isNaN(parseFloat(String(row.amount || '').replace(/[$,\s]/g, ''))))
  }))

  res.json({ preview, total: rows.length })
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

const CATEGORY_LIST = ['Housing','Groceries','Dining','Transport','Subscriptions','Shopping','Utilities','Healthcare','Entertainment','Income','Transfer','Other']

async function aiCategorize(name, amount, userId) {
  try {
    const apiKey = await getUserApiKey(userId)
    if (!apiKey) return amount < 0 ? 'Other' : 'Income'

    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Categorize this transaction into exactly one category from: ${CATEGORY_LIST.join(', ')}.\nTransaction: "${name}" amount: ${amount}\nRespond with only the category name, nothing else.`
      }]
    })
    const cat = msg.content[0]?.text?.trim()
    return CATEGORY_LIST.includes(cat) ? cat : (amount < 0 ? 'Other' : 'Income')
  } catch {
    return amount < 0 ? 'Other' : 'Income'
  }
}

async function getUserApiKey(userId) {
  try {
    const { rows } = await pool.query(
      `SELECT anthropic_key FROM users WHERE id = $1`,
      [userId]
    )
    return rows[0]?.anthropic_key || process.env.ANTHROPIC_API_KEY || null
  } catch {
    return process.env.ANTHROPIC_API_KEY || null
  }
}

module.exports = router
