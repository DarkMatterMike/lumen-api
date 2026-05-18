const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic   = require('@anthropic-ai/sdk')

router.use(requireAuth)

// Build a rich financial context string from the user's real data
async function buildFinancialContext(userId) {
  const uid = userId

  // Accounts + net worth
  const { rows: accounts } = await pool.query(
    'SELECT name, type, balance, is_debt, institution, mask FROM accounts WHERE user_id=$1 ORDER BY is_debt ASC',
    [uid]
  )
  const netWorth = accounts.reduce((s, a) => a.is_debt ? s - Number(a.balance) : s + Number(a.balance), 0)

  // Dashboard summary
  const today    = new Date()
  const todayDay = today.getDate()
  const { rows: checking } = await pool.query(
    "SELECT balance FROM accounts WHERE user_id=$1 AND type='checking' LIMIT 1", [uid]
  )
  const balance = checking.length ? Number(checking[0].balance) : 0

  // Upcoming bills
  const { rows: recurring } = await pool.query(
    'SELECT name, amount, day_of_month, type, icon FROM recurring WHERE user_id=$1 AND active=TRUE ORDER BY day_of_month ASC',
    [uid]
  )
  const upcomingBills = recurring.filter(r => r.day_of_month >= todayDay && r.type !== 'income')
  const committedBills = upcomingBills.reduce((s, r) => s + Number(r.amount), 0)
  const nextPaycheck   = recurring.find(r => r.day_of_month >= todayDay && r.type === 'income')

  // Month spending
  const { rows: monthTotals } = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END),0) AS spent,
       COALESCE(SUM(CASE WHEN amount>0 THEN amount ELSE 0 END),0) AS income,
       COUNT(*) AS tx_count
     FROM transactions
     WHERE user_id=$1 AND date>=date_trunc('month',CURRENT_DATE)`,
    [uid]
  )
  const { spent: monthSpent, income: monthIncome, tx_count } = monthTotals[0]

  // Top spending categories this month
  const { rows: categories } = await pool.query(
    `SELECT category, SUM(ABS(amount)) AS total
     FROM transactions
     WHERE user_id=$1 AND amount<0 AND date>=date_trunc('month',CURRENT_DATE)
     GROUP BY category ORDER BY total DESC LIMIT 8`,
    [uid]
  )

  // Budget caps and current usage
  const { rows: budgets } = await pool.query(
    'SELECT name, cap, icon FROM budgets WHERE user_id=$1', [uid]
  )

  // Recent transactions (last 20)
  const { rows: recentTx } = await pool.query(
    `SELECT name, amount, category, date FROM transactions
     WHERE user_id=$1 ORDER BY date DESC, id DESC LIMIT 20`,
    [uid]
  )

  // 3-month averages
  const { rows: avgData } = await pool.query(
    `SELECT
       AVG(monthly_spend) AS avg_spend,
       AVG(monthly_income) AS avg_income
     FROM (
       SELECT
         date_trunc('month',date) AS m,
         SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) AS monthly_spend,
         SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) AS monthly_income
       FROM transactions
       WHERE user_id=$1 AND date>=date_trunc('month',CURRENT_DATE)-INTERVAL '3 months'
       GROUP BY date_trunc('month',date)
     ) sub`,
    [uid]
  )

  const avgMonthlySpend  = Math.round(Number(avgData[0]?.avg_spend  || 0))
  const avgMonthlyIncome = Math.round(Number(avgData[0]?.avg_income || 0))
  const savingsRate      = avgMonthlyIncome > 0
    ? Math.round(((avgMonthlyIncome - avgMonthlySpend) / avgMonthlyIncome) * 100)
    : 0

  const pressureScore = balance > 0 ? Math.min(100, Math.round((committedBills / balance) * 100)) : 100
  const pressureLabel = pressureScore < 25 ? 'SAFE' : pressureScore < 50 ? 'WATCH' : pressureScore < 75 ? 'TIGHT' : 'CRITICAL'

  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const daysLeft    = daysInMonth - todayDay

  // Build the context string
  return `
=== LUMEN FINANCIAL SNAPSHOT — ${today.toDateString()} ===

CURRENT POSITION
- Checking balance: $${balance.toLocaleString()}
- After committed bills: $${(balance - committedBills).toLocaleString()}
- Committed bills remaining this month: $${committedBills.toLocaleString()}
- Pressure gauge: ${pressureLabel} (score: ${pressureScore}/100)
- Net worth across all accounts: $${netWorth.toLocaleString()}

ACCOUNTS
${accounts.map(a => `- ${a.name} (${a.type}${a.mask ? ` ····${a.mask}` : ''}): $${Number(a.balance).toLocaleString()} ${a.is_debt ? '[DEBT]' : ''}`).join('\n')}

