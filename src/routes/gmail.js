const express     = require('express')
const router      = express.Router()
const { google }  = require('googleapis')
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// ── OAuth2 client factory ──────────────────────────────────────
// Called fresh each request so env vars are always current
function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI   // e.g. https://your-api.railway.app/api/gmail/callback
  )
}

// Scopes — readonly is sufficient for everything we need.
// gmail.readonly triggers Google's verification process; during dev
// add your Google account as a test user in the OAuth consent screen.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
]

// ── GET /api/gmail/debug ──────────────────────────────────────
// Temporary — shows exactly what redirect URI the server is using
// Remove this after OAuth is confirmed working
router.get('/debug', requireAuth, (req, res) => {
  res.json({
    GOOGLE_CLIENT_ID:     process.env.GOOGLE_CLIENT_ID     ? process.env.GOOGLE_CLIENT_ID.slice(0, 20) + '...' : 'NOT SET',
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'NOT SET',
    GOOGLE_REDIRECT_URI:  process.env.GOOGLE_REDIRECT_URI  || 'NOT SET',
    FRONTEND_URL:         process.env.FRONTEND_URL          || 'NOT SET',
  })
})

// ── GET /api/gmail/auth-url ────────────────────────────────────
// Frontend calls this, then redirects the user to the returned URL.
// We encode the JWT in the state param so we know which user is
// coming back after Google redirects them.
router.get('/auth-url', requireAuth, (req, res) => {
  try {
    const oauth2Client = makeOAuth2Client()
    const url = oauth2Client.generateAuthUrl({
      access_type:  'offline',      // gets a refresh_token
      prompt:       'consent',      // forces refresh_token even if already authorized
      scope:        SCOPES,
      state:        req.headers.authorization?.replace('Bearer ', '') || '',
    })
    res.json({ url })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/gmail/callback ────────────────────────────────────
// Google redirects here after the user grants permission.
// We exchange the code for tokens, store them, then redirect
// the user back to the frontend settings page.
router.get('/callback', async (req, res) => {
  const { code, state: token, error } = req.query

  if (error) {
    return res.redirect(
      `${process.env.FRONTEND_URL}/settings?gmail=error&reason=${encodeURIComponent(error)}`
    )
  }
  if (!code || !token) {
    return res.redirect(`${process.env.FRONTEND_URL}/settings?gmail=error&reason=missing_params`)
  }

  try {
    // Verify the JWT from state to identify the user
    const jwt        = require('jsonwebtoken')
    const decoded    = jwt.verify(token, process.env.JWT_SECRET)
    const userId     = decoded.id

    // Exchange auth code for tokens
    const oauth2Client = makeOAuth2Client()
    const { tokens }   = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)

    // Get their Gmail address
    const oauth2    = google.oauth2({ version: 'v2', auth: oauth2Client })
    const userInfo  = await oauth2.userinfo.get()
    const gmailAddr = userInfo.data.email

    // Upsert into gmail_tokens
    await pool.query(
      `INSERT INTO gmail_tokens
         (user_id, gmail_address, access_token, refresh_token, token_expiry, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         gmail_address = EXCLUDED.gmail_address,
         access_token  = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, gmail_tokens.refresh_token),
         token_expiry  = EXCLUDED.token_expiry,
         scope         = EXCLUDED.scope,
         connected_at  = NOW()`,
      [
        userId,
        gmailAddr,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        SCOPES.join(' '),
      ]
    )

    res.redirect(`${process.env.FRONTEND_URL}/settings?gmail=connected`)
  } catch (err) {
    console.error('[Gmail callback error]', err.message)
    res.redirect(
      `${process.env.FRONTEND_URL}/settings?gmail=error&reason=${encodeURIComponent(err.message)}`
    )
  }
})

// ── GET /api/gmail/status ──────────────────────────────────────
// Returns connection status for the current user.
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT gmail_address, connected_at, last_synced FROM gmail_tokens WHERE user_id=$1',
      [req.user.id]
    )
    if (!rows.length) return res.json({ connected: false })

    const row = rows[0]
    res.json({
      connected:     true,
      gmail_address: row.gmail_address,
      connected_at:  row.connected_at,
      last_synced:   row.last_synced,
    })
  } catch (err) {
    next(err)
  }
})

