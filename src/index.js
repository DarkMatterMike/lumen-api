require('dotenv').config()
const express    = require('express')
const cors        = require('cors')
const helmet      = require('helmet')
const rateLimit   = require('express-rate-limit')
const cookieParser = require('cookie-parser')
const pool        = require('./db/pool')
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
const pendingRoutes      = require('./routes/pending')
const notificationsRoutes = require('./routes/notifications')
const { createNotification } = require('./routes/notifications')
const goalsRoutes         = require('./routes/goals')
const importRoutes        = require('./routes/import')
const duplicatesRoutes    = require('./routes/duplicates')
const forecastRoutes      = require('./routes/forecast')
const debtRoutes          = require('./routes/debt')
const documentsRoutes     = require('./routes/documents')
const learnRoutes         = require('./routes/learn')
const insightsRoutes      = require('./routes/insights')
const pushRoutes          = require('./routes/push')
const reportsRoutes       = require('./routes/reports')
const exportRoutes        = require('./routes/export')
const recurringDetectRoute = require('./routes/recurringDetect')
const daniRoutes          = require('./routes/dani')
const adminRoutes         = require('./routes/admin')
const billingRoutes       = require('./routes/billing')
const familyRoutes        = require('./routes/family')

const { syncTransactionsForUser } = require('./routes/plaid')
const { applyRulesToUser }        = require('./routes/rules')
const { syncGmailForUser, runPhase5 } = require('./routes/gmail-parser')
const { checkPaceAlerts, autoCompleteCategories } = require('./utils/budgetIntelligence')
const { runCashFlowAlerts }      = require('./utils/cashFlowForecast')
const { runAllProactiveAlerts }   = require('./utils/proactiveAlerts')
const { detectPayoffOpportunities } = require('./utils/debtStrategy')
const { runAllLearning }              = require('./utils/learningEngine')
const { snapshotNetWorth }            = require('./utils/netWorthTrajectory')
const { generateDna }                 = require('./utils/spendingDna')
const { recomputeSuppressions }       = require('./utils/notificationIntelligence')
const { pushPendingNotifications }    = require('./routes/push')

const app = express()

// ── Trust proxy — required on Railway/Render/Fly/Heroku ────────
// Without this, req.ip is always the load balancer IP, causing ALL users
// to share one rate-limit bucket and randomly locking everyone out.
app.set('trust proxy', 1)

// ── S1 Security ─────────────────────────────────────────────
// Helmet — 11 security headers in one line
app.use(helmet({ contentSecurityPolicy: false }))  // CSP off — API-only, no HTML served

// ── cookieParser MUST come before everything that reads cookies ──
// This includes rate limiters and all routes. If it's after them,
// req.cookies is undefined and refresh tokens are never read.
app.use(cookieParser())

// ── CORS MUST come before rate limiters ──
// Browser sends OPTIONS preflight before every cross-origin POST.
// If rate limiters run first they can reject the preflight before
// CORS headers are set, causing the browser to block the request.
app.use(cors({
  origin: (origin, cb) => {
    const allowed = process.env.FRONTEND_URL
    // Allow requests with no origin (mobile apps, Postman, curl) in dev
    if (!origin || !allowed) return cb(null, true)
    if (origin === allowed) return cb(null, true)
    cb(new Error('CORS: origin not allowed'))
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposedHeaders: ['Set-Cookie'],
  credentials: true,
}))

// Body parsing
app.use(express.json({ limit: '2mb' }))

// Rate limiting — auth endpoints are stricter
// /api/auth/refresh is intentionally excluded: it fires proactively every ~13 min
// and must never be rate-limited by IP (cloud proxies collapse all users to one IP).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                    // 20 attempts per window (login/register/me only)
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/refresh' || req.path === '/me',
})
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 200,              // 200 req/min per IP
  message: { error: 'Too many requests.' },
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
})
app.use('/api/auth', authLimiter)
app.use('/api', apiLimiter)

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
app.use('/api/pending',      pendingRoutes)
app.use('/api/notifications', notificationsRoutes)
app.use('/api/goals',        goalsRoutes)
app.use('/api/import',       importRoutes)
app.use('/api/duplicates',   duplicatesRoutes)
app.use('/api/forecast',     forecastRoutes)
app.use('/api/debt',         debtRoutes)
app.use('/api/documents',    documentsRoutes)
app.use('/api/learn',        learnRoutes)
app.use('/api/insights',     insightsRoutes)
app.use('/api/push',         pushRoutes)
app.use('/api/reports',      reportsRoutes)
app.use('/api/export',       exportRoutes)
app.use('/api/recurring-detect', recurringDetectRoute)
app.use('/api/dani',         daniRoutes)
app.use('/api/billing',      billingRoutes)
app.use('/api/family',       familyRoutes)
app.use('/api/admin',        adminRoutes)

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
        // Notify user of new transactions
        await createNotification(user_id, {
          type:  'insight',
          title: `${added} new transaction${added > 1 ? 's' : ''} synced`,
          body:  `${added} new transaction${added > 1 ? 's have' : ' has'} been imported from your bank.`,
          icon:  '🔄',
        }).catch(() => {})
      }

      // Phase C — budget intelligence (runs for ALL users every hour)
      await checkPaceAlerts(user_id).catch(e => console.warn('[Cron PaceAlerts]', e.message))
      await autoCompleteCategories(user_id).catch(e => console.warn('[Cron AutoComplete]', e.message))
      await runCashFlowAlerts(user_id).catch(e => console.warn('[Cron CashFlow]', e.message))

      // Phase E — proactive alerts (anomaly, patterns, subscriptions, double billing)
      await runAllProactiveAlerts(user_id).catch(e => console.warn('[Cron ProactiveAlerts]', e.message))

      // Phase G — debt payoff opportunity detection
      await detectPayoffOpportunities(user_id).catch(e => console.warn('[Cron DebtOpps]', e.message))

      // Phase I — learning & personalization (health score, behavioral, adaptive, wins)
      await runAllLearning(user_id).catch(e => console.warn('[Cron Learning]', e.message))

      // Push pending high-priority notifications
      await pushPendingNotifications(user_id).catch(e => console.warn('[Cron Push]', e.message))

      // New features — net worth snapshot (weekly), DNA (monthly), suppression recompute (weekly)
      const todayDate = new Date()
      if (todayDate.getDay() === 1) { // Mondays
        await snapshotNetWorth(user_id).catch(e => console.warn('[Cron NetWorth]', e.message))
        await recomputeSuppressions(user_id).catch(e => console.warn('[Cron Suppression]', e.message))
      }
      if (todayDate.getDate() <= 2 && todayDate.getHours() < 4) { // 1st-2nd of month, early AM
        await generateDna(user_id).catch(e => console.warn('[Cron DNA]', e.message))
      }
    }
  } catch (err) {
    console.error('[Cron] Hourly sync error:', err.message)
  }
}, 60 * 60 * 1000) // every hour
