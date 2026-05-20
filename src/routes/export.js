/**
 * Export Route
 *
 * GET /api/export/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&format=csv|json
 * GET /api/export/accounts?format=csv|json
 * GET /api/export/full?format=json   — everything: transactions + accounts + budgets + recurring
 */
const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/export/transactions
router.get('/transactions', async (req, res, next) => {
  try {
    const { from, to, format = 'csv' } = req.query
    const today = new Date().toISOString().split('T')[0]

    const dateFrom = from || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
    const dateTo   = to   || today

    const { rows } = await pool.query(
      `SELECT
         t.date,
         COALESCE(t.cleaned_name, t.name) AS merchant,
         t.name                            AS raw_name,
         t.amount,
         t.category,
         COALESCE(t.tx_type,'expense')    AS type,
         t.note,
         a.name                            AS account,
         t.status,
         t.source
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id=$1 AND t.date BETWEEN $2 AND $3
       ORDER BY t.date DESC`,
      [req.user.id, dateFrom, dateTo]
    )

    // Log export
    await pool.query(
      `INSERT INTO export_log (user_id, type, date_from, date_to, row_count)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, format, dateFrom, dateTo, rows.length]
    ).catch(() => {})

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="lumen-transactions-${dateFrom}-${dateTo}.json"`)
      res.setHeader('Content-Type', 'application/json')
      return res.json({ transactions: rows, exported_at: new Date().toISOString(), count: rows.length })
    }

    // CSV
    const headers = ['Date','Merchant','Amount','Category','Type','Note','Account','Status']
    const csvRows = rows.map(r => [
      r.date,
      csvEscape(r.merchant),
      r.amount,
      csvEscape(r.category || ''),
      r.type,
      csvEscape(r.note || ''),
      csvEscape(r.account || ''),
      r.status || 'posted',
    ].join(','))

    const csv = [headers.join(','), ...csvRows].join('\n')
    res.setHeader('Content-Disposition', `attachment; filename="lumen-transactions-${dateFrom}-${dateTo}.csv"`)
    res.setHeader('Content-Type', 'text/csv')
    res.send(csv)
  } catch (err) { next(err) }
})

// GET /api/export/accounts
router.get('/accounts', async (req, res, next) => {
  try {
    const { format = 'csv' } = req.query
    const { rows } = await pool.query(
      `SELECT name, type, institution, balance, mask, is_debt, interest_rate, limit_amt
       FROM accounts WHERE user_id=$1 ORDER BY is_debt ASC, name ASC`,
      [req.user.id]
    )

    if (format === 'json') {
      res.setHeader('Content-Disposition', 'attachment; filename="lumen-accounts.json"')
      res.setHeader('Content-Type', 'application/json')
      return res.json({ accounts: rows, exported_at: new Date().toISOString() })
    }

    const headers = ['Account','Type','Institution','Balance','Mask','Is Debt','Interest Rate','Limit']
    const csvRows = rows.map(r => [
      csvEscape(r.name), r.type, csvEscape(r.institution || ''),
      r.balance, r.mask || '', r.is_debt ? 'Yes' : 'No',
      r.interest_rate || '', r.limit_amt || '',
    ].join(','))

    res.setHeader('Content-Disposition', 'attachment; filename="lumen-accounts.csv"')
    res.setHeader('Content-Type', 'text/csv')
    res.send([headers.join(','), ...csvRows].join('\n'))
  } catch (err) { next(err) }
})

// GET /api/export/full — full JSON export of all user data
router.get('/full', async (req, res, next) => {
  try {
    const uid = req.user.id
    const [txRes, acctRes, budgetRes, recurRes, goalRes] = await Promise.all([
      pool.query(`SELECT t.*, COALESCE(t.cleaned_name,t.name) AS merchant, a.name AS account_name FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id WHERE t.user_id=$1 ORDER BY t.date DESC`, [uid]),
      pool.query(`SELECT name,type,institution,balance,mask,is_debt,interest_rate,limit_amt FROM accounts WHERE user_id=$1`, [uid]),
      pool.query(`SELECT name,icon,cap,period,color FROM budgets WHERE user_id=$1`, [uid]),
      pool.query(`SELECT name,amount,day_of_month,type,icon,active FROM recurring WHERE user_id=$1`, [uid]),
      pool.query(`SELECT name,type,target_amount,current_amount,monthly_contribution,target_date FROM goals WHERE user_id=$1 AND active=TRUE`, [uid]),
    ])

    res.setHeader('Content-Disposition', 'attachment; filename="lumen-full-export.json"')
    res.setHeader('Content-Type', 'application/json')
    res.json({
      exported_at:  new Date().toISOString(),
      transactions: txRes.rows,
      accounts:     acctRes.rows,
      budgets:      budgetRes.rows,
      recurring:    recurRes.rows,
      goals:        goalRes.rows,
    })
  } catch (err) { next(err) }
})

function csvEscape(str) {
  if (!str) return ''
  const s = String(str)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

module.exports = router
