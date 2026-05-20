/**
 * Reports Route
 *
 * GET /api/reports/monthly?year=YYYY&month=MM — generate a monthly report
 * GET /api/reports/monthly/html               — same but returns raw HTML for printing
 */
const express   = require('express')
const router    = express.Router()
const pool      = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic = require('@anthropic-ai/sdk')
const jwt       = require('jsonwebtoken')
const JWT_SECRET = process.env.JWT_SECRET || 'lumen-dev-secret'

// Allow token via query param for the HTML report (browser opens in new tab)
function requireAuthOrQuery(req, res, next) {
  if (req.headers.authorization) return requireAuth(req, res, next)
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

async function getApiKey(userId) {
  const { rows } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [userId])
  return rows[0]?.anthropic_key || process.env.ANTHROPIC_API_KEY || null
}

// GET /api/reports/monthly — full report data + AI narrative
router.get('/monthly', requireAuth, async (req, res, next) => {
  try {
    const today = new Date()
    const year  = parseInt(req.query.year  || today.getFullYear())
    const month = parseInt(req.query.month || today.getMonth()) // 0-indexed

    const monthStart = `${year}-${String(month + 1).padStart(2,'0')}-01`
    const monthEnd   = new Date(year, month + 1, 0).toISOString().slice(0,10)
    const monthName  = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

    const uid = req.user.id
    const apiKey = await getApiKey(uid)

    const [income, expenses, byCategory, topMerchants, budgets, netWorthSnap, goals, txCount] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE user_id=$1 AND amount > 0
           AND COALESCE(tx_type,'expense') != 'transfer'
           AND date BETWEEN $2 AND $3`,
        [uid, monthStart, monthEnd]
      ),
      pool.query(
        `SELECT COALESCE(SUM(ABS(amount)),0) AS total FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
           AND date BETWEEN $2 AND $3`,
        [uid, monthStart, monthEnd]
      ),
      pool.query(
        `SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count
         FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
           AND date BETWEEN $2 AND $3
         GROUP BY category ORDER BY total DESC LIMIT 8`,
        [uid, monthStart, monthEnd]
      ),
      pool.query(
        `SELECT COALESCE(cleaned_name, name) AS name, SUM(ABS(amount)) AS total, COUNT(*) AS visits
         FROM transactions
         WHERE user_id=$1 AND amount < 0
           AND COALESCE(tx_type,'expense') != 'transfer'
           AND date BETWEEN $2 AND $3
         GROUP BY COALESCE(cleaned_name, name) ORDER BY total DESC LIMIT 5`,
        [uid, monthStart, monthEnd]
      ),
      pool.query(
        `SELECT b.name, b.cap,
           COALESCE(SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END),0) AS spent
         FROM budgets b
         LEFT JOIN transactions t ON t.user_id=b.user_id
           AND LOWER(t.category)=LOWER(b.name)
           AND t.date BETWEEN $2 AND $3
         WHERE b.user_id=$1
         GROUP BY b.id, b.name, b.cap ORDER BY spent DESC`,
        [uid, monthStart, monthEnd]
      ),
      pool.query(
        `SELECT net_worth, assets, liabilities FROM net_worth_snapshots
         WHERE user_id=$1 AND snapshot_date <= $2
         ORDER BY snapshot_date DESC LIMIT 1`,
        [uid, monthEnd]
      ),
      pool.query(
        `SELECT name, type, target_amount, current_amount, monthly_contribution
         FROM goals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`,
        [uid]
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE user_id=$1 AND date BETWEEN $2 AND $3`,
        [uid, monthStart, monthEnd]
      ),
    ])

    const totalIncome   = Number(income.rows[0].total)
    const totalExpenses = Number(expenses.rows[0].total)
    const netSavings    = totalIncome - totalExpenses
    const savingsRate   = totalIncome > 0 ? Math.round((netSavings / totalIncome) * 100) : 0

    const reportData = {
      month:        monthName,
      year,
      month_num:    month + 1,
      total_income:   Math.round(totalIncome),
      total_expenses: Math.round(totalExpenses),
      net_savings:    Math.round(netSavings),
      savings_rate:   savingsRate,
      transaction_count: Number(txCount.rows[0].count),
      by_category:    byCategory.rows.map(r => ({ name: r.category, total: Math.round(Number(r.total)), count: Number(r.count), pct: totalExpenses > 0 ? Math.round((Number(r.total)/totalExpenses)*100) : 0 })),
      top_merchants:  topMerchants.rows.map(r => ({ name: r.name, total: Math.round(Number(r.total)), visits: Number(r.visits) })),
      budgets:        budgets.rows.map(b => ({ name: b.name, cap: Number(b.cap), spent: Math.round(Number(b.spent)), under: Number(b.spent) <= Number(b.cap), pct: b.cap > 0 ? Math.round((Number(b.spent)/Number(b.cap))*100) : 0 })),
      net_worth:      netWorthSnap.rows[0] ? Math.round(Number(netWorthSnap.rows[0].net_worth)) : null,
      goals:          goals.rows.map(g => ({ name: g.name, type: g.type, target: Number(g.target_amount), current: Number(g.current_amount), pct: g.target_amount > 0 ? Math.round((Number(g.current_amount)/Number(g.target_amount))*100) : 0 })),
    }

    // AI narrative (if key available)
    let narrative = null
    if (apiKey) {
      const client = new Anthropic({ apiKey })
      const res2 = await client.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 350,
        messages: [{
          role: 'user',
          content: `Write a concise, honest monthly financial summary in 3-4 sentences. Be specific with numbers. Note the most important thing — good or bad. Don't moralize. Start with the month name.

Month: ${monthName}
Income: $${reportData.total_income}
Expenses: $${reportData.total_expenses}
Net: $${reportData.net_savings} (${savingsRate}% savings rate)
Top category: ${reportData.by_category[0]?.name} $${reportData.by_category[0]?.total}
Budgets under cap: ${reportData.budgets.filter(b=>b.under).length}/${reportData.budgets.length}`
        }]
      })
      narrative = res2.content[0].text.trim()
    }

    res.json({ ...reportData, narrative })
  } catch (err) { next(err) }
})

