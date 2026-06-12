/**
 * POST /api/budgets/auto-optimize
 *
 * Analyzes the last 3 months of spend per budget category and uses
 * Claude to recommend new monthly caps.  Returns a list of suggested
 * updates the frontend can preview before applying.
 *
 * Response shape:
 * {
 *   suggestions: [
 *     {
 *       id:           <budget id>,
 *       name:         "Groceries",
 *       current_cap:  400,
 *       suggested_cap: 375,
 *       reasoning:    "Average 3-month spend is $348. Suggesting $375 leaves…",
 *       months:       [{ month: "Apr", spent: 320 }, ...]
 *     },
 *     ...
 *   ],
 *   summary: "…overall narrative from Claude…"
 * }
 *
 * The caller (PUT /api/budgets/auto-optimize/apply) can then loop over
 * accepted suggestions and PATCH each budget.  That's handled on the
 * frontend with existing api.updateBudget calls so we don't need a
 * separate apply endpoint.
 */

const express   = require('express')
const router    = express.Router()
const pool      = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic = require('@anthropic-ai/sdk')

const client = new Anthropic()

router.use(requireAuth)

router.post('/auto-optimize', async (req, res, next) => {
  try {
    const uid = req.user.id

    // ── 1. Fetch all budgets ───────────────────────────────────
    const { rows: budgets } = await pool.query(
      'SELECT id, name, cap, icon, completed FROM budgets WHERE user_id = $1',
      [uid]
    )

    if (!budgets.length) {
      return res.json({ suggestions: [], summary: 'No budgets found to optimize.' })
    }

    // ── 2. Build 3-month spend history per budget ─────────────
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
          id:          b.id,
          name:        b.name,
          icon:        b.icon,
          current_cap: Number(b.cap),
          completed:   b.completed,
          months,
          avg_monthly_spend: Math.round(avg * 100) / 100,
        }
      })
    )

    // ── 3. Build Claude prompt ────────────────────────────────
    const budgetData = JSON.stringify(historyByBudget, null, 2)
    const today      = new Date().toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    })

    const prompt = `You are a personal finance advisor analyzing a user's budget history.
Today is ${today}.

Here is their budget data with 3 months of actual spend history:
${budgetData}

Your task:
1. For each budget, analyze the 3-month spending trend.
2. Suggest a new monthly cap that is realistic but slightly disciplined — not just rubber-stamping whatever they spend.
3. Consider: if spend is volatile, buffer a bit. If spend is consistently under cap, trim the cap.
4. If avg_monthly_spend is 0 for all 3 months, the budget is unused — suggest keeping or flagging it.
5. Round suggested caps to the nearest $5 for clean numbers.
6. Skip completed budgets.

Respond ONLY with a valid JSON object (no markdown, no backticks, no preamble) in this exact shape:
{
  "suggestions": [
    {
      "id": "<budget id>",
      "name": "<budget name>",
      "current_cap": <number>,
      "suggested_cap": <number>,
      "change": <suggested_cap minus current_cap, positive means increase>,
      "reasoning": "<1-2 sentence plain-english explanation>",
      "flag": null
    }
  ],
  "summary": "<2-3 sentence overall narrative about the user's budgeting patterns and what changed>"
}

Only include budgets where you have a meaningful suggestion (skip ones where current_cap is already optimal within $5).
For unused budgets (all zeros), set flag to "unused" and keep current_cap as suggested_cap.`

    // ── 4. Call Claude ────────────────────────────────────────
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw = message.content[0]?.text || '{}'

    let parsed
    try {
      // Strip any accidental markdown fences just in case
      const clean = raw.replace(/```json|```/g, '').trim()
      parsed = JSON.parse(clean)
    } catch {
      return res.status(500).json({
        error:    'Claude returned unparseable JSON.',
        raw_text: raw,
      })
    }

    // Merge history months back into suggestions for frontend display
    const suggestions = (parsed.suggestions || []).map(s => {
      const hist = historyByBudget.find(b => String(b.id) === String(s.id))
      return {
        ...s,
        months:            hist?.months            || [],
        avg_monthly_spend: hist?.avg_monthly_spend || 0,
      }
    })

    res.json({
      suggestions,
      summary: parsed.summary || '',
    })

  } catch (err) {
    next(err)
  }
})

module.exports = router
