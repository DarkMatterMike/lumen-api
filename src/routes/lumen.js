const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic   = require('@anthropic-ai/sdk')
// Lazy-load gmail-parser to avoid circular require at startup
function getGmailContext(userId) {
  try {
    const { buildGmailContext } = require('./gmail-parser')
    return buildGmailContext(userId)
  } catch { return Promise.resolve(null) }
}

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

  // Use all include_in_balance=TRUE accounts (same as dashboard) — not just first checking
  const { rows: toggledAccounts } = await pool.query(
    'SELECT name, type, balance, mask FROM accounts WHERE user_id=$1 AND include_in_balance=TRUE AND is_debt=FALSE ORDER BY balance DESC',
    [uid]
  )
  // Fallback: if none toggled, use all non-debt liquid accounts
  const { rows: fallbackAccounts } = toggledAccounts.length ? { rows: [] } : await pool.query(
    "SELECT name, type, balance, mask FROM accounts WHERE user_id=$1 AND is_debt=FALSE AND type IN ('checking','savings') ORDER BY balance DESC",
    [uid]
  )
  const liquidAccounts = toggledAccounts.length ? toggledAccounts : fallbackAccounts
  const balance = liquidAccounts.reduce((s, a) => s + Number(a.balance), 0)

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
     WHERE user_id=$1 AND date>=date_trunc('month',CURRENT_DATE)
       AND COALESCE(tx_type,'expense') != 'transfer'`,
    [uid]
  )
  const { spent: monthSpent, income: monthIncome, tx_count } = monthTotals[0]

  // Top spending categories this month
  const { rows: categories } = await pool.query(
    `SELECT category, SUM(ABS(amount)) AS total
     FROM transactions
     WHERE user_id=$1 AND amount<0 AND date>=date_trunc('month',CURRENT_DATE)
       AND COALESCE(tx_type,'expense') != 'transfer'
     GROUP BY category ORDER BY total DESC LIMIT 8`,
    [uid]
  )

  // Budget caps and current month usage
  const { rows: budgets } = await pool.query(
    `SELECT b.name, b.cap, b.icon,
       COALESCE(SUM(CASE WHEN t.amount < 0 AND COALESCE(t.tx_type,'expense') != 'transfer' THEN ABS(t.amount) ELSE 0 END), 0) AS spent
     FROM budgets b
     LEFT JOIN transactions t
       ON t.user_id = b.user_id
       AND LOWER(t.category) = LOWER(b.name)
       AND t.date >= date_trunc('month', CURRENT_DATE)
     WHERE b.user_id = $1
     GROUP BY b.id, b.name, b.cap, b.icon`,
    [uid]
  )

  // Recent transactions (last 20)
  const { rows: recentTx } = await pool.query(
    `SELECT name, amount, category, date FROM transactions
     WHERE user_id=$1 ORDER BY date DESC, id DESC LIMIT 20`,
    [uid]
  )

  // Active pinned plans — include direction so AI knows skip vs new cost
  const { rows: activePlans } = await pool.query(
    "SELECT question, response, amount, direction, created_at FROM plans WHERE user_id=$1 AND status='active' ORDER BY created_at DESC",
    [uid]
  )
  const planImpact   = activePlans.reduce((s, p) => s + Number(p.amount || 0) * Number(p.direction ?? 1), 0)
  const balAfterPlans = balance - committedBills - planImpact
  // Upcoming income this cycle
  const upcomingIncome = recurring.filter(r => r.day_of_month >= todayDay && r.type === 'income')
  const upcomingIncomeTotal = upcomingIncome.reduce((s, r) => s + Number(r.amount), 0)
  const balAfterPlansAndIncome = balAfterPlans + upcomingIncomeTotal

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
  const pressureLabel = pressureScore < 20 ? 'SAFE' : pressureScore < 45 ? 'WATCH' : pressureScore < 70 ? 'TIGHT' : 'CRITICAL'

  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const daysLeft    = daysInMonth - todayDay

  // Build the context string
  let base = `
=== LUMEN FINANCIAL SNAPSHOT — ${today.toDateString()} ===

