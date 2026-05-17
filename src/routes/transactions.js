const express = require('express')
const router = express.Router()
const pool = require('../db/pool')

// GET /api/transactions — recent transactions grouped by date
router.get('/', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    const category = req.query.category // optional filter

    let query = `
      SELECT t.*, a.name AS account_name
      FROM transactions t
      JOIN accounts a ON t.account_id = a.id
    `
    const params = []

    if (category && category !== 'All') {
      params.push(category)
      query += ` WHERE t.category = $${params.length}`
    }

    query += ` ORDER BY t.date DESC, t.id DESC LIMIT $${params.push(limit)}`

    const { rows: transactions } = await pool.query(query, params)

    // Group by date for the UI
    const grouped = transactions.reduce((acc, tx) => {
      const date = new Date(tx.date).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      })
      if (!acc[date]) acc[date] = []
      acc[date].push(tx)
      return acc
    }, {})

    // Monthly totals
    const { rows: totals } = await pool.query(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS spending,
        COUNT(*) AS count
      FROM transactions
      WHERE date >= date_trunc('month', CURRENT_DATE)
    `)

    res.json({ grouped, totals: totals[0] })
  } catch (err) {
    next(err)
  }
})

// POST /api/transactions — add a transaction
router.post('/', async (req, res, next) => {
  try {
    const { account_id, name, amount, category, icon, date } = req.body

    if (!account_id || !name || amount === undefined || !category) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { rows } = await pool.query(
      `INSERT INTO transactions (account_id, name, amount, category, icon, date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [account_id, name, amount, category, icon || null, date || new Date()]
    )

    // Update account balance
    await pool.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
      [amount, account_id]
    )

    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

module.exports = router
