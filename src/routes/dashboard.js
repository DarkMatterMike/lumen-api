const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id

    const { rows: checking } = await pool.query(
      "SELECT * FROM accounts WHERE user_id=$1 AND type='checking' LIMIT 1",
      [uid]
    )
    const balance = checking.length ? Number(checking[0].balance) : 0

    const today    = new Date()
    const todayDay = today.getDate()

    const { rows: recurring } = await pool.query(
      "SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE AND type!='income' AND day_of_month>=$2 ORDER BY day_of_month ASC",
      [uid, todayDay]
    )

    const committedBills    = recurring.reduce((s, r) => s + Number(r.amount), 0)
    const balanceAfterBills = balance - committedBills

    const { rows: nextPay } = await pool.query(
      "SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE AND type='income' AND day_of_month>=$2 ORDER BY day_of_month ASC LIMIT 1",
      [uid, todayDay]
    )

    const { rows: monthSpend } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0) AS spent,
         COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS income
       FROM transactions
       WHERE user_id=$1 AND date>=date_trunc('month',CURRENT_DATE)`,
      [uid]
    )

    const pressureScore = balance > 0
      ? Math.min(100, Math.round((committedBills / balance) * 100))
      : 100
    const pressureLabel =
      pressureScore < 25 ? 'SAFE' :
      pressureScore < 50 ? 'WATCH' :
      pressureScore < 75 ? 'TIGHT' : 'CRITICAL'

    const upcomingBills = recurring.slice(0, 5).map(r => {
      const d = new Date(today.getFullYear(), today.getMonth(), r.day_of_month)
      return { ...r, daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)) }
    })

    const nextPayData = nextPay.length ? (() => {
      const d = new Date(today.getFullYear(), today.getMonth(), nextPay[0].day_of_month)
      return { ...nextPay[0], daysUntil: Math.max(0, Math.ceil((d - today) / 86400000)) }
    })() : null

    res.json({
      balance, balanceAfterBills, committedBills,
      pressureScore, pressureLabel,
      monthSpent:  Number(monthSpend[0].spent),
      monthIncome: Number(monthSpend[0].income),
      upcomingBills, nextPaycheck: nextPayData,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
