require('dotenv').config()
const express = require('express')
const cors = require('cors')
const errorHandler = require('./middleware/errorHandler')

// Route files
const dashboardRoutes     = require('./routes/dashboard')
const accountsRoutes      = require('./routes/accounts')
const transactionsRoutes  = require('./routes/transactions')
const budgetsRoutes       = require('./routes/budgets')
const calendarRoutes      = require('./routes/calendar')
const analyticsRoutes     = require('./routes/analytics')

const app = express()

// ── Middleware ──────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))
app.use(express.json())

// ── Health check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── Routes ──────────────────────────────────────────────────
app.use('/api/dashboard',    dashboardRoutes)
app.use('/api/accounts',     accountsRoutes)
app.use('/api/transactions', transactionsRoutes)
app.use('/api/budgets',      budgetsRoutes)
app.use('/api/calendar',     calendarRoutes)
app.use('/api/analytics',    analyticsRoutes)

// ── 404 handler ─────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` })
})

// ── Error handler (must be last) ────────────────────────────
app.use(errorHandler)

// ── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`🚀 Lumen API running on port ${PORT}`)
  console.log(`   Health: http://localhost:${PORT}/api/health`)
})
