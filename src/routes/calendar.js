const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

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