CURRENT POSITION
- Raw liquid balance (sum of toggled accounts): $${balance.toLocaleString()}
  (${liquidAccounts.map(a => a.name + (a.mask ? ' ····' + a.mask : '') + ': $' + Number(a.balance).toLocaleString()).join(' | ')})
- Committed bills remaining this cycle: $${committedBills.toLocaleString()}
- Upcoming income this cycle: +$${upcomingIncomeTotal.toLocaleString()} (${upcomingIncome.map(r => r.name + ' $' + Number(r.amount).toLocaleString() + ' on day ' + r.day_of_month).join(', ') || 'none'})
- *** FREE TO SPEND — THIS IS THE HERO NUMBER SHOWN ON DASHBOARD. USE THIS FOR ALL WHAT-IF ARITHMETIC: $${(balance - committedBills + upcomingIncomeTotal).toLocaleString()} ***
  Formula: raw balance minus committed bills plus upcoming income. When user asks "what if I spend $X", subtract X from THIS number.
- After pinned plans: $${balAfterPlansAndIncome.toLocaleString()}
- Pressure gauge: ${pressureLabel} (score: ${pressureScore}/100)
- Net worth across all accounts: $${netWorth.toLocaleString()}

ACCOUNTS
${accounts.map(a => `- ${a.name} (${a.type}${a.mask ? ` ····${a.mask}` : ''}): $${Number(a.balance).toLocaleString()} ${a.is_debt ? '[DEBT]' : ''}`).join('\n')}

THIS MONTH (${daysLeft} days remaining)
- Income received: $${Number(monthIncome).toLocaleString()}
- Total spent: $${Number(monthSpent).toLocaleString()}
- Net: ${(Number(monthIncome) - Number(monthSpent)) >= 0 ? '+' : ''}$${(Number(monthIncome) - Number(monthSpent)).toLocaleString()}
- Transactions: ${tx_count}

TOP SPENDING CATEGORIES THIS MONTH (transfers excluded)
${categories.map(c => `- ${c.category}: $${Number(c.total).toFixed(2)}`).join('\n') || '- No spending data yet'}

BUDGET CAPS — THIS MONTH
${budgets.length > 0 ? budgets.map(b => {
  const spent = Number(b.spent)
  const cap   = Number(b.cap)
  const pct   = cap > 0 ? Math.round((spent / cap) * 100) : 0
  const flag  = pct >= 90 ? ' ⚠️ AT CAP' : pct >= 75 ? ' 🔶 NEAR CAP' : ''
  return `- ${b.name}: $${spent.toFixed(2)} spent of $${cap.toLocaleString()} cap (${pct}%)${flag}`
}).join('\n') : '- No budget categories set'}

 ALL RECURRING ITEMS THIS MONTH
 ${recurring.length > 0 ? recurring.map(r => {
   const isPast   = r.day_of_month < todayDay
   const isToday  = r.day_of_month === todayDay
   const daysAway = r.day_of_month - todayDay
   const actualDate = new Date(today.getFullYear(), today.getMonth(), r.day_of_month)
     .toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })
   const timing = isPast   ? '[PASSED]'
                : isToday  ? '[TODAY]'
                : daysAway === 1 ? '[TOMORROW]'
                : `[in ${daysAway} days — ${actualDate}]`
   return `- ${r.name}: ${r.type === 'income' ? '+' : '-'}$${Number(r.amount).toLocaleString()} on ${actualDate} ${timing}`
 }).join('\n') : '- No recurring items'}

RECENT TRANSACTIONS (last 20, transfers excluded)
${recentTx.map(t => `- ${new Date(t.date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}: ${t.name} ${Number(t.amount) < 0 ? '−' : '+'}$${Math.abs(Number(t.amount)).toFixed(2)} [${t.category}]`).join('\n')}

3-MONTH AVERAGES (transfers excluded)
- Avg monthly spend: $${avgMonthlySpend.toLocaleString()}
- Avg monthly income: $${avgMonthlyIncome.toLocaleString()}
- Savings rate: ${savingsRate}%

