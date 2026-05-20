require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
const pool       = require('./db/pool')
const errorHandler = require('./middleware/errorHandler')

const authRoutes         = require('./routes/auth')
const dashboardRoutes    = require('./routes/dashboard')
const accountsRoutes     = require('./routes/accounts')
const transactionsRoutes = require('./routes/transactions')
const budgetsRoutes      = require('./routes/budgets')
const calendarRoutes     = require('./routes/calendar')
const analyticsRoutes    = require('./routes/analytics')
const plaidRoutes        = require('./routes/plaid')
const settingsRoutes     = require('./routes/settings')
const lumenRoutes        = require('./routes/lumen')
const rulesRoutes        = require('./routes/rules')
const plansRoutes        = require('./routes/plans')
const gmailRoutes        = require('./routes/gmail')
const notificationsRoutes = require('./routes/notifications')
const goalsRoutes         = require('./routes/goals')
const importRoutes        = require('./routes/import')
const duplicatesRoutes    = require('./routes/duplicates')
const forecastRoutes      = require('./routes/forecast')

const { syncTransactionsForUser } = require('./routes/plaid')
const { applyRulesToUser }        = require('./routes/rules')
const { syncGmailForUser, runPhase5 } = require('./routes/gmail-parser')
const { checkPaceAlerts, autoCompleteCategories } = require('./utils/budgetIntelligence')
const { runCashFlowAlerts } = require('./utils/cashFlowForecast')

const app = express()

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json())

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api/auth',         authRoutes)
app.use('/api/plaid',        plaidRoutes)
app.use('/api/dashboard',    dashboardRoutes)
app.use('/api/accounts',     accountsRoutes)
app.use('/api/transactions', transactionsRoutes)
app.use('/api/budgets',      budgetsRoutes)
app.use('/api/calendar',     calendarRoutes)
app.use('/api/analytics',    analyticsRoutes)
app.use('/api/settings',     settingsRoutes)
app.use('/api/lumen',        lumenRoutes)
app.use('/api/rules',        rulesRoutes)
app.use('/api/plans',        plansRoutes)
app.use('/api/gmail',        gmailRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/goals',        goalsRoutes)
app.use('/api/import',       importRoutes)
app.use('/api/duplicates',   duplicatesRoutes)
app.use('/api/forecast',     forecastRoutes)

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` })
})

app.use(errorHandler)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`🚀 Lumen API running on port ${PORT}`)
})

// ── Hourly Plaid sync + rules application ──────────────────────
// Runs once per hour for every connected user; no external packages required
setInterval(async () => {
  console.log('[Cron] Starting hourly transaction sync...')
  try {
    // Get all users — union plaid users + any users with manual transactions
    const { rows: plaidUsers } = await pool.query('SELECT DISTINCT user_id FROM plaid_items')
    const { rows: allUsers }   = await pool.query('SELECT DISTINCT id AS user_id FROM users')
    const userIds = [...new Set([...plaidUsers.map(u => u.user_id), ...allUsers.map(u => u.user_id)])]

    for (const user_id of userIds) {
      // Plaid sync (only if connected)
      const added = await syncTransactionsForUser(user_id).catch(() => 0)
      if (added > 0) {
        await applyRulesToUser(user_id)
        console.log(`[Cron] user ${user_id}: +${added} transactions, rules applied`)
        await syncGmailForUser(user_id).catch(e => console.warn('[Cron Gmail]', e.message))
        await runPhase5(user_id).catch(e => console.warn('[Cron P5]', e.message))
      }

      // Phase C — budget intelligence (runs for ALL users every hour)
      await checkPaceAlerts(user_id).catch(e => console.warn('[Cron PaceAlerts]', e.message))
      await autoCompleteCategories(user_id).catch(e => console.warn('[Cron AutoComplete]', e.message))
      await runCashFlowAlerts(user_id).catch(e => console.warn('[Cron CashFlow]', e.message))
    }
  } catch (err) {
    console.error('[Cron] Hourly sync error:', err.message)
  }
}, 60 * 60 * 1000) // every hour
