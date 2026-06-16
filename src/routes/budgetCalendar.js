/**
 * GET  /api/budget-calendar              — fetch state
 * POST /api/budget-calendar              — save state { checked, dates, notes, planVersion }
 * POST /api/budget-calendar/reset-plan   — wipe state (called when plan version changes)
 * DEL  /api/budget-calendar              — reset all
 */

const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// Bump this whenever the HTML plan file changes.
// The client sends its planVersion on every save; if it doesn't match,
// the server rejects the save and tells the client to reload fresh.
const CURRENT_PLAN_VERSION = 'v5-july15-house-sale-topups'

router.use(requireAuth)

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS budget_calendar_state (
      user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      checked      JSONB        NOT NULL DEFAULT '{}',
      dates        JSONB        NOT NULL DEFAULT '{}',
      notes        JSONB        NOT NULL DEFAULT '{}',
      tx           JSONB        NOT NULL DEFAULT '{}',
      plan_version TEXT         NOT NULL DEFAULT '',
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // Add plan_version column if upgrading from older schema
  await pool.query(`
    ALTER TABLE budget_calendar_state
    ADD COLUMN IF NOT EXISTS plan_version TEXT NOT NULL DEFAULT ''
  `).catch(() => {})
  await pool.query(`
    ALTER TABLE budget_calendar_state
    ADD COLUMN IF NOT EXISTS tx JSONB NOT NULL DEFAULT '{}'
  `).catch(() => {})
}
ensureTable().catch(e => console.warn('[BudgetCalendar] table init:', e.message))

// GET — fetch state; if plan version is stale return empty state so
// client loads the new HTML base plan instead of stale saved state
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT checked, dates, notes, tx, plan_version FROM budget_calendar_state WHERE user_id = $1',
      [req.user.id]
    )
    const row = rows[0]

    // No saved state yet — fresh start
    if (!row) {
      return res.json({ checked: {}, dates: {}, notes: {}, tx: {}, planVersion: CURRENT_PLAN_VERSION, fresh: true })
    }

    // Version mismatch — migrate old checked/notes/dates into tx, keep data intact
    if (row.plan_version !== CURRENT_PLAN_VERSION) {
      // Build tx from old checked/notes/dates so nothing is lost
      const migratedTx = { ...(row.tx || {}) }
      for (const [id, isDone] of Object.entries(row.checked || {})) {
        if (isDone) migratedTx[id] = { ...(migratedTx[id] || {}), done: true }
      }
      for (const [id, note] of Object.entries(row.notes || {})) {
        if (note) migratedTx[id] = { ...(migratedTx[id] || {}), note }
      }
      for (const [id, date] of Object.entries(row.dates || {})) {
        if (date) migratedTx[id] = { ...(migratedTx[id] || {}), date }
      }
      // Save migrated state with new plan version
      await pool.query(
        `UPDATE budget_calendar_state
         SET checked='{}', dates='{}', notes='{}', tx=$1, plan_version=$2, updated_at=NOW()
         WHERE user_id=$3`,
        [JSON.stringify(migratedTx), CURRENT_PLAN_VERSION, req.user.id]
      )
      return res.json({ checked: {}, dates: {}, notes: {}, tx: migratedTx, planVersion: CURRENT_PLAN_VERSION, migrated: true })
    }

    res.json({
      checked:     row.checked,
      dates:       row.dates,
      notes:       row.notes,
      tx:          row.tx || {},
      planVersion: row.plan_version,
    })
  } catch (err) { next(err) }
})

// POST — upsert state
router.post('/', async (req, res, next) => {
  try {
    const { checked = {}, dates = {}, notes = {}, tx = {}, planVersion } = req.body
    // Only save if client is on the current plan version
    const version = planVersion === CURRENT_PLAN_VERSION ? planVersion : CURRENT_PLAN_VERSION
    await pool.query(`
      INSERT INTO budget_calendar_state (user_id, checked, dates, notes, tx, plan_version, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET checked=$2, dates=$3, notes=$4, tx=$5, plan_version=$6, updated_at=NOW()
    `, [req.user.id, JSON.stringify(checked), JSON.stringify(dates), JSON.stringify(notes), JSON.stringify(tx), version])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// POST /reset-plan — explicit wipe (manual override from admin)
router.post('/reset-plan', async (req, res, next) => {
  try {
    await pool.query(`
      INSERT INTO budget_calendar_state (user_id, checked, dates, notes, plan_version, updated_at)
      VALUES ($1, '{}', '{}', '{}', $2, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET checked='{}', dates='{}', notes='{}', plan_version=$2, updated_at=NOW()
    `, [req.user.id, CURRENT_PLAN_VERSION])
    res.json({ ok: true, planVersion: CURRENT_PLAN_VERSION })
  } catch (err) { next(err) }
})

// DELETE — reset all
router.delete('/', async (req, res, next) => {
  try {
    await pool.query(`
      INSERT INTO budget_calendar_state (user_id, checked, dates, notes, plan_version, updated_at)
      VALUES ($1, '{}', '{}', '{}', $2, NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET checked='{}', dates='{}', notes='{}', plan_version=$2, updated_at=NOW()
    `, [req.user.id, CURRENT_PLAN_VERSION])
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
