const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const crypto   = require('crypto')
const { google } = require('googleapis')
const pool     = require('../db/pool')
const { sendWelcome } = require('../utils/email')
const requireAuth = require('../middleware/requireAuth')

// ── Constants ─────────────────────────────────────────────────
// 1 hour access token — mobile browsers suspend JS timers when backgrounded,
// so a 15-min token expires before the proactive refresh fires.
// The refresh cookie is the security boundary (7 days, httpOnly, SameSite:none).
// A longer-lived access token just means fewer round trips to Railway.
const ACCESS_TTL   = '1h'
const REFRESH_7DAY = 7  * 24 * 60 * 60 * 1000   // 7 days remember me
const REFRESH_1DAY = 1  * 24 * 60 * 60 * 1000   // 1 day  no remember me
const MAX_FAILS    = 10
const LOCK_MIN     = 15

// Google OAuth2 client for login (separate redirect URI from Gmail)
function getLoginOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_LOGIN_REDIRECT_URI  // e.g. https://your-api.railway.app/api/auth/google/callback
  )
}

// ── Cookie config ─────────────────────────────────────────────
// COOKIE_SECURE=true must be set in Railway env vars
// On Railway, RAILWAY_ENVIRONMENT is always set. Use that as the production signal
// rather than NODE_ENV which is often not configured explicitly.
const IS_SECURE = process.env.COOKIE_SECURE === 'true'
  || process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT

// ── Token helpers ─────────────────────────────────────────────
function makeAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role || 'user' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  )
}

function makeRefreshToken() {
  return crypto.randomBytes(48).toString('hex')
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function setRefreshCookie(res, token, ttl) {
  res.cookie('lumen_refresh', token, {
    httpOnly: true,
    secure:   IS_SECURE,
    sameSite: IS_SECURE ? 'none' : 'lax',
    maxAge:   ttl,   // always explicit — never undefined
    path:     '/',
  })
}

function clearRefreshCookie(res) {
  res.clearCookie('lumen_refresh', {
    path:     '/',
    secure:   IS_SECURE,
    sameSite: IS_SECURE ? 'none' : 'lax',
  })
}

async function issueSession(res, userId, email, name, ttl, ip, ua) {
  // Fetch role so it's included in the access token
  const { rows: roleRows } = await pool.query(
    'SELECT role FROM users WHERE id = $1', [userId]
  )
  const role = roleRows[0]?.role || 'user'

  const refresh = makeRefreshToken()
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, hashToken(refresh), new Date(Date.now() + ttl), ip, ua]
  )
  setRefreshCookie(res, refresh, ttl)
  return makeAccessToken({ id: userId, email, role })
}

// ── Password validation ───────────────────────────────────────
function validatePassword(pw) {
  if (!pw || pw.length < 10)     return 'Password must be at least 10 characters'
  if (!/[A-Z]/.test(pw))         return 'Password must contain an uppercase letter'
  if (!/[0-9]/.test(pw))         return 'Password must contain a number'
  if (!/[^A-Za-z0-9]/.test(pw))  return 'Password must contain a special character'
  return null
}

// ── Lockout helpers ───────────────────────────────────────────
async function checkLockout(email) {
  const { rows } = await pool.query(
    'SELECT locked_until FROM users WHERE email=$1', [email.toLowerCase()]
  )
  if (!rows.length) return
  if (rows[0].locked_until && new Date(rows[0].locked_until) > new Date()) {
    const mins = Math.ceil((new Date(rows[0].locked_until) - new Date()) / 60000)
    const err  = new Error(`Account locked. Try again in ${mins} minute${mins===1?'':'s'}.`)
    err.status = 429
    throw err
  }
}

async function recordFail(email, ip) {
  await pool.query(
    `UPDATE users
     SET failed_attempts = failed_attempts + 1,
         locked_until = CASE WHEN failed_attempts + 1 >= $1
                         THEN NOW() + ($2 || ' minutes')::INTERVAL
                         ELSE locked_until END
     WHERE email=$3`,
    [MAX_FAILS, LOCK_MIN, email.toLowerCase()]
  )
  await pool.query(
    'INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,FALSE)',
    [email.toLowerCase(), ip]
  )
}

