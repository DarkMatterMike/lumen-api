/**
 * /api/dani — Dani's spending power & wishlist data
 * Only accessible to users with role='owner'
 */
const express    = require('express')
const router     = express.Router()
const pool       = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// Middleware: owner-only
function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Access denied' })
  }
  next()
}

router.use(requireAuth)
router.use(requireOwner)

// GET /api/dani — get tab state + accounts + recurring items
router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id

    // Get or create dani_data row
    let { rows } = await pool.query(
      `SELECT * FROM dani_data WHERE user_id = $1`, [uid]
    )
    if (!rows.length) {
      const ins = await pool.query(
        `INSERT INTO dani_data (user_id) VALUES ($1) RETURNING *`, [uid]
      )
      rows = ins.rows
    }
    const daniRow = rows[0]

    // Accounts (non-debt, for account selector)
    const { rows: accounts } = await pool.query(
      `SELECT id, name, type, balance, mask, institution, icon, color, is_debt
       FROM accounts WHERE user_id = $1 ORDER BY is_debt ASC, name ASC`,
      [uid]
    )

    // Recurring items
    const { rows: recurringItems } = await pool.query(
      `SELECT id, name, amount, day_of_month AS "recurringDay", type, icon, account_id AS "accountId"
       FROM recurring WHERE user_id = $1 AND active = TRUE`,
      [uid]
    )

    res.json({
      tab1: daniRow.tab1,
      tab2: daniRow.tab2,
      accounts,
      recurringItems,
    })
  } catch (err) { next(err) }
})

// PATCH /api/dani — save tab state
router.patch('/', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { tab1, tab2 } = req.body

    const updates = []
    const vals    = [uid]
    let   idx     = 2

    if (tab1 !== undefined) { updates.push(`tab1 = $${idx++}`); vals.push(JSON.stringify(tab1)) }
    if (tab2 !== undefined) { updates.push(`tab2 = $${idx++}`); vals.push(JSON.stringify(tab2)) }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    updates.push(`updated_at = NOW()`)

    await pool.query(
      `INSERT INTO dani_data (user_id, ${tab1 !== undefined ? 'tab1' : 'tab2'})
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET ${updates.join(', ')}`,
      vals
    )

    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