// ── DELETE /api/gmail/disconnect ──────────────────────────────
// Revokes the token at Google and deletes our stored copy.
router.delete('/disconnect', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT access_token FROM gmail_tokens WHERE user_id=$1',
      [req.user.id]
    )
    if (rows.length) {
      // Attempt revocation (best-effort — don't fail if Google rejects)
      try {
        const oauth2Client = makeOAuth2Client()
        await oauth2Client.revokeToken(rows[0].access_token)
      } catch (e) {
        console.warn('[Gmail revoke]', e.message)
      }
      await pool.query('DELETE FROM gmail_tokens WHERE user_id=$1', [req.user.id])
    }
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ── Exported helper — get a ready-to-use OAuth2 client for a user ──
// Used by future phases (phase 2 parsers, phase 4 context injection).
// Automatically refreshes the access token if expired.
async function getGmailClientForUser(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM gmail_tokens WHERE user_id=$1',
    [userId]
  )
  if (!rows.length) throw new Error('Gmail not connected for this user')

  const row          = rows[0]
  const oauth2Client = makeOAuth2Client()

  oauth2Client.setCredentials({
    access_token:  row.access_token,
    refresh_token: row.refresh_token,
    expiry_date:   row.token_expiry ? new Date(row.token_expiry).getTime() : null,
  })

  // Refresh token listener — persist new access token automatically
  oauth2Client.on('tokens', async (tokens) => {
    const updates = ['access_token=$1']
    const values  = [tokens.access_token]
    if (tokens.refresh_token) {
      updates.push('refresh_token=$2')
      values.push(tokens.refresh_token)
      updates.push(`token_expiry=$3`)
      values.push(tokens.expiry_date ? new Date(tokens.expiry_date) : null)
      values.push(userId)
    } else {
      updates.push(`token_expiry=$2`)
      values.push(tokens.expiry_date ? new Date(tokens.expiry_date) : null)
      values.push(userId)
    }
    await pool.query(
      `UPDATE gmail_tokens SET ${updates.join(', ')} WHERE user_id=$${values.length}`,
      values
    )
  })

  return oauth2Client
}

module.exports = router
module.exports.getGmailClientForUser = getGmailClientForUser

// ── Phase 2 — Scan endpoints ──────────────────────────────────
const { scanSubscriptions, scanOrders, scanBills } = require('./gmail-parser')

// POST /api/gmail/scan/subscriptions — scan Gmail and store results
router.post('/scan/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const result = await scanSubscriptions(req.user.id)
    const { rows } = await pool.query(
      "SELECT * FROM gmail_subscriptions WHERE user_id=$1 AND status='active' ORDER BY next_renewal ASC NULLS LAST",
      [req.user.id]
    )
    res.json({ ...result, subscriptions: rows })
  } catch (err) {
    if (err.message.includes('not connected')) return res.status(400).json({ error: 'Gmail not connected' })
    next(err)
  }
})

// GET /api/gmail/subscriptions — fetch stored subscriptions
router.get('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM gmail_subscriptions WHERE user_id=$1 AND status='active' ORDER BY next_renewal ASC NULLS LAST",
      [req.user.id]
    )
    res.json({ subscriptions: rows })
  } catch (err) { next(err) }
})

// PATCH /api/gmail/subscriptions/:id — update status
router.patch('/subscriptions/:id', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body
    const { rows } = await pool.query(
      'UPDATE gmail_subscriptions SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [status, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/gmail/scan/orders — scan Gmail and store results
router.post('/scan/orders', requireAuth, async (req, res, next) => {
  try {
    const result = await scanOrders(req.user.id)
    const { rows } = await pool.query(
      "SELECT * FROM gmail_orders WHERE user_id=$1 AND status='active' ORDER BY order_date DESC",
      [req.user.id]
    )
    res.json({ ...result, orders: rows })
  } catch (err) {
    if (err.message.includes('not connected')) return res.status(400).json({ error: 'Gmail not connected' })
    next(err)
  }
})

// GET /api/gmail/orders — fetch stored orders
router.get('/orders', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM gmail_orders WHERE user_id=$1 AND status='active' ORDER BY order_date DESC LIMIT 30",
      [req.user.id]
    )
    res.json({ orders: rows })
  } catch (err) { next(err) }
})

// PATCH /api/gmail/orders/:id — dismiss
router.patch('/orders/:id', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body
    const { rows } = await pool.query(
      'UPDATE gmail_orders SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING *',
      [status, req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// POST /api/gmail/scan/bills — live scan, no storage
router.post('/scan/bills', requireAuth, async (req, res, next) => {
  try {
    const result = await scanBills(req.user.id)
    res.json(result)
  } catch (err) {
    if (err.message.includes('not connected')) return res.status(400).json({ error: 'Gmail not connected' })
    next(err)
  }
})
