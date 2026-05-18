const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/accounts
router.get('/', async (req, res, next) => {
  try {
    const { rows: accounts } = await pool.query(
      'SELECT * FROM accounts WHERE user_id = $1 ORDER BY is_debt ASC, name ASC',
      [req.user.id]
    )

    const netWorth = accounts.reduce((sum, a) => {
      return a.is_debt ? sum - Number(a.balance) : sum + Number(a.balance)
    }, 0)

    const { rows: syncInfo } = await pool.query(
      'SELECT MAX(last_synced) AS last_synced FROM plaid_items WHERE user_id = $1',
      [req.user.id]
    )

    res.json({ accounts, netWorth, lastSynced: syncInfo[0]?.last_synced || null })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/accounts/:id — update include_in_balance (and other fields as needed)
router.patch('/:id', async (req, res, next) => {
  try {
    const { include_in_balance } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (include_in_balance !== undefined) {
      updates.push(`include_in_balance=$${idx++}`)
      values.push(include_in_balance)
    }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE accounts SET ${updates.join(', ')} WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Account not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// GET /api/accounts/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: accounts } = await pool.query(
      'SELECT * FROM accounts WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    )
    if (!accounts.length) return res.status(404).json({ error: 'Account not found' })

    const { rows: transactions } = await pool.query(
      'SELECT * FROM transactions WHERE account_id = $1 AND user_id = $2 ORDER BY date DESC LIMIT 10',
      [req.params.id, req.user.id]
    )

    res.json({ account: accounts[0], transactions })
  } catch (err) {
    next(err)
  }
})

module.exports = router