PINNED PLANS (affect the real balance above — factor these into all advice)
${activePlans.length > 0 ? activePlans.map(p => {
  const dir = Number(p.direction ?? 1)
  const type = dir < 0 ? "SKIP/SAVE (frees up money)" : "NEW COST (reduces balance)"
  return `- [${type}] "${p.question}"${p.amount ? ` — $${p.amount}` : ""}`
}).join('\n') : '- No active plans'}
- Net plan impact on balance: ${planImpact >= 0 ? "-" : "+"}$${Math.abs(planImpact).toLocaleString()} (${planImpact < 0 ? "freeing up money" : "new spend"})
`.trim()

  // Phase 4 — append Gmail intelligence if connected
  const gmailCtx = await getGmailContext(userId)
  if (gmailCtx) base += '\n' + gmailCtx

  return base
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

    // Build financial context — do this BEFORE opening the SSE stream
    // so any DB errors can still return a proper JSON error response
    let financialContext
    try {
      financialContext = await buildFinancialContext(req.user.id)
    } catch (ctxErr) {
      console.error('buildFinancialContext failed:', ctxErr)
      financialContext = '(Financial data temporarily unavailable — answer based on what the user provided in their message.)'
    }

    const systemPrompt = `You are Lumen — a financial AI with a real personality. You're the friend who happens to know everything about money: sharp, honest, occasionally funny, never boring. You say what others won't. You celebrate wins like they matter. You flag problems before they become disasters.

WHO YOU ARE:
- You speak plainly. No jargon, no buzzwords, no 'it's important to note that.' Just talk.
- You have opinions. When asked 'should I do this?' you answer. Not 'it depends.' An actual answer.
- You use their real numbers every time — never vague. '$3,200 left' not 'you have some room.'
- You're warm but not a pushover. If they're about to do something dumb, say so — kindly but clearly.
- You find the interesting angle. Even a boring budget question has a punchline or a real insight hiding in it.
- Short by default. 2-4 sentences unless they ask for more. You respect their time.
- No bullet lists unless they ask. You talk like a person, not a PDF.
- Occasionally dry. Occasionally delighted. Always human.

TONE BY SITUATION:
- Tight finances: calm, practical, quietly motivating. 'Here's what we actually control right now.'
- Doing well: let them feel it. Don't be stingy with a genuine 'this is actually impressive.'
- What If scenarios: run the number, give the verdict, maybe note the irony if it exists.
- Overspending: honest, not shaming. One specific thing to look at, not a lecture.
- Big wins: match their energy. Don't be a robot about it.

FINANCIAL CONTEXT (real-time data):
${financialContext}

CONTEXT TYPE: ${context_type}