// GET /api/reports/monthly/html — returns a print-ready HTML document
router.get('/monthly/html', requireAuthOrQuery, async (req, res, next) => {
  try {
    const today = new Date()
    const year  = parseInt(req.query.year  || today.getFullYear())
    const month = parseInt(req.query.month || today.getMonth())

    // Fetch the data via internal call
    const mockReq = { user: req.user, query: req.query }
    const data = await new Promise((resolve, reject) => {
      const mockRes = {
        json: resolve,
        status: () => ({ json: reject }),
      }
      // Re-use the monthly handler logic inline
      generateReportData(req.user.id, year, month).then(resolve).catch(reject)
    })

    res.setHeader('Content-Type', 'text/html')
    res.send(buildReportHtml(data))
  } catch (err) { next(err) }
})

async function generateReportData(userId, year, month) {
  const monthStart = `${year}-${String(month + 1).padStart(2,'0')}-01`
  const monthEnd   = new Date(year, month + 1, 0).toISOString().slice(0,10)
  const monthName  = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const uid        = userId
  const apiKey     = await getApiKey(uid)

  const [income, expenses, byCategory, topMerchants, budgets, netWorthSnap, goals, healthRows] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE user_id=$1 AND amount>0 AND COALESCE(tx_type,'expense')!='transfer' AND date BETWEEN $2 AND $3`, [uid, monthStart, monthEnd]),
    pool.query(`SELECT COALESCE(SUM(ABS(amount)),0) AS total FROM transactions WHERE user_id=$1 AND amount<0 AND COALESCE(tx_type,'expense')!='transfer' AND date BETWEEN $2 AND $3`, [uid, monthStart, monthEnd]),
    pool.query(`SELECT category, SUM(ABS(amount)) AS total, COUNT(*) AS count FROM transactions WHERE user_id=$1 AND amount<0 AND COALESCE(tx_type,'expense')!='transfer' AND date BETWEEN $2 AND $3 GROUP BY category ORDER BY total DESC LIMIT 8`, [uid, monthStart, monthEnd]),
    pool.query(`SELECT COALESCE(cleaned_name,name) AS name, SUM(ABS(amount)) AS total, COUNT(*) AS visits FROM transactions WHERE user_id=$1 AND amount<0 AND COALESCE(tx_type,'expense')!='transfer' AND date BETWEEN $2 AND $3 GROUP BY COALESCE(cleaned_name,name) ORDER BY total DESC LIMIT 6`, [uid, monthStart, monthEnd]),
    pool.query(`SELECT b.name, b.cap, COALESCE(SUM(CASE WHEN t.amount<0 THEN ABS(t.amount) ELSE 0 END),0) AS spent FROM budgets b LEFT JOIN transactions t ON t.user_id=b.user_id AND LOWER(t.category)=LOWER(b.name) AND t.date BETWEEN $2 AND $3 WHERE b.user_id=$1 GROUP BY b.id,b.name,b.cap ORDER BY spent DESC`, [uid, monthStart, monthEnd]),
    pool.query(`SELECT net_worth FROM net_worth_snapshots WHERE user_id=$1 AND snapshot_date<=$2 ORDER BY snapshot_date DESC LIMIT 1`, [uid, monthEnd]),
    pool.query(`SELECT name,type,target_amount,current_amount FROM goals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 4`, [uid]),
    pool.query(`SELECT score,grade,label FROM health_scores WHERE user_id=$1 ORDER BY computed_at DESC LIMIT 1`, [uid]),
  ])

  const totalIncome   = Number(income.rows[0].total)
  const totalExpenses = Number(expenses.rows[0].total)
  const netSavings    = totalIncome - totalExpenses
  const savingsRate   = totalIncome > 0 ? Math.round((netSavings / totalIncome) * 100) : 0
  const health        = healthRows.rows[0]

  const reportData = {
    month: monthName, year, month_num: month + 1,
    total_income:   Math.round(totalIncome),
    total_expenses: Math.round(totalExpenses),
    net_savings:    Math.round(netSavings),
    savings_rate:   savingsRate,
    by_category:  byCategory.rows.map(r  => ({ name: r.category,   total: Math.round(Number(r.total)),  pct: totalExpenses>0 ? Math.round((Number(r.total)/totalExpenses)*100):0 })),
    top_merchants: topMerchants.rows.map(r => ({ name: r.name,       total: Math.round(Number(r.total)),  visits: Number(r.visits) })),
    budgets:       budgets.rows.map(b     => ({ name: b.name,         cap: Number(b.cap), spent: Math.round(Number(b.spent)), under: Number(b.spent)<=Number(b.cap), pct: b.cap>0?Math.round((Number(b.spent)/Number(b.cap))*100):0 })),
    net_worth:     netWorthSnap.rows[0]   ? Math.round(Number(netWorthSnap.rows[0].net_worth)) : null,
    goals:         goals.rows.map(g       => ({ name: g.name, type: g.type, target: Number(g.target_amount), current: Number(g.current_amount), pct: g.target_amount>0?Math.round((Number(g.current_amount)/Number(g.target_amount))*100):0 })),
    health_score:  health?.score || null,
    health_grade:  health?.grade || null,
    health_label:  health?.label || null,
    narrative:     null,
  }

  if (apiKey) {
    const client = new Anthropic({ apiKey })
    const ai = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 300,
      messages: [{ role: 'user', content: `3-4 sentence honest monthly summary. Specific numbers. Most important thing. Don't moralize.\nMonth: ${monthName}\nIncome: $${reportData.total_income}, Expenses: $${reportData.total_expenses}, Net: $${reportData.net_savings} (${savingsRate}% saved)\nTop spend: ${reportData.by_category[0]?.name} $${reportData.by_category[0]?.total}` }]
    })
    reportData.narrative = ai.content[0].text.trim()
  }

  return reportData
}