async function recordSuccess(userId, email, ip) {
  await pool.query(
    'UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1', [userId]
  )
  await pool.query(
    'INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,TRUE)',
    [email.toLowerCase(), ip]
  )
}

// ══════════════════════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════════════════════

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, terms_agreed } = req.body
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' })
    if (!terms_agreed)
      return res.status(400).json({ error: 'You must agree to the Terms of Service' })

    const pwErr = validatePassword(password)
    if (pwErr) return res.status(400).json({ error: pwErr })

    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()])
    if (existing.rows.length)
      return res.status(409).json({ error: 'An account with that email already exists' })

    const hash = await bcrypt.hash(password, 12)
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, oauth_provider, terms_agreed_at, terms_version, privacy_agreed_at)
       VALUES ($1,$2,$3,'local',NOW(),'1.0',NOW()) RETURNING id, email, name`,
      [email.toLowerCase(), hash, name || null]
    )
    const user = rows[0]
    const token = await issueSession(res, user.id, user.email, user.name, REFRESH_7DAY, req.ip, req.get('user-agent'))
    // Fetch role to include in response
    const { rows: roleCheck } = await pool.query('SELECT role FROM users WHERE id=$1', [user.id])
    res.status(201).json({ token, user: { ...user, role: roleCheck[0]?.role || 'user' } })
  } catch (err) { next(err) }
})

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password, rememberMe = true } = req.body
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' })

    await checkLockout(email)

    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash, oauth_provider, locked FROM users WHERE email=$1',
      [email.toLowerCase()]
    )
    const user = rows[0]

    // Block password login for Google-only accounts
    if (user && user.oauth_provider === 'google' && !user.password_hash) {
      return res.status(400).json({ error: 'This account uses Google Sign-In. Please use the Google button.' })
    }

    const valid = user ? await bcrypt.compare(password, user.password_hash) : false
    if (!user || !valid) {
      if (user) await recordFail(email, req.ip)
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    // Block locked accounts
    if (user.locked) {
      return res.status(403).json({ error: 'This account has been suspended.' })
    }

    await recordSuccess(user.id, email, req.ip)

    // rememberMe=true → 7 days, false → 1 day (session)
    const ttl = rememberMe ? REFRESH_7DAY : REFRESH_1DAY
    const token = await issueSession(res, user.id, user.email, user.name, ttl, req.ip, req.get('user-agent'))
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role || 'user' } })
  } catch (err) { next(err) }
})

// ── GET /api/auth/google/redirect ────────────────────────────
// Redirects the browser to Google's OAuth consent page
router.get('/google/redirect', (req, res) => {
  const oauth2 = getLoginOAuth2Client()
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt:      'select_account',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  })
  res.redirect(url)
})

// ── GET /api/auth/google/callback ─────────────────────────────
router.get('/google/callback', async (req, res, next) => {
  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173'
  try {
    const { code, error } = req.query

    console.log('[Google callback] code present:', !!code, 'error:', error)
    console.log('[Google callback] GOOGLE_LOGIN_REDIRECT_URI:', process.env.GOOGLE_LOGIN_REDIRECT_URI)
    console.log('[Google callback] GOOGLE_CLIENT_ID set:', !!process.env.GOOGLE_CLIENT_ID)
    console.log('[Google callback] GOOGLE_CLIENT_SECRET set:', !!process.env.GOOGLE_CLIENT_SECRET)

    if (error || !code) {
      console.error('[Google callback] No code or error param:', error)
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent(error || 'Google sign-in was cancelled')}`)
    }

    const oauth2 = getLoginOAuth2Client()
    console.log('[Google callback] Exchanging code for tokens...')

    let tokens
    try {
      const result = await oauth2.getToken(code)
      tokens = result.tokens
      console.log('[Google callback] Tokens received, id_token present:', !!tokens.id_token)
    } catch (tokenErr) {
      console.error('[Google callback] Token exchange failed:', tokenErr.message)
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Failed to exchange Google code: ' + tokenErr.message)}`)
    }

    oauth2.setCredentials(tokens)

    let data
    try {
      const userInfoApi = google.oauth2({ version: 'v2', auth: oauth2 })
      const response = await userInfoApi.userinfo.get()
      data = response.data
      console.log('[Google callback] User info received, email:', data.email)
    } catch (profileErr) {
      console.error('[Google callback] Profile fetch failed:', profileErr.message)
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Failed to get Google profile')}`)
    }

    const { id: googleId, email, name, picture } = data

    if (!email) {
      console.error('[Google callback] No email in Google profile')
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Google account has no email address')}`)
    }

    // Find or create user
    let { rows } = await pool.query(
      'SELECT id, email, name, google_id FROM users WHERE google_id=$1 OR email=$2 LIMIT 1',
      [googleId, email.toLowerCase()]
    )
    let user = rows[0]
    console.log('[Google callback] Existing user found:', !!user)

    if (!user) {
      // Check if terms/privacy columns exist before inserting
      const { rows: newRows } = await pool.query(
        `INSERT INTO users (email, name, google_id, google_email, google_name, google_avatar, oauth_provider)
         VALUES ($1,$2,$3,$4,$5,$6,'google')
         RETURNING id, email, name`,
        [email.toLowerCase(), name || email.split('@')[0], googleId, email.toLowerCase(), name, picture]
      )
      user = newRows[0]
      console.log('[Google callback] New user created:', user.id)
      // Welcome email for new Google signups
      sendWelcome({ email: user.email, name: user.name }).catch(() => {})
    } else if (!user.google_id) {
      await pool.query(
        `UPDATE users SET google_id=$1, google_email=$2, google_name=$3, google_avatar=$4 WHERE id=$5`,
        [googleId, email.toLowerCase(), name, picture, user.id]
      )
      console.log('[Google callback] Linked Google to existing user:', user.id)
    }

    const accessToken = await issueSession(res, user.id, user.email, user.name, REFRESH_7DAY, req.ip, req.get('user-agent'))
    console.log('[Google callback] Session issued, redirecting to frontend')

    res.redirect(`${FRONTEND}/?google_token=${encodeURIComponent(accessToken)}`)
  } catch (err) {
    console.error('[Google callback] Unhandled error:', err.message, err.stack)
    res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Sign-in failed: ' + err.message)}`)
  }
})

