const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const { predictEndOfMonth, checkPaceAlerts, autoCompleteCategories } = require('../utils/budgetIntelligence')

router.use(requireAuth)

// GET /api/budgets
router.get('/', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: budgets } = await pool.query(
      'SELECT * FROM budgets WHERE user_id=$1 ORDER BY cap DESC',
      [uid]
    )

    const budgetsWithSpend = await Promise.all(
      budgets.map(async (budget) => {
        const { rows } = await pool.query(
          `SELECT COALESCE(SUM(ABS(amount)),0) AS spent
           FROM transactions
           WHERE user_id=$1 AND category ILIKE $2 AND amount<0 AND COALESCE(tx_type,'expense') != 'transfer'
             AND date>=date_trunc('month',CURRENT_DATE)`,
          [uid, budget.name]
        )
        return {
          ...budget,
          spent: Number(rows[0].spent),
          pct: Math.round((Number(rows[0].spent) / Number(budget.cap)) * 100),
        }
      })
    )

    const totalBudgeted = budgets.reduce((s, b) => s + Number(b.cap), 0)
    const totalSpent    = budgetsWithSpend.reduce((s, b) => s + b.spent, 0)

    res.json({ budgets: budgetsWithSpend, totalBudgeted, totalSpent })
  } catch (err) {
    next(err)
  }
})

// POST /api/budgets — create a new budget category
router.post('/', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { name, cap, icon, color, period } = req.body

    if (!name || !cap) {
      return res.status(400).json({ error: 'Name and cap are required' })
    }

    const { rows } = await pool.query(
      `INSERT INTO budgets (user_id, name, cap, icon, color, period)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [uid, name, cap, icon || '📦', color || 'safe', period || 'monthly']
    )

    res.status(201).json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/budgets/:id — update cap, name, icon, or color
router.patch('/:id', async (req, res, next) => {
  try {
    const { name, cap, icon, color } = req.body
    const updates = []
    const values  = []
    let idx = 1

    if (name  !== undefined) { updates.push(`name=$${idx++}`);  values.push(name) }
    if (cap   !== undefined) { updates.push(`cap=$${idx++}`);   values.push(Number(cap)) }
    if (icon  !== undefined) { updates.push(`icon=$${idx++}`);  values.push(icon) }
    if (color !== undefined) { updates.push(`color=$${idx++}`); values.push(color) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.params.id)
    values.push(req.user.id)

    const { rows } = await pool.query(
      `UPDATE budgets SET ${updates.join(', ')}
       WHERE id=$${idx} AND user_id=$${idx + 1} RETURNING *`,
      values
    )
    if (!rows.length) return res.status(404).json({ error: 'Budget not found' })
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// DELETE /api/budgets/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM budgets WHERE id=$1 AND user_id=$2',
      [req.params.id, req.user.id]
    )
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})


// ── POST /api/budgets/auto-optimize ─────────────────────────────────────────
// Analyzes the last 3 months of spend per budget and calls Claude to suggest
// new monthly caps. Returns suggestions the frontend previews before applying.

const Anthropic = require('@anthropic-ai/sdk')
const _anthropic = new Anthropic()

router.post('/auto-optimize', async (req, res, next) => {
  try {
    const uid = req.user.id

    // 1. Fetch all budgets
    const { rows: budgets } = await pool.query(
      'SELECT id, name, cap, icon, completed FROM budgets WHERE user_id = $1',
      [uid]
    )
    if (!budgets.length) {
      return res.json({ suggestions: [], summary: 'No budgets found to optimize.' })
    }

    // 2. Build 3-month spend history per budget
    const historyByBudget = await Promise.all(
      budgets.map(async (b) => {
        const { rows } = await pool.query(
          `SELECT
             to_char(date_trunc('month', date), 'Mon YYYY') AS month,
             date_trunc('month', date) AS month_start,
             ROUND(ABS(SUM(amount))::numeric, 2) AS spent
           FROM transactions
           WHERE user_id = $1
             AND category ILIKE $2
             AND amount < 0
             AND COALESCE(tx_type, 'expense') != 'transfer'
             AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'
             AND date <  date_trunc('month', CURRENT_DATE)
           GROUP BY date_trunc('month', date)
           ORDER BY month_start ASC`,
          [uid, b.name]
        )
        // Fill missing months with 0
        const months = []
        for (let i = 3; i >= 1; i--) {
          const d = new Date()
          d.setDate(1)
          d.setMonth(d.getMonth() - i)
          const label = d.toLocaleString('en-US', { month: 'short', year: 'numeric' })
          const found = rows.find(r => r.month === label)
          months.push({ month: label, spent: found ? Number(found.spent) : 0 })
        }
        const avg = months.reduce((s, m) => s + m.spent, 0) / 3
        return {
          id:                b.id,
          name:              b.name,
          icon:              b.icon,
          current_cap:       Number(b.cap),
          completed:         b.completed,
          months,
          avg_monthly_spend: Math.round(avg * 100) / 100,
        }
      })
    )

    // 3. Call Claude
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const prompt = `You are a personal finance advisor analyzing a user's budget history.
Today is ${today}.

Here is their budget data with 3 months of actual spend history:
${JSON.stringify(historyByBudget, null, 2)}

Your task:
1. For each budget, analyze the 3-month spending trend.
2. Suggest a new monthly cap that is realistic but slightly disciplined.
3. If spend is volatile, buffer a bit. If spend is consistently under cap, trim the cap.
4. If avg_monthly_spend is 0 for all 3 months, the budget is unused — flag it.
5. Round suggested caps to the nearest $5.
6. Skip completed budgets.

Respond ONLY with a valid JSON object (no markdown, no backticks, no preamble):
{
  "suggestions": [
    {
      "id": "<budget id>",
      "name": "<budget name>",
      "current_cap": <number>,
      "suggested_cap": <number>,
      "change": <suggested_cap minus current_cap>,
      "reasoning": "<1-2 sentence explanation>",
      "flag": null
    }
  ],
  "summary": "<2-3 sentence overall narrative>"
}

Only include budgets where you have a meaningful suggestion (skip ones already optimal within $5).
For unused budgets (all zeros), set flag to "unused" and keep current_cap as suggested_cap.`

    const message = await _anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw = message.content[0]?.text || '{}'
    let parsed
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())
    } catch {
      return res.status(500).json({ error: 'Claude returned unparseable JSON.', raw_text: raw })
    }

    // Merge history months back into suggestions for frontend display
    const suggestions = (parsed.suggestions || []).map(s => {
      const hist = historyByBudget.find(b => String(b.id) === String(s.id))
      return { ...s, months: hist?.months || [], avg_monthly_spend: hist?.avg_monthly_spend || 0 }
    })

    res.json({ suggestions, summary: parsed.summary || '' })
  } catch (err) {
    next(err)
  }
})

module.exports = router
