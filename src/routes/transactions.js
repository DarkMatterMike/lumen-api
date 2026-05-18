const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/transactions
router.get('/', async (req, res, next) => {
  try {
    const limit    = parseInt(req.query.limit) || 50
    const category = req.query.category

    let query  = 'SELECT * FROM transactions WHERE user_id = $1'
    const params = [req.user.id]

    if (category && category !== 'All') {
      params.push(category)
      query += ` AND category = $${params.length}`
    }

    query += ` ORDER BY date DESC, id DESC LIMIT $${params.push(limit)}`

    const { rows: transactions } = await pool.query(query, params)

    // Group by date
    const grouped = transactions.reduce((acc, tx) => {
      const date = new Date(tx.date).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      })
      if (!acc[date]) acc[date] = []
      acc[date].push(tx)
      return acc
    }, {})

    // Monthly totals
    const { rows: totals } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS spending,
         COUNT(*) AS count
       FROM transactions
       WHERE user_id = $1 AND date >= date_trunc('month', CURRENT_DATE)`,
      [req.user.id]
    )

    res.json({ grouped, totals: totals[0] })
  } catch (err) {
    next(err)
  }
})

// POST /api/transactions
router.post('/', async (req, res, next) => {
  try {
    const { account_id, name, amount, category, icon, date } = req.body
    if (!account_id || !name || amount === undefined || !category) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { rows } = await pool.query(
      `INSERT INTO transactions (user_id, account_id, name, amount, category, icon, date)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.id, account_id, name, amount, category, icon || null, date || new Date()]
    )

    await pool.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3',
      [amount, account_id, req.user.id]
    )

    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

module.exports = router
