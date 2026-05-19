const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const {
  cleanMerchantName,
  categorizeTransaction,
} = require('../utils/transactionIntelligence')

router.use(requireAuth)

// GET /api/transactions
// Always returns the full current month. Historical transactions are paginated at 50/page.
// Query params: page (default 0), category
router.get('/', async (req, res, next) => {
  try {
    const page     = Math.max(0, parseInt(req.query.page) || 0)
    const pageSize = 50
    const category = req.query.category

    // Build optional category clause
    const baseParams = [req.user.id]
    let catClause = ''
    if (category && category !== 'All') {
      baseParams.push(category)
      catClause = ` AND t.category = $${baseParams.length}`
    }

    const baseWhere = `WHERE t.user_id = $1 AND COALESCE(t.tx_type,'expense') != 'transfer'${catClause}`

    // ── 1. Current month — all rows, no limit ──────────────────
    const { rows: currentRows } = await pool.query(
      `SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.institution AS account_institution, a.icon AS account_icon
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       ${baseWhere}
         AND t.date >= date_trunc('month', CURRENT_DATE)
       ORDER BY t.date DESC, t.id DESC`,
      baseParams
    )

    // ── 2. Historical — paginated ──────────────────────────────
    const histOffset = page * pageSize
    const histParams = [...baseParams, pageSize, histOffset]
    const { rows: histRows } = await pool.query(
      `SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.institution AS account_institution, a.icon AS account_icon
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       ${baseWhere}
         AND t.date < date_trunc('month', CURRENT_DATE)
       ORDER BY t.date DESC, t.id DESC
       LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
      histParams
    )

    // ── 3. Historical count for hasMore ────────────────────────
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM transactions t
       ${baseWhere}
         AND t.date < date_trunc('month', CURRENT_DATE)`,
      baseParams
    )
    const totalHistorical = parseInt(countRows[0].count)
    const hasMore = (page + 1) * pageSize < totalHistorical

    // ── 4. Monthly totals (current month, all rows) ────────────
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

    res.json({
      currentMonth: currentRows,
      historical:   histRows,
      totals:       totals[0],
      pagination:   { page, pageSize, total: totalHistorical, hasMore },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/transactions
router.post('/', async (req, res, next) => {
  try {
    const { account_id, name, amount, category, icon, date, tx_type, note } = req.body
    if (!account_id || !name || amount === undefined) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Phase B: clean merchant name + auto-categorize if no category provided
    const { cleanedName, category: merchantCategory, icon: merchantIcon } =
      await cleanMerchantName(name, req.user.id).catch(() => ({ cleanedName: name, category: null, icon: null }))

    let finalCategory = category
    if (!finalCategory) {
      const { category: aiCat } = await categorizeTransaction(name, Number(amount), req.user.id)
        .catch(() => ({ category: merchantCategory || (Number(amount) > 0 ? 'Income' : 'Other') }))
      finalCategory = aiCat || merchantCategory || (Number(amount) > 0 ? 'Income' : 'Other')
    }

    const finalIcon = icon || merchantIcon || null
    const finalCleanedName = (cleanedName && cleanedName !== name) ? cleanedName : null

    const { rows } = await pool.query(
      `INSERT INTO transactions (user_id, account_id, name, cleaned_name, amount, category, icon, date, tx_type, note, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual') RETURNING *`,
      [req.user.id, account_id, name, finalCleanedName, amount, finalCategory, finalIcon,
       date || new Date(), tx_type || (Number(amount) > 0 ? 'income' : 'expense'), note || null]
    )

    await pool.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3',
      [amount, account_id, req.user.id]
    )

    // Re-fetch with account JOIN
    const { rows: full } = await pool.query(
      `SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.institution AS account_institution, a.icon AS account_icon
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1`,
      [rows[0].id]
    )

    res.status(201).json(full[0])
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

    // If category was changed, record it as a correction for AI learning
    if (category !== undefined && req.body._original_category && req.body._original_category !== category) {
      const merchantName = (rows[0].name || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
      pool.query(
        `INSERT INTO category_corrections (user_id, transaction_id, merchant_name, original_category, corrected_category)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.user.id, rows[0].id, merchantName, req.body._original_category, category]
      ).catch(err => console.error('[Corrections] insert error:', err.message))
    }

    // Re-fetch with account JOIN so the frontend gets account_name etc.
    const { rows: full } = await pool.query(
      `SELECT t.*, a.name AS account_name, a.mask AS account_mask, a.institution AS account_institution, a.icon AS account_icon
       FROM transactions t
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1`,
      [rows[0].id]
    )
    res.json(full[0])
  } catch (err) {
    next(err)
  }
})

module.exports = router
