const express = require('express')
const router = express.Router()
const pool = require('../db/pool')

// GET /api/calendar — recurring items + upcoming events for this month
router.get('/', async (req, res, next) => {
  try {
    const { rows: recurring } = await pool.query(
      'SELECT * FROM recurring WHERE active = TRUE ORDER BY day_of_month ASC'
    )

    const today = new Date()
    const todayDay = today.getDate()

    // Build upcoming events for the rest of this month
    const upcoming = recurring
      .filter(r => r.day_of_month >= todayDay)
      .map(r => {
        const eventDate = new Date(today.getFullYear(), today.getMonth(), r.day_of_month)
        const daysUntil = Math.ceil((eventDate - today) / (1000 * 60 * 60 * 24))
        return {
          ...r,
          date: eventDate.toISOString().split('T')[0],
          daysUntil: Math.max(0, daysUntil),
        }
      })

    // Total committed bills remaining this month (expenses only)
    const remainingBills = upcoming
      .filter(r => r.type !== 'income')
      .reduce((sum, r) => sum + Number(r.amount), 0)

    // Next paycheck
    const nextPaycheck = upcoming.find(r => r.type === 'income')

    res.json({ recurring, upcoming, remainingBills, nextPaycheck })
  } catch (err) {
    next(err)
  }
})

module.exports = router
