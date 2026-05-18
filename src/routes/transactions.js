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

    let query  = "SELECT * FROM transactions WHERE user_id = $1 AND COALESCE(tx_type,'expense') != 'transfer'"
    const params = [req.user.id]

    if (category && category !== 'All') {
      params.push(category)
      query += ` AND category = $${params.length}`
    }

    query += ` ORDER BY date DESC, id DESC LIMIT $${params.push(limit)}`

    const { rows: transactions } = await pool.query(query, params)

    const grouped = transactions.reduce((acc, tx) => {
      const date = new Date(tx.date).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      })
      if (!acc[date]) acc[date] = []
      acc[date].push(tx)
      return acc
    }, {})

    // Monthly totals — exclude transfers
    const { rows: totals } = await pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tx_type = 'income'  OR (tx_type IS NULL AND amount > 0) THEN ABS(amount) ELSE 0 END), 0) AS income,
         COALESCE(SUM(CASE WHEN tx_type = 'expense' OR (tx_type IS NULL AND amount < 0) THEN ABS(amount) ELSE 0 END), 0) AS spending,
         COUNT(*) AS count
       FROM transactions
       WHERE user_id = $1
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= date_trunc('month', CURRENT_DATE)`,
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
    const { account_id, name, amount, category, icon, date, tx_type } = req.body
    if (!account_id || !name || amount === undefined || !category) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const { rows } = await pool.query(
      `INSERT INTO transactions (user_id, account_id, name, amount, category, icon, date, tx_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, account_id, name, amount, category, icon || null, date || new Date(), tx_type || 'expense']
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

// PATCH /api/transactions/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, category, amount, date, note, account_id, tx_type } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (name       !== undefined) { updates.push(`name=$${idx++}`);       values.push(name) }
    if (category   !== undefined) { updates.push(`category=$${idx++}`);   values.push(category) }
    if (amount     !== undefined) { updates.push(`amount=$${idx++}`);     values.push(amount) }
    if (date       !== undefined) { updates.push(`date=$${idx++}`);       values.push(date) }
    if (note       !== undefined) { updates.push(`note=$${idx++}`);       values.push(note) }
    if (account_id !== undefined) { updates.push(`account_id=$${idx++}`); values.push(account_id) }
    if (tx_type    !== undefined) { updates.push(`tx_type=$${idx++}`);    values.push(tx_type) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE transactions SET ${updates.join(', ')}
       WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

module.exports = router