function fmt(n) { return Number(n||0).toLocaleString('en-US', { maximumFractionDigits: 0 }) }

function buildReportHtml(d) {
  const green = '#5dcaa5', debt = '#e87363', warn = '#f0b04c', ink = '#1a1f2e', inkLight = '#6b7280'
  const budgetRows = d.budgets.map(b => `
    <tr>
      <td>${b.name}</td>
      <td>$${fmt(b.cap)}</td>
      <td style="color:${b.under ? green : debt}">$${fmt(b.spent)}</td>
      <td>
        <div style="background:#e5e7eb;border-radius:4px;height:6px;width:80px;">
          <div style="background:${b.under ? green : debt};width:${Math.min(100,b.pct)}%;height:100%;border-radius:4px;"></div>
        </div>
      </td>
      <td style="color:${b.under ? green : debt};font-weight:600">${b.under ? '✓' : `${b.pct}%`}</td>
    </tr>`).join('')

  const categoryRows = d.by_category.map(c => `
    <tr>
      <td>${c.name}</td>
      <td style="text-align:right">$${fmt(c.total)}</td>
      <td style="text-align:right;color:${inkLight}">${c.pct}%</td>
    </tr>`).join('')

  const merchantRows = d.top_merchants.map((m,i) => `
    <tr>
      <td style="color:${inkLight}">#${i+1}</td>
      <td>${m.name}</td>
      <td style="text-align:right">${m.visits}×</td>
      <td style="text-align:right;font-weight:600">$${fmt(m.total)}</td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Lumen Report — ${d.month}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Figtree', -apple-system, sans-serif; color: ${ink}; background: #fff; font-size: 13px; line-height: 1.5; }
  .page { max-width: 760px; margin: 0 auto; padding: 48px 40px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 36px; padding-bottom: 24px; border-bottom: 2px solid ${green}; }
  .logo { font-size: 22px; font-weight: 800; color: ${green}; letter-spacing: -0.5px; }
  .logo span { color: ${ink}; }
  .month-title { font-size: 14px; color: ${inkLight}; margin-top: 3px; }
  .generated { font-size: 10px; color: ${inkLight}; text-align: right; }

  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-card { background: #f9fafb; border-radius: 10px; padding: 14px; }
  .summary-card .val { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .summary-card .lbl { font-size: 10px; color: ${inkLight}; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }

  .narrative { background: #f0fdf8; border-left: 3px solid ${green}; padding: 14px 18px; margin-bottom: 32px; border-radius: 0 8px 8px 0; font-size: 13px; line-height: 1.7; color: #374151; }

  section { margin-bottom: 32px; }
  h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px; color: ${inkLight}; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #e5e7eb; }

  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 8px 6px; border-bottom: 1px solid #f3f4f6; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .4px; color: ${inkLight}; font-weight: 600; }

  .health-badge { display: inline-flex; align-items: center; gap: 8px; background: #f0fdf8; border: 1px solid #a7f3d0; border-radius: 20px; padding: 6px 14px; }
  .health-score { font-size: 20px; font-weight: 900; color: ${green}; font-variant-numeric: tabular-nums; }
  .health-grade { font-size: 16px; font-weight: 800; color: ${green}; }
  .health-label { font-size: 12px; color: ${inkLight}; }

  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 10px; color: ${inkLight}; display: flex; justify-content: space-between; }

  @media print {
    body { font-size: 12px; }
    .page { padding: 0; max-width: 100%; }
    .no-print { display: none !important; }
    @page { margin: 1.5cm 2cm; }
  }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div>
      <div class="logo">Lumen<span> · Financial Report</span></div>
      <div class="month-title">${d.month}</div>
    </div>
    <div class="generated">
      Generated ${new Date().toLocaleDateString('en-US', { month:'long',day:'numeric',year:'numeric' })}
    </div>
  </div>

  <!-- Summary -->
  <div class="summary-grid">
    <div class="summary-card">
      <div class="val" style="color:${green}">$${fmt(d.total_income)}</div>
      <div class="lbl">Income</div>
    </div>
    <div class="summary-card">
      <div class="val" style="color:${debt}">$${fmt(d.total_expenses)}</div>
      <div class="lbl">Expenses</div>
    </div>
    <div class="summary-card">
      <div class="val" style="color:${d.net_savings >= 0 ? green : debt}">${d.net_savings >= 0 ? '+' : ''}$${fmt(Math.abs(d.net_savings))}</div>
      <div class="lbl">Net Saved</div>
    </div>
    <div class="summary-card">
      <div class="val" style="color:${d.savings_rate >= 20 ? green : d.savings_rate >= 10 ? warn : debt}">${d.savings_rate}%</div>
      <div class="lbl">Savings Rate</div>
    </div>
  </div>

  ${d.narrative ? `<div class="narrative">${d.narrative}</div>` : ''}

  ${d.health_score != null ? `
  <section>
    <h2>Financial Health</h2>
    <div class="health-badge">
      <span class="health-score">${d.health_score}</span>
      <span class="health-grade">${d.health_grade}</span>
      <span class="health-label">${d.health_label}</span>
    </div>
  </section>` : ''}

  ${d.budgets.length > 0 ? `
  <section>
    <h2>Budget Performance</h2>
    <table>
      <thead><tr><th>Category</th><th>Budget</th><th>Spent</th><th>Progress</th><th>Status</th></tr></thead>
      <tbody>${budgetRows}</tbody>
    </table>
  </section>` : ''}

  ${d.by_category.length > 0 ? `
  <section>
    <h2>Spending by Category</h2>
    <table>
      <thead><tr><th>Category</th><th style="text-align:right">Total</th><th style="text-align:right">% of Spend</th></tr></thead>
      <tbody>${categoryRows}</tbody>
    </table>
  </section>` : ''}

  ${d.top_merchants.length > 0 ? `
  <section>
    <h2>Top Merchants</h2>
    <table>
      <thead><tr><th></th><th>Merchant</th><th style="text-align:right">Visits</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${merchantRows}</tbody>
    </table>
  </section>` : ''}

  ${d.net_worth != null ? `
  <section>
    <h2>Net Worth</h2>
    <div style="font-size:24px;font-weight:800;color:${d.net_worth >= 0 ? green : debt}">${d.net_worth >= 0 ? '' : '−'}$${fmt(Math.abs(d.net_worth))}</div>
  </section>` : ''}

  ${d.goals.length > 0 ? `
  <section>
    <h2>Goals</h2>
    ${d.goals.map(g => `
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
        <span>${g.name}</span>
        <span style="color:${inkLight}">$${fmt(g.current)} / $${fmt(g.target)} (${g.pct}%)</span>
      </div>
      <div style="background:#e5e7eb;border-radius:4px;height:6px;">
        <div style="background:${green};width:${Math.min(100,g.pct)}%;height:100%;border-radius:4px;"></div>
      </div>
    </div>`).join('')}
  </section>` : ''}

  <div class="footer">
    <span>Lumen · Personal Finance Intelligence</span>
    <span>${d.month} Report</span>
  </div>

  <div class="no-print" style="text-align:center;margin-top:32px;">
    <button onclick="window.print()" style="background:${green};color:#fff;border:none;padding:10px 28px;border-radius:8px;font-size:14px;cursor:pointer;font-weight:600;">
      Download PDF
    </button>
  </div>

</div>
</body>
</html>`
}

module.exports = router