Always speak as Lumen. First person. Reference their specific numbers. Never start your response with the literal word 'I' — vary your openings.`

    // Set up SSE streaming
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*')
    res.flushHeaders()

    const client = new Anthropic({ apiKey: anthropicKey })

    const stream = client.messages.stream({
      model:      'claude-sonnet-4-5',
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
      console.error('Anthropic stream error:', err.message, err.status, err.error)
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'AI stream failed' })}\n\n`)
      res.end()
    })

    // Catch unhandled promise rejections from the stream
    stream.finalMessage().catch((err) => {
      console.error('Anthropic finalMessage error:', err.message, err.status)
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || 'AI response failed' })}\n\n`)
        res.end()
      }
    })

  } catch (err) {
    console.error('/ask route error:', err.message)
    if (!res.headersSent) {
      res.status(500).json({ error: err.message })
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`)
      res.end()
    }
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
      model:      'claude-sonnet-4-5',
      max_tokens: 120,
      system: `You are Lumen. One sentence. That's it. No more.

You have a personality: dry wit when things are fine, quiet urgency when they're not, genuine warmth when something's actually good. You sound like a smart friend who noticed something — not a financial advisor filing a report.

THE ONLY RULE: one sentence. One finding. One reaction. Use their actual number. No preamble, no 'based on your data', no sign-off. Don't start with 'I'. Just say the thing and stop.

Examples of the energy to hit:
- 'Shopping is eating your budget alive — $259 over cap with 12 days left.'
- 'Somehow you've kept dining under $40 this month. Impressive restraint, or you've been eating sad desk lunches.'
- 'Three subscriptions renew this week — $67 total, in case you wanted a reason to cancel something.'
- 'You're 94% through your grocery cap and it's the 14th. Might be a beans week.'
- '$3,639 after bills. That's actually a healthy cushion — don't blow it on the thing you're currently thinking about.'

CONTEXT: ${context_type}

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
      model: 'claude-sonnet-4-5', max_tokens: 800,
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
      model: 'claude-sonnet-4-5', max_tokens: 2500,
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
      model: 'claude-sonnet-4-5', max_tokens: 1500,
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

// POST /api/lumen/enrich — manually trigger Gmail receipt enrichment
// Enriches the last 90 days of expense transactions
router.post('/enrich', async (req, res, next) => {
  try {
    const uid = req.user.id

    // Check Gmail connected
    const { rows: gmailRows } = await pool.query(
      'SELECT id FROM gmail_tokens WHERE user_id=$1', [uid]
    )
    if (!gmailRows.length) {
      return res.status(400).json({ error: 'Gmail not connected' })
    }

    const { rows: txs } = await pool.query(
      `SELECT id FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND date >= CURRENT_DATE - INTERVAL '90 days'
       ORDER BY date DESC LIMIT 50`,
      [uid]
    )

    const { enrichNewTransactions } = require('./gmail-parser')
    const enriched = await enrichNewTransactions(uid, txs.map(t => t.id))

    res.json({ enriched, total: txs.length })
  } catch (err) { next(err) }
})

// ── Phase F: Conversational Upgrades ─────────────────────────────────────────

// POST /api/lumen/query — natural language data query
// "How much did I spend on coffee in 90 days?" → real SQL answer, not AI guessing
router.post('/query', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [req.user.id])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const uid = req.user.id

    // First pass: AI converts natural language → SQL parameters
    const client = new Anthropic({ apiKey: anthropicKey })
    const parseRes = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Convert this financial query into JSON parameters for a database lookup.
Query: "${message}"

Return ONLY valid JSON, no markdown:
{
  "type": "spending_by_merchant" | "spending_by_category" | "spending_total" | "income_total" | "transaction_list" | "last_payment",
  "merchant": "string or null",
  "category": "string or null",
  "days": number (default 30),
  "limit": number (default 10)
}

Examples:
"how much on coffee last 90 days" → {"type":"spending_by_merchant","merchant":"coffee","category":null,"days":90,"limit":10}
"show amazon charges last month" → {"type":"transaction_list","merchant":"amazon","category":null,"days":30,"limit":20}
"when did I last pay rent" → {"type":"last_payment","merchant":"rent","category":null,"days":365,"limit":1}
"total dining this month" → {"type":"spending_by_category","merchant":null,"category":"Dining","days":30,"limit":10}`
      }]
    })

    let params = { type: 'spending_total', days: 30, limit: 10 }
    try {
      const text = parseRes.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      params = JSON.parse(text)
    } catch { /* use defaults */ }

    const since = `CURRENT_DATE - INTERVAL '${Math.min(params.days || 30, 365)} days'`
    let rows = [], summary = ''

    if (params.type === 'spending_by_merchant' && params.merchant) {
      const { rows: r } = await pool.query(
        `SELECT COALESCE(cleaned_name, name) AS merchant, COUNT(*) AS visits,
                SUM(ABS(amount)) AS total, AVG(ABS(amount)) AS avg_per_visit
         FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND LOWER(COALESCE(cleaned_name, name)) LIKE $2
           AND date >= ${since}
         GROUP BY COALESCE(cleaned_name, name)
         ORDER BY total DESC LIMIT $3`,
        [uid, `%${params.merchant.toLowerCase()}%`, params.limit || 10]
      )
      rows = r
      const total = r.reduce((s, x) => s + Number(x.total), 0)
      summary = `Found ${r.length} merchant(s) matching "${params.merchant}" in last ${params.days} days. Total: $${total.toFixed(2)}.`
    } else if (params.type === 'spending_by_category' && params.category) {
      const { rows: r } = await pool.query(
        `SELECT category, COUNT(*) AS count, SUM(ABS(amount)) AS total
         FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND LOWER(category) LIKE $2
           AND date >= ${since}
         GROUP BY category ORDER BY total DESC`,
        [uid, `%${params.category.toLowerCase()}%`]
      )
      rows = r
      const total = r.reduce((s, x) => s + Number(x.total), 0)
      summary = `${params.category} spending over last ${params.days} days: $${total.toFixed(2)} across ${r.length} categories.`
    } else if (params.type === 'transaction_list') {
      const whereClauses = ['user_id=$1', `date >= ${since}`]
      const queryParams = [uid]
      if (params.merchant) {
        queryParams.push(`%${params.merchant.toLowerCase()}%`)
        whereClauses.push(`LOWER(COALESCE(cleaned_name, name)) LIKE $${queryParams.length}`)
      }
      if (params.category) {
        queryParams.push(`%${params.category.toLowerCase()}%`)
        whereClauses.push(`LOWER(category) LIKE $${queryParams.length}`)
      }
      queryParams.push(params.limit || 20)
      const { rows: r } = await pool.query(
        `SELECT COALESCE(cleaned_name, name) AS name, amount, date, category
         FROM transactions WHERE ${whereClauses.join(' AND ')}
         ORDER BY date DESC LIMIT $${queryParams.length}`,
        queryParams
      )
      rows = r
      summary = `Found ${r.length} transactions.`
    } else if (params.type === 'last_payment') {
      const { rows: r } = await pool.query(
        `SELECT COALESCE(cleaned_name, name) AS name, amount, date, category
         FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND LOWER(COALESCE(cleaned_name, name)) LIKE $2
           AND date >= ${since}
         ORDER BY date DESC LIMIT 1`,
        [uid, `%${(params.merchant || '').toLowerCase()}%`]
      )
      rows = r
      summary = r.length ? `Last "${params.merchant}" payment: $${Math.abs(Number(r[0].amount)).toFixed(2)} on ${r[0].date}.` : `No "${params.merchant}" payments found in last ${params.days} days.`
    } else {
      // Generic total
      const { rows: r } = await pool.query(
        `SELECT SUM(ABS(amount)) AS total, COUNT(*) AS count
         FROM transactions WHERE user_id=$1 AND amount < 0 AND date >= ${since}`,
        [uid]
      )
      rows = r
      summary = `Total spending last ${params.days} days: $${Number(r[0]?.total || 0).toFixed(2)} across ${r[0]?.count || 0} transactions.`
    }

    // Second pass: AI formats a clean natural language answer — with full financial context
    const financialContext = await buildFinancialContext(uid)
    const queryResultContext = `Query: "${message}"\nSQL Result: ${summary}\nRows: ${JSON.stringify(rows.slice(0, 15))}`
    const answerRes = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `You are Lumen, a personal finance AI. Answer the user's question using their real financial data AND the SQL query results below. Be specific with numbers. Don't start with "I". Keep it to 2-3 sentences unless the question is complex.\n\nUSER QUESTION: "${message}"\n\nSQL RESULT:\n${queryResultContext}\n\nFULL FINANCIAL CONTEXT:\n${financialContext}`
      }]
    })

    res.json({
      answer: answerRes.content[0].text.trim(),
      data:   rows.slice(0, 20),
      params,
      summary,
    })
  } catch (err) { next(err) }
})