// ── POST /api/auth/refresh ────────────────────────────────────
// NO ROTATION — validate the refresh token and issue a new access token.
// Rotation was the root cause of random logouts: any race condition between
// concurrent tabs or network retries would invalidate the current cookie.
// The refresh token stays stable for its full 7-day life.
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.lumen_refresh
    if (!token) return res.status(401).json({ error: 'No refresh token' })

    const { rows } = await pool.query(
      `SELECT rt.user_id, rt.expires_at,
              u.email, u.name, u.role, u.locked
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
         AND rt.revoked = FALSE
         AND rt.expires_at > NOW()`,
      [hashToken(token)]
    )

    if (!rows.length) {
      clearRefreshCookie(res)
      return res.status(401).json({ error: 'Session expired. Please log in again.' })
    }

    // Account locked by admin
    if (rows[0].locked) {
      clearRefreshCookie(res)
      return res.status(401).json({ error: 'Account has been suspended.' })
    }

    const row  = rows[0]
    const user = { id: row.user_id, email: row.email, name: row.name, role: row.role || 'user' }

    // Just issue a fresh 15-min access token. Cookie stays the same.
    res.json({ token: makeAccessToken(user), user })
  } catch (err) { next(err) }
})

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    const token = req.cookies?.lumen_refresh
    if (token) {
      await pool.query(
        'UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1',
        [hashToken(token)]
      )
    }
    clearRefreshCookie(res)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── POST /api/auth/logout-all ─────────────────────────────────
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1', [req.user.id]
    )
    clearRefreshCookie(res)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── GET /api/auth/sessions ────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ip, user_agent, created_at, expires_at
       FROM refresh_tokens
       WHERE user_id=$1 AND revoked=FALSE AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    )
    res.json({ sessions: rows })
  } catch (err) { next(err) }
})

// ── PATCH /api/auth/me/onboarding ────────────────────────────
router.patch('/me/onboarding', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE users SET onboarding_complete = TRUE WHERE id = $1',
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, google_avatar, oauth_provider, created_at, onboarding_complete FROM users WHERE id=$1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
