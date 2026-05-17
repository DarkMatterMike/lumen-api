const express = require('express')
const router = express.Router()
const pool = require('../db/pool')

// GET /api/accounts — all accounts with net worth summary
router.get('/', async (req, res, next) => {
  try {
    const { rows: accounts } = await pool.query(`
      SELECT * FROM accounts ORDER BY is_debt ASC, name ASC
    `)

    // Calculate net worth: assets - liabilities
    const netWorth = accounts.reduce((sum, a) => {
      return a.is_debt ? sum - Number(a.balance) : sum + Number(a.balance)
    }, 0)

    res.json({ accounts, netWorth })
  } catch (err) {
    next(err)
  }
})

// GET /api/accounts/:id — single account with recent transactions
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: accounts } = await pool.query(
      'SELECT * FROM accounts WHERE id = $1',
      [req.params.id]
    )
    if (!accounts.length) return res.status(404).json({ error: 'Account not found' })

    const { rows: transactions } = await pool.query(
      'SELECT * FROM transactions WHERE account_id = $1 ORDER BY date DESC LIMIT 10',
      [req.params.id]
    )

    res.json({ account: accounts[0], transactions })
  } catch (err) {
    next(err)
  }
})

module.exports = router
