const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { getOccurrencesForMonth } = require('../db/recurringUtils')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid   = req.user.id
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayDay = today.getDate()
    const year     = today.getFullYear()
    const month    = today.getMonth()

    const { rows: recurring } = await pool.query(
      'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE ORDER BY day_of_month ASC',
      [uid]
    )

    // For the calendar grid — expand biweekly items into multiple day slots
    // Returns a flat list with a day_of_month for each occurrence this month
    const expanded = []
    for (const r of recurring) {
      const dates = getOccurrencesForMonth(r, year, month)
      for (const d of dates) {
        expanded.push({ ...r, day_of_month: d.getDate(), occurrence_date: d.toISOString().split('T')[0] })
      }
    }

    // Upcoming = occurrences on or after today
    const upcoming = expanded
      .filter(r => r.day_of_month >= todayDay)
      .sort((a, b) => a.day_of_month - b.day_of_month)
      .map(r => {
        const d = new Date(year, month, r.day_of_month)
        return {
          ...r,
          date: d.toISOString().split('T')[0],
          daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)),
        }
      })

    const remainingBills = upcoming
      .filter(r => r.type !== 'income')
      .reduce((s, r) => s + Number(r.amount), 0)

    res.json({ recurring, expanded, upcoming, remainingBills, nextPaycheck: upcoming.find(r => r.type === 'income') || null })
  } catch (err) {
    next(err)
  }
})

module.exports = router

// POST /api/calendar — add a recurring item
router.post('/', async (req, res, next) => {
  try {
    const { name, amount, day_of_month, type, icon, frequency, start_date } = req.body
    if (!name || !amount || !type) {
      return res.status(400).json({ error: 'name, amount, and type are required' })
    }

    const freq       = frequency || 'monthly'
    const startDate  = start_date || null
    const dayOfMonth = freq === 'biweekly' ? (startDate ? new Date(startDate).getDate() : 1) : Number(day_of_month)

    if (freq === 'monthly' && (!day_of_month || day_of_month < 1 || day_of_month > 31)) {
      return res.status(400).json({ error: 'day_of_month must be between 1 and 31' })
    }
    if (freq === 'biweekly' && !startDate) {
      return res.status(400).json({ error: 'start_date is required for biweekly frequency' })
    }

    const { rows } = await pool.query(
      `INSERT INTO recurring (user_id, name, amount, day_of_month, type, icon, active, frequency, start_date)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$8) RETURNING *`,
      [req.user.id, name, amount, dayOfMonth, type, icon || null, freq, startDate]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/calendar/:id — edit a recurring item
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, amount, day_of_month, type, icon, active, frequency, start_date } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (name         !== undefined) { updates.push(`name=$${idx++}`);         values.push(name) }
    if (amount       !== undefined) { updates.push(`amount=$${idx++}`);       values.push(amount) }
    if (day_of_month !== undefined) { updates.push(`day_of_month=$${idx++}`); values.push(day_of_month) }
    if (type         !== undefined) { updates.push(`type=$${idx++}`);         values.push(type) }
    if (icon         !== undefined) { updates.push(`icon=$${idx++}`);         values.push(icon) }
    if (active       !== undefined) { updates.push(`active=$${idx++}`);       values.push(active) }
    if (frequency    !== undefined) { updates.push(`frequency=$${idx++}`);    values.push(frequency) }
    if (start_date   !== undefined) { updates.push(`start_date=$${idx++}`);   values.push(start_date) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE recurring SET ${updates.join(', ')} WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Item not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/calendar/:id — remove a recurring item
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM recurring WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid   = req.user.id
    const today = new Date()
    const todayDay = today.getDate()

    const { rows: recurring } = await pool.query(
      'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE ORDER BY day_of_month ASC',
      [uid]
    )

    const upcoming = recurring
      .filter(r => r.day_of_month >= todayDay)
      .map(r => {
        const d = new Date(today.getFullYear(), today.getMonth(), r.day_of_month)
        return {
          ...r,
          date: d.toISOString().split('T')[0],
          daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)),
        }
      })

    const remainingBills = upcoming
      .filter(r => r.type !== 'income')
      .reduce((s, r) => s + Number(r.amount), 0)

    res.json({ recurring, upcoming, remainingBills, nextPaycheck: upcoming.find(r => r.type === 'income') || null })
  } catch (err) {
    next(err)
  }
})

module.exports = router

// POST /api/calendar — add a recurring item
router.post('/', async (req, res, next) => {
  try {
    const { name, amount, day_of_month, type, icon } = req.body
    if (!name || !amount || !day_of_month || !type) {
      return res.status(400).json({ error: 'name, amount, day_of_month, and type are required' })
    }
    if (day_of_month < 1 || day_of_month > 31) {
      return res.status(400).json({ error: 'day_of_month must be between 1 and 31' })
    }

    const { rows } = await pool.query(
      `INSERT INTO recurring (user_id, name, amount, day_of_month, type, icon, active)
       VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
      [req.user.id, name, amount, day_of_month, type, icon || null]
    )
    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/calendar/:id — remove a recurring item
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM recurring WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/calendar/:id — edit a recurring item
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, amount, day_of_month, type, icon, active } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (name         !== undefined) { updates.push(`name=$${idx++}`);         values.push(name) }
    if (amount       !== undefined) { updates.push(`amount=$${idx++}`);       values.push(amount) }
    if (day_of_month !== undefined) { updates.push(`day_of_month=$${idx++}`); values.push(day_of_month) }
    if (type         !== undefined) { updates.push(`type=$${idx++}`);         values.push(type) }
    if (icon         !== undefined) { updates.push(`icon=$${idx++}`);         values.push(icon) }
    if (active       !== undefined) { updates.push(`active=$${idx++}`);       values.push(active) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE recurring SET ${updates.join(', ')} WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Item not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})
