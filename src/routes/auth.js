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
// rememberMe=true  → 7-day refresh cookie + 7-day access token
//   The access token matching the cookie TTL means overnight expiry
//   is impossible — the token is alive for the full 7 days.
// rememberMe=false → 1-day refresh cookie + 1-hour access token
const ACCESS_TTL_SHORT  = '1h'
const ACCESS_TTL_LONG   = '7d'
const REFRESH_7DAY = 7  * 24 * 60 * 60 * 1000
const REFRESH_1DAY = 1  * 24 * 60 * 60 * 1000
const MAX_FAILS    = 10
const LOCK_MIN     = 15

function getLoginOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_LOGIN_REDIRECT_URI
  )
}

const IS_SECURE = process.env.COOKIE_SECURE === 'true'
  || process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT

function makeAccessToken(user, ttl) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role || 'user' },
    process.env.JWT_SECRET,
    { expiresIn: ttl }
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
    maxAge:   ttl,
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

// rememberMe controls both the cookie TTL and the access token TTL.
// When rememberMe=true the access token lives 7 days — matching the cookie —
// so there is no overnight expiry scenario possible.
async function issueSession(res, userId, email, name, rememberMe, ip, ua) {
  const { rows: roleRows } = await pool.query(
    'SELECT role FROM users WHERE id = $1', [userId]
  )
  const role = roleRows[0]?.role || 'user'

  const ttl     = rememberMe ? REFRESH_7DAY : REFRESH_1DAY
  const accTTL  = rememberMe ? ACCESS_TTL_LONG : ACCESS_TTL_SHORT

  const refresh = makeRefreshToken()
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, hashToken(refresh), new Date(Date.now() + ttl), ip, ua]
  )
  setRefreshCookie(res, refresh, ttl)
  return makeAccessToken({ id: userId, email, role }, accTTL)
}

function validatePassword(pw) {
  if (!pw || pw.length < 10)     return 'Password must be at least 10 characters'
  if (!/[A-Z]/.test(pw))         return 'Password must contain an uppercase letter'
  if (!/[0-9]/.test(pw))         return 'Password must contain a number'
  if (!/[^A-Za-z0-9]/.test(pw))  return 'Password must contain a special character'
  return null
}

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
    // New registrations always get 7-day remember-me
    const token = await issueSession(res, user.id, user.email, user.name, true, req.ip, req.get('user-agent'))
    const { rows: roleCheck } = await pool.query('SELECT role FROM users WHERE id=$1', [user.id])
    res.status(201).json({ token, user: { ...user, role: roleCheck[0]?.role || 'user' } })
  } catch (err) { next(err) }
})

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

    if (user && user.oauth_provider === 'google' && !user.password_hash) {
      return res.status(400).json({ error: 'This account uses Google Sign-In. Please use the Google button.' })
    }

    const valid = user ? await bcrypt.compare(password, user.password_hash) : false
    if (!user || !valid) {
      if (user) await recordFail(email, req.ip)
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    if (user.locked) {
      return res.status(403).json({ error: 'This account has been suspended.' })
    }

    await recordSuccess(user.id, email, req.ip)

    const token = await issueSession(res, user.id, user.email, user.name, rememberMe, req.ip, req.get('user-agent'))
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role || 'user' } })
  } catch (err) { next(err) }
})

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

router.get('/google/callback', async (req, res, next) => {
  const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173'
  try {
    const { code, error } = req.query
    if (error || !code) {
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent(error || 'Google sign-in was cancelled')}`)
    }

    const oauth2 = getLoginOAuth2Client()
    let tokens
    try {
      const result = await oauth2.getToken(code)
      tokens = result.tokens
    } catch (tokenErr) {
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Failed to exchange Google code: ' + tokenErr.message)}`)
    }

    oauth2.setCredentials(tokens)

    let data
    try {
      const userInfoApi = google.oauth2({ version: 'v2', auth: oauth2 })
      const response = await userInfoApi.userinfo.get()
      data = response.data
    } catch (profileErr) {
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Failed to get Google profile')}`)
    }

    const { id: googleId, email, name, picture } = data
    if (!email) {
      return res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Google account has no email address')}`)
    }

    let { rows } = await pool.query(
      'SELECT id, email, name, google_id FROM users WHERE google_id=$1 OR email=$2 LIMIT 1',
      [googleId, email.toLowerCase()]
    )
    let user = rows[0]

    if (!user) {
      const { rows: newRows } = await pool.query(
        `INSERT INTO users (email, name, google_id, google_email, google_name, google_avatar, oauth_provider)
         VALUES ($1,$2,$3,$4,$5,$6,'google')
         RETURNING id, email, name`,
        [email.toLowerCase(), name || email.split('@')[0], googleId, email.toLowerCase(), name, picture]
      )
      user = newRows[0]
      sendWelcome({ email: user.email, name: user.name }).catch(() => {})
    } else if (!user.google_id) {
      await pool.query(
        `UPDATE users SET google_id=$1, google_email=$2, google_name=$3, google_avatar=$4 WHERE id=$5`,
        [googleId, email.toLowerCase(), name, picture, user.id]
      )
    }

    // Google logins always get 7-day remember-me
    const accessToken = await issueSession(res, user.id, user.email, user.name, true, req.ip, req.get('user-agent'))
    res.redirect(`${FRONTEND}/?google_token=${encodeURIComponent(accessToken)}`)
  } catch (err) {
    res.redirect(`${FRONTEND}/?auth_error=${encodeURIComponent('Sign-in failed: ' + err.message)}`)
  }
})

// POST /api/auth/refresh
// Validates the httpOnly refresh cookie and issues a new access token.
// The access token TTL matches the remaining life of the refresh cookie
// so a remembered user never gets logged out mid-session.
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

    if (rows[0].locked) {
      clearRefreshCookie(res)
      return res.status(401).json({ error: 'Account has been suspended.' })
    }

    const row  = rows[0]
    const user = { id: row.user_id, email: row.email, name: row.name, role: row.role || 'user' }

    // Issue access token whose TTL matches how much time is left on the refresh cookie.
    // This prevents the "token expired but cookie still valid" overnight logout scenario.
    const msLeft = new Date(row.expires_at) - Date.now()
    const secsLeft = Math.floor(msLeft / 1000)
    const accTTL = secsLeft > 0 ? `${secsLeft}s` : ACCESS_TTL_SHORT

    res.json({ token: makeAccessToken(user, accTTL), user })
  } catch (err) { next(err) }
})

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

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1', [req.user.id]
    )
    clearRefreshCookie(res)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

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

router.patch('/me/onboarding', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      'UPDATE users SET onboarding_complete = TRUE WHERE id = $1',
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

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