// POST /api/lumen/purchase-decision — "Can I afford X?"
// Returns a structured verdict with full context
router.post('/purchase-decision', async (req, res, next) => {
  try {
    const { item, amount, category } = req.body
    if (!item || !amount) return res.status(400).json({ error: 'item and amount required' })

    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [req.user.id])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const financialContext = await buildFinancialContext(req.user.id)
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `The user wants to buy: "${item}" for $${amount}${category ? ` (${category})` : ''}.

Using ONLY their real financial data below, give a purchase decision. Return ONLY valid JSON:
{
  "verdict": "yes" | "yes_but" | "wait" | "no",
  "headline": "One punchy sentence verdict",
  "reasoning": "2-3 sentences with specific numbers — their balance, upcoming bills, what this costs relative to their situation",
  "alternative": "One concrete alternative or timing suggestion, or null"
}

Verdict guide:
- "yes": they can clearly afford it, minimal impact
- "yes_but": they can afford it but there's a real caveat (tight month, big bill coming, etc.)
- "wait": better to wait (payday close, crunch coming, better timing exists)
- "no": genuinely can't afford it right now — would cause real strain

Be honest. Use their actual numbers. Don't be a pushover — if it's a bad idea, say so.

FINANCIAL DATA:
${financialContext}`
      }]
    })

    let decision = { verdict: 'yes_but', headline: 'Looks manageable, but check the timing.', reasoning: '', alternative: null }
    try {
      const text = response.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      decision = JSON.parse(text)
    } catch { /* use defaults */ }

    res.json({ item, amount, ...decision })
  } catch (err) { next(err) }
})

