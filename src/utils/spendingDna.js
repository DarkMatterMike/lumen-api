/**
 * spendingDna.js
 * Feature 8 — Spending DNA
 *
 * Generates a monthly "financial personality" read from real transaction data.
 * Stores it so it can be served instantly. Runs on the 1st of each month.
 */
const pool     = require('../db/pool')
const Anthropic = require('@anthropic-ai/sdk')

async function getApiKey(userId) {
  const { rows } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [userId])
  return rows[0]?.anthropic_key || process.env.ANTHROPIC_API_KEY || null
}

async function generateDna(userId, monthsBack = 3) {
  const apiKey = await getApiKey(userId)
  if (!apiKey) return null

  const monthKey = new Date().toISOString().slice(0, 7)

  // Check if already generated this month
  const { rows: existing } = await pool.query(
    'SELECT id FROM spending_dna WHERE user_id=$1 AND month_key=$2',
    [userId, monthKey]
  )
  if (existing.length) {
    const { rows } = await pool.query(
      'SELECT * FROM spending_dna WHERE user_id=$1 AND month_key=$2',
      [userId, monthKey]
    )
    return rows[0]
  }

  // Gather rich behavioral data
  const [
    categoryData,
    dowData,
    merchantData,
    timeOfMonthData,
    recurringData,
    weekendVsWeekday,
    streakData,
  ] = await Promise.all([
    // Spending by category (3 months)
    pool.query(
      `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count,
              AVG(ABS(amount)) AS avg_per_tx
       FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '${monthsBack} months'
       GROUP BY category ORDER BY total DESC`,
      [userId]
    ),
    // Day-of-week spending
    pool.query(
      `SELECT TO_CHAR(date, 'Day') AS day_name,
              EXTRACT(DOW FROM date) AS dow,
              SUM(ABS(amount)) AS total, COUNT(*) AS count
       FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '${monthsBack} months'
       GROUP BY day_name, dow ORDER BY total DESC`,
      [userId]
    ),
    // Top merchants by loyalty (visit count)
    pool.query(
      `SELECT COALESCE(cleaned_name, name) AS merchant,
              COUNT(*) AS visits,
              SUM(ABS(amount)) AS total,
              MIN(date) AS first_seen,
              MAX(date) AS last_seen
       FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '${monthsBack} months'
       GROUP BY COALESCE(cleaned_name, name)
       ORDER BY visits DESC LIMIT 10`,
      [userId]
    ),
    // Early vs late month spending
    pool.query(
      `SELECT
         CASE WHEN EXTRACT(DAY FROM date) <= 15 THEN 'early' ELSE 'late' END AS half,
         SUM(ABS(amount)) AS total
       FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '${monthsBack} months'
       GROUP BY half`,
      [userId]
    ),
    // Subscription count
    pool.query(
      `SELECT COUNT(*) AS count, SUM(amount) AS total
       FROM recurring WHERE user_id=$1 AND active=TRUE
         AND LOWER(COALESCE(category,'')) LIKE '%subscri%'`,
      [userId]
    ),
    // Weekend vs weekday
    pool.query(
      `SELECT
         CASE WHEN EXTRACT(DOW FROM date) IN (0,6) THEN 'weekend' ELSE 'weekday' END AS period,
         SUM(ABS(amount)) AS total, COUNT(*) AS count,
         AVG(ABS(amount)) AS avg_tx
       FROM transactions
       WHERE user_id=$1 AND amount < 0
         AND COALESCE(tx_type,'expense') != 'transfer'
         AND date >= CURRENT_DATE - INTERVAL '${monthsBack} months'
       GROUP BY period`,
      [userId]
    ),
    // Budget streaks
    pool.query(
      `SELECT b.name, b.cap,
         SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) AS spent
       FROM budgets b
       LEFT JOIN transactions t ON t.user_id=b.user_id AND LOWER(t.category)=LOWER(b.name)
         AND t.date >= date_trunc('month', CURRENT_DATE)
       WHERE b.user_id=$1 GROUP BY b.id, b.name, b.cap`,
      [userId]
    ),
  ])

  const totalSpend = categoryData.rows.reduce((s, r) => s + Number(r.total), 0)
  const topCat     = categoryData.rows[0]
  const topMerch   = merchantData.rows[0]
  const topDay     = dowData.rows[0]
  const weekend    = weekendVsWeekday.rows.find(r => r.period === 'weekend')
  const weekday    = weekendVsWeekday.rows.find(r => r.period === 'weekday')
  const earlyHalf  = timeOfMonthData.rows.find(r => r.half === 'early')
  const lateHalf   = timeOfMonthData.rows.find(r => r.half === 'late')

  // Build structured DNA object
  const dna = {
    month_key:       monthKey,
    total_spend:     Math.round(totalSpend),
    top_category:    { name: topCat?.category, pct: totalSpend > 0 ? Math.round((Number(topCat?.total || 0) / totalSpend) * 100) : 0 },
    top_merchant:    { name: topMerch?.merchant, visits: Number(topMerch?.visits || 0) },
    most_expensive_day: topDay?.day_name?.trim(),
    weekend_ratio:   weekend && weekday ? Math.round((Number(weekend.total) / (Number(weekend.total) + Number(weekday.total))) * 100) : null,
    spends_early:    earlyHalf && lateHalf ? Number(earlyHalf.total) > Number(lateHalf.total) : null,
    subscription_count: Number(recurringData.rows[0]?.count || 0),
    distinct_merchants: merchantData.rows.length,
    loyalty_score:   topMerch ? Math.round((Number(topMerch.visits) / Math.max(1, merchantData.rows.reduce((s,r) => s + Number(r.visits), 0))) * 100) : 0,
    categories:      categoryData.rows.slice(0, 8).map(r => ({ name: r.category, total: Math.round(Number(r.total)), pct: Math.round((Number(r.total)/totalSpend)*100) })),
    top_merchants:   merchantData.rows.slice(0, 6).map(r => ({ name: r.merchant, visits: Number(r.visits), total: Math.round(Number(r.total)) })),
    budget_adherence: streakData.rows.filter(b => Number(b.cap) > 0).map(b => ({
      name:  b.name,
      cap:   Number(b.cap),
      spent: Math.round(Number(b.spent)),
      under: Number(b.spent) <= Number(b.cap),
    })),
  }

  // Generate the personality narrative
  const client  = new Anthropic({ apiKey })
  const context = `
Monthly spending data for financial personality analysis:
- Total spend: $${dna.total_spend}
- Top category: ${dna.top_category.name} (${dna.top_category.pct}% of spending)
- Most visited merchant: ${dna.top_merchant.name} (${dna.top_merchant.visits} visits)
- Busiest spending day: ${dna.most_expensive_day}
- Weekend spending: ${dna.weekend_ratio}% of total
- Spends more in: ${dna.spends_early ? 'early half of month' : 'late half of month'}
- Active subscriptions: ${dna.subscription_count}
- Unique merchants: ${dna.distinct_merchants}
- Top categories: ${dna.categories.map(c => `${c.name} $${c.total}`).join(', ')}
- Top merchants by loyalty: ${dna.top_merchants.map(m => `${m.name} (${m.visits}x)`).join(', ')}
`.trim()

  const aiRes = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Write a witty, specific, honest financial personality profile for this person based on their spending data. 

Rules:
- 3-4 punchy sentences. No fluff.
- Be specific — use their actual numbers and merchants
- Mix observation and gentle roast. Finance with personality.
- Don't moralize or give advice. Just describe what the data says about them.
- Start mid-sentence, not with "You are" or "Based on". Start with an observation.
- Example tone: "Fridays are your financial kryptonite — 40% of your weekly spend lands after 5pm on Fridays. You've been to Chipotle 11 times this month, which is either a lifestyle or a cry for help. Your subscriptions now outnumber your close friends."

DATA:
${context}`
    }]
  })

  const narrative = aiRes.content[0].text.trim()

  // Store it
  const { rows: stored } = await pool.query(
    `INSERT INTO spending_dna (user_id, month_key, dna, narrative)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, month_key)
     DO UPDATE SET dna=$3, narrative=$4, generated_at=NOW()
     RETURNING *`,
    [userId, monthKey, JSON.stringify(dna), narrative]
  )

  return stored[0]
}

async function getLatestDna(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM spending_dna WHERE user_id=$1 ORDER BY month_key DESC LIMIT 3',
    [userId]
  )
  return rows
}

module.exports = { generateDna, getLatestDna }
