const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/rules
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM rules WHERE user_id=$1 ORDER BY id ASC',
      [req.user.id]
    )
    res.json({ rules: rows })
  } catch (err) { next(err) }
})

// POST /api/rules
router.post('/', async (req, res, next) => {
  try {
    const { name, operator, match_value, action, action_value } = req.body
    if (!name || !operator || !match_value || !action || !action_value) {
      return res.status(400).json({ error: 'All fields are required' })
    }
    const { rows } = await pool.query(
      `INSERT INTO rules (user_id, name, operator, match_value, action, action_value)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, name, operator, match_value, action, action_value]
    )
    res.status(201).json(rows[0])
  } catch (err) { next(err) }
})

// PATCH /api/rules/:id — update active state or fields
router.patch('/:id', async (req, res, next) => {
  try {
    const { active, name, operator, match_value, action, action_value } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (active       !== undefined) { updates.push(`active=$${idx++}`);       values.push(active) }
    if (name         !== undefined) { updates.push(`name=$${idx++}`);         values.push(name) }
    if (operator     !== undefined) { updates.push(`operator=$${idx++}`);     values.push(operator) }
    if (match_value  !== undefined) { updates.push(`match_value=$${idx++}`);  values.push(match_value) }
    if (action       !== undefined) { updates.push(`action=$${idx++}`);       values.push(action) }
    if (action_value !== undefined) { updates.push(`action_value=$${idx++}`); values.push(action_value) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE rules SET ${updates.join(', ')} WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Rule not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/rules/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM rules WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/rules/apply — manually run all active rules against recent transactions
router.post('/apply', async (req, res, next) => {
  try {
    const count = await applyRulesToUser(req.user.id)
    res.json({ success: true, updated: count })
  } catch (err) { next(err) }
})

// ── Shared engine — also exported for cron job and post-sync hook ──────────
async function applyRulesToUser(userId) {
  const { rows: rules } = await pool.query(
    'SELECT * FROM rules WHERE user_id=$1 AND active=TRUE ORDER BY id ASC',
    [userId]
  )
  if (!rules.length) return 0

  // Apply rules to the last 90 days of transactions
  const { rows: transactions } = await pool.query(
    `SELECT id, name FROM transactions
     WHERE user_id=$1 AND date >= CURRENT_DATE - INTERVAL '90 days'
     ORDER BY id ASC`,
    [userId]
  )

  let updated = 0
  for (const tx of transactions) {
    const setFields = {}

    for (const rule of rules) {
      const txName = (tx.name || '').toLowerCase()
      const val    = (rule.match_value || '').toLowerCase()

      const matched =
        rule.operator === 'equals'      ? txName === val :
        rule.operator === 'starts_with' ? txName.startsWith(val) :
        txName.includes(val) // default: contains

      if (matched) {
        if (rule.action === 'set_category') setFields.category = rule.action_value
        if (rule.action === 'set_type')     setFields.tx_type  = rule.action_value
        if (rule.action === 'set_note')     setFields.note     = rule.action_value
      }
    }

    if (!Object.keys(setFields).length) continue

    const cols   = Object.keys(setFields)
    const clause = cols.map((c, i) => `${c}=$${i + 2}`).join(', ')
    await pool.query(
      `UPDATE transactions SET ${clause} WHERE id=$1 AND user_id=${userId}`,
      [tx.id, ...Object.values(setFields)]
    )
    updated++
  }

  return updated
}

module.exports        = router
module.exports.applyRulesToUser = applyRulesToUser