THIS MONTH (${daysLeft} days remaining)
- Income received: $${Number(monthIncome).toLocaleString()}
- Total spent: $${Number(monthSpent).toLocaleString()}
- Net: ${(Number(monthIncome) - Number(monthSpent)) >= 0 ? '+' : ''}$${(Number(monthIncome) - Number(monthSpent)).toLocaleString()}
- Transactions: ${tx_count}

TOP SPENDING CATEGORIES THIS MONTH
${categories.map(c => `- ${c.category}: $${Number(c.total).toFixed(2)}`).join('\n') || '- No spending data yet'}

BUDGET CAPS
${budgets.length > 0 ? budgets.map(b => `- ${b.name}: $${Number(b.cap).toLocaleString()} cap/month`).join('\n') : '- No budget categories set'}

UPCOMING BILLS
${upcomingBills.length > 0 ? upcomingBills.map(b => `- ${b.name}: $${Number(b.amount).toLocaleString()} (day ${b.day_of_month})`).join('\n') : '- No upcoming bills'}
${nextPaycheck ? `- Next paycheck: $${Number(nextPaycheck.amount).toLocaleString()} on day ${nextPaycheck.day_of_month}` : ''}

RECENT TRANSACTIONS (last 20)
${recentTx.map(t => `- ${new Date(t.date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}: ${t.name} ${Number(t.amount) < 0 ? '−' : '+'}$${Math.abs(Number(t.amount)).toFixed(2)} [${t.category}]`).join('\n')}

3-MONTH AVERAGES
- Avg monthly spend: $${avgMonthlySpend.toLocaleString()}
- Avg monthly income: $${avgMonthlyIncome.toLocaleString()}
- Savings rate: ${savingsRate}%
`.trim()
}

// POST /api/lumen/ask — streaming AI response
router.post('/ask', async (req, res, next) => {
  try {
    const { message, context_type = 'general' } = req.body
    if (!message) return res.status(400).json({ error: 'Message is required' })

    // Get user's Anthropic key
    const { rows } = await pool.query(
      'SELECT anthropic_key FROM users WHERE id=$1', [req.user.id]
    )
    const anthropicKey = rows[0]?.anthropic_key
    if (!anthropicKey) {
      return res.status(402).json({
        error: 'NO_KEY',
        message: 'Add your Anthropic API key in Settings to unlock AI responses.',
      })
    }

    // Build financial context
    const financialContext = await buildFinancialContext(req.user.id)

    const systemPrompt = `You are Lumen, a personal financial AI. You have access to the user's complete financial picture in real time.

Your personality:
- Warm, direct, and clear — never cold or clinical
- You speak in Lumen's voice: confident, calm, occasionally elegant
- You use specific numbers from their data — never vague
- You give a verdict, not just information. Users want to know: should I do this?
- Keep responses conversational and readable — no bullet lists unless the user asks
- Use natural paragraph breaks. Aim for 3-5 sentences unless the question demands more.
- When asked "what if" scenarios, always: (1) calculate the new balance, (2) assess pressure gauge impact, (3) give a clear verdict

FINANCIAL CONTEXT (real-time data):
${financialContext}

CONTEXT TYPE: ${context_type}

Always respond as Lumen — use "I" to refer to yourself, reference their specific numbers.`

    // Set up SSE streaming
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*')
    res.flushHeaders()

    const client = new Anthropic({ apiKey: anthropicKey })

    const stream = client.messages.stream({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: message }],
    })

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`)
    })

    stream.on('message', () => {
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
      res.end()
    })

    stream.on('error', (err) => {
      console.error('Anthropic stream error:', err)
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
      res.end()
    })

  } catch (err) {
    next(err)
  }
})

// POST /api/lumen/insight — non-streaming, used for auto-generated insight cards
router.post('/insight', async (req, res, next) => {
  try {
    const { prompt, context_type = 'insight' } = req.body

    const { rows } = await pool.query(
      'SELECT anthropic_key FROM users WHERE id=$1', [req.user.id]
    )
    const anthropicKey = rows[0]?.anthropic_key
    if (!anthropicKey) {
      return res.status(402).json({ error: 'NO_KEY' })
    }

    const financialContext = await buildFinancialContext(req.user.id)

    const client = new Anthropic({ apiKey: anthropicKey })
    const response = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 300,
      system: `You are Lumen, a personal financial AI. Generate a single sharp insight based on the user's financial data. Be specific, use their real numbers. 2-3 sentences max. No preamble. Context: ${context_type}

FINANCIAL DATA:
${financialContext}`,
      messages: [{ role: 'user', content: prompt }],
    })

    res.json({ insight: response.content[0].text })
  } catch (err) {
    next(err)
  }
})

module.exports = router
