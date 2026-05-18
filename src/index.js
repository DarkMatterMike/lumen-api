require('dotenv').config()
const express    = require('express')
const cors       = require('cors')
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

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` })
})

app.use(errorHandler)

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`🚀 Lumen API running on port ${PORT}`)
})
