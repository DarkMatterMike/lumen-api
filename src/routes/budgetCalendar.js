/**
 * GET  /api/budget-calendar        — fetch checked state
 * POST /api/budget-calendar        — save checked state  { checked: {...} }
 * DEL  /api/budget-calendar        — reset all
 */

const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// Ensure table exists (runs once on startup, safe to call repeatedly)
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budget_calendar_state (
      user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      checked   JSONB    NOT NULL DEFAULT '{}',
      dates     JSONB    NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}
ensureTable().catch(e => console.warn('[BudgetCalendar] table init:', e.message))

// GET — fetch state
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT checked, dates FROM budget_calendar_state WHERE user_id = $1',
      [req.user.id]
    )
    const row = rows[0] || { checked: {}, dates: {} }
    res.json({ checked: row.checked, dates: row.dates })
  } catch (err) { next(err) }
})

// POST — upsert state
router.post('/', async (req, res, next) => {
  try {
    const { checked = {}, dates = {} } = req.body
    await pool.query(`
      INSERT INTO budget_calendar_state (user_id, checked, dates, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET checked = $2, dates = $3, updated_at = NOW()
    `, [req.user.id, JSON.stringify(checked), JSON.stringify(dates)])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// DELETE — reset
router.delete('/', async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO budget_calendar_state (user_id, checked, dates, updated_at)
       VALUES ($1, '{}', '{}', NOW())
       ON CONFLICT (user_id) DO UPDATE SET checked = '{}', dates = '{}', updated_at = NOW()`,
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
