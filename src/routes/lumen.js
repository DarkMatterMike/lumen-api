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
      model:      'claude-sonnet-4-6',
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
      model:      'claude-sonnet-4-6',
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

// POST /api/lumen/suggest-categories
router.post('/suggest-categories', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [uid])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const { rows: txs } = await pool.query(
      `SELECT DISTINCT name FROM transactions WHERE user_id=$1 AND amount < 0 ORDER BY name LIMIT 120`,
      [uid]
    )
    if (!txs.length) return res.json({ categories: [] })

    const client  = new Anthropic({ apiKey: anthropicKey })
    const txNames = txs.map(t => t.name).join(', ')

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 800,
      messages: [{ role: 'user', content: `Based on these transaction names from a user's bank account, suggest 6-8 practical budget categories for a personal finance app.\n\nTransactions: ${txNames}\n\nReturn ONLY a JSON array, no markdown, no explanation:\n[{"name":"Groceries","icon":"🛒","color":"safe"},...]\n\nColor options: safe (green), calm (blue), goal (purple), warn (amber), debt (red), pink, orange, sky, lime, gold\nUse common personal finance category names (1-2 words), pick icons that match.` }],
    })

    let categories = []
    try {
      const text = response.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim()
      categories = JSON.parse(text)
    } catch { categories = [] }

    res.json({ categories })
  } catch (err) { next(err) }
})

// POST /api/lumen/categorize
router.post('/categorize', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [uid])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const { rows: budgets } = await pool.query('SELECT id, name, icon FROM budgets WHERE user_id=$1 ORDER BY name', [uid])
    if (!budgets.length) return res.status(400).json({ error: 'NO_BUDGETS' })

    const budgetNames = budgets.map(b => b.name.toLowerCase())
    const { rows: allTxs } = await pool.query(
      `SELECT id, name, category FROM transactions
       WHERE user_id=$1 AND amount < 0 AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '3 months'
       ORDER BY date DESC LIMIT 200`,
      [uid]
    )
    const needsTag = allTxs.filter(tx => !budgetNames.includes((tx.category || '').toLowerCase()))
    if (!needsTag.length) return res.json({ updated: 0, total: 0 })

    const client       = new Anthropic({ apiKey: anthropicKey })
    const categoryList = budgets.map(b => `${b.icon} ${b.name}`).join(' | ')
    const txList       = needsTag.slice(0, 120).map(tx => `${tx.id}: ${tx.name}`).join('\n')

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2500,
      messages: [{ role: 'user', content: `Categorize these financial transactions into the provided budget categories.\n\nBudget categories: ${categoryList}\n\nTransactions (id: merchant name):\n${txList}\n\nReturn ONLY a JSON array, no markdown:\n[{"id":123,"category":"Groceries"},...]\n\nRules:\n- Use exact category names from the list\n- Set category to null if no category fits\n- Same merchant = same category always` }],
    })

    let mappings = []
    try {
      const text = response.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim()
      mappings = JSON.parse(text)
    } catch { return res.status(500).json({ error: 'AI returned an invalid response. Please try again.' }) }

    let updated = 0
    for (const { id, category } of mappings) {
      if (!category) continue
      const match = budgets.find(b => b.name.toLowerCase() === category.toLowerCase())
      if (!match) continue
      await pool.query('UPDATE transactions SET category=$1 WHERE id=$2 AND user_id=$3', [match.name, id, uid])
      updated++
    }

    res.json({ updated, total: needsTag.length })
  } catch (err) { next(err) }
})

// POST /api/lumen/budget-limits
router.post('/budget-limits', async (req, res, next) => {
  try {
    const uid = req.user.id
    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [uid])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const { rows: budgets } = await pool.query('SELECT * FROM budgets WHERE user_id=$1', [uid])
    if (!budgets.length) return res.status(400).json({ error: 'No budget categories found.' })

    const spendingData = await Promise.all(budgets.map(async (b) => {
      const { rows } = await pool.query(
        `SELECT date_trunc('month', date) AS month, COALESCE(SUM(ABS(amount)), 0) AS spent
         FROM transactions
         WHERE user_id=$1 AND category ILIKE $2 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
           AND date >= date_trunc('month', CURRENT_DATE) - INTERVAL '6 months'
         GROUP BY date_trunc('month', date) ORDER BY month ASC`,
        [uid, b.name]
      )
      const monthly = rows.map(r => Number(r.spent))
      const avg     = monthly.length ? monthly.reduce((s, v) => s + v, 0) / monthly.length : 0
      return { id: b.id, name: b.name, icon: b.icon, current_cap: Number(b.cap), monthly_spent: monthly, avg_monthly: Math.round(avg * 100) / 100 }
    }))

    const client  = new Anthropic({ apiKey: anthropicKey })
    const dataStr = spendingData.map(d =>
      `${d.icon} ${d.name}: cap $${d.current_cap}/mo | avg $${d.avg_monthly}/mo | months: [${d.monthly_spent.map(v => '$' + v.toFixed(0)).join(', ') || 'no data'}]`
    ).join('\n')

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      messages: [{ role: 'user', content: `Analyze this 6-month spending history and suggest optimal monthly budget caps.\n\n${dataStr}\n\nReturn ONLY a JSON array, no markdown:\n[{"id":1,"name":"Groceries","suggested_cap":350,"reasoning":"One sentence with specific numbers."},...]\n\nRules:\n- If avg > current cap: suggest higher cap\n- If avg < current cap × 0.6: suggest lower cap\n- Round all suggested_caps to nearest $25\n- One sentence reasoning with specific numbers` }],
    })

    let suggestions = []
    try {
      const text = response.content[0].text.trim().replace(/```json\n?|\n?```/g, '').trim()
      suggestions = JSON.parse(text).map(s => ({ ...s, ...spendingData.find(d => d.id === s.id) }))
    } catch { suggestions = [] }

    res.json({ suggestions, spendingData })
  } catch (err) { next(err) }
})