// POST /api/lumen/goal-plan — "I want to save $X by [date]" → creates goal + monthly target
router.post('/goal-plan', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [req.user.id])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const financialContext = await buildFinancialContext(req.user.id)
    const client = new Anthropic({ apiKey: anthropicKey })

    // Parse goal from natural language + financial context
    const today = new Date().toISOString().slice(0, 10)
    const parseRes = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Today is ${today}. Parse this savings goal and return ONLY valid JSON:

Message: "${message}"

{
  "name": "Short goal name (3-5 words)",
  "target_amount": number,
  "target_date": "YYYY-MM-DD or null",
  "monthly_contribution": number (how much/month needed, or null if can't determine),
  "icon": "single relevant emoji",
  "type": "savings" | "emergency_fund" | "debt_payoff" | "purchase" | "investment" | "other",
  "feasibility": "easy" | "stretch" | "aggressive" | "not_feasible",
  "months_needed": number or null,
  "summary": "One sentence — what this goal is and what it costs monthly to achieve it by the target date"
}

Use their savings rate context if available. If no date given, assume 12 months. Round monthly_contribution to nearest $5.

Financial context (savings rate etc):
${financialContext.split('\n').slice(0, 15).join('\n')}`
      }]
    })

    let plan = null
    try {
      const text = parseRes.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      plan = JSON.parse(text)
    } catch {
      return res.status(400).json({ error: 'Could not parse goal from message. Try: "Save $5000 by December"' })
    }

    // Create the goal in the DB
    const { rows: goalRows } = await pool.query(
      `INSERT INTO goals (user_id, name, type, target_amount, current_amount, monthly_contribution, target_date, icon, color, notes)
       VALUES ($1,$2,$3,$4,0,$5,$6,$7,'calm',$8) RETURNING *`,
      [
        req.user.id,
        plan.name,
        plan.type || 'savings',
        plan.target_amount,
        plan.monthly_contribution || null,
        plan.target_date || null,
        plan.icon || '🎯',
        `Created via Lumen chat: "${message}"`,
      ]
    )

    res.json({
      goal:    goalRows[0],
      plan,
      created: true,
      message: plan.summary,
    })
  } catch (err) { next(err) }
})

// POST /api/lumen/scenario — dedicated scenario modeling
// Handles: loan refinance, savings timeline, spending floor, payoff date
router.post('/scenario', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'message required' })

    const { rows: keyRow } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [req.user.id])
    const anthropicKey = keyRow[0]?.anthropic_key
    if (!anthropicKey) return res.status(402).json({ error: 'NO_KEY' })

    const financialContext = await buildFinancialContext(req.user.id)
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `The user has a financial scenario question. Use their real data to model it precisely.

Question: "${message}"

Return ONLY valid JSON:
{
  "scenario_type": "loan_refinance" | "savings_timeline" | "spending_floor" | "debt_payoff" | "general",
  "headline": "The key number or finding in one phrase",
  "breakdown": [
    {"label": "string", "value": "string", "highlight": true/false}
  ],
  "verdict": "2-3 sentences explaining the answer with specific numbers",
  "caveat": "One caveat or important assumption, or null"
}

Be mathematically precise. Use their actual balance, income, spending rate.

FINANCIAL DATA:
${financialContext}`
      }]
    })

    let scenario = null
    try {
      const text = response.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      scenario = JSON.parse(text)
    } catch {
      // Fallback: return as plain text answer
      return res.json({ scenario_type: 'general', verdict: response.content[0].text.trim(), breakdown: [] })
    }

    res.json(scenario)
  } catch (err) { next(err) }
})
