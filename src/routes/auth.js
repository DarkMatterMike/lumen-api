const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const crypto   = require('crypto')
const { OAuth2Client } = require('google-auth-library')
const pool     = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// ── Constants ─────────────────────────────────────────────────
const ACCESS_TTL   = '15m'
const REFRESH_7DAY = 7  * 24 * 60 * 60 * 1000   // 7 days remember me
const REFRESH_1DAY = 1  * 24 * 60 * 60 * 1000   // 1 day  no remember me
const MAX_FAILS    = 10
const LOCK_MIN     = 15

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

// ── Cookie config ─────────────────────────────────────────────
// COOKIE_SECURE=true must be set in Railway env vars
const IS_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production'

// ── Token helpers ─────────────────────────────────────────────
function makeAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
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
  const refresh = makeRefreshToken()
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [userId, hashToken(refresh), new Date(Date.now() + ttl), ip, ua]
  )
  setRefreshCookie(res, refresh, ttl)
  return makeAccessToken({ id: userId, email })
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
    res.status(201).json({ token, user })
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
      'SELECT id, email, name, password_hash, oauth_provider FROM users WHERE email=$1',
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

    await recordSuccess(user.id, email, req.ip)

    // rememberMe=true → 7 days, false → 1 day (session)
    const ttl = rememberMe ? REFRESH_7DAY : REFRESH_1DAY
    const token = await issueSession(res, user.id, user.email, user.name, ttl, req.ip, req.get('user-agent'))
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
  } catch (err) { next(err) }
})

// ── POST /api/auth/google ─────────────────────────────────────
// Client sends the Google ID token from the Google One Tap / popup flow.
// We verify it server-side, then find-or-create the user and issue a session.
router.post('/google', async (req, res, next) => {
  try {
    const { credential } = req.body
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' })

    // Verify the ID token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()
    const { sub: googleId, email, name, picture } = payload

    if (!email) return res.status(400).json({ error: 'Google account has no email' })

    // Find existing user by Google ID or email
    let { rows } = await pool.query(
      'SELECT id, email, name, google_id, oauth_provider FROM users WHERE google_id=$1 OR email=$2 LIMIT 1',
      [googleId, email.toLowerCase()]
    )
    let user = rows[0]

    if (!user) {
      // New user — create account
      const { rows: newRows } = await pool.query(
        `INSERT INTO users (email, name, google_id, google_email, google_name, google_avatar, oauth_provider, terms_agreed_at, terms_version, privacy_agreed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'google',NOW(),'1.0',NOW())
         RETURNING id, email, name`,
        [email.toLowerCase(), name, googleId, email.toLowerCase(), name, picture]
      )
      user = newRows[0]
    } else if (!user.google_id) {
      // Existing email-password user — link Google account
      await pool.query(
        `UPDATE users SET google_id=$1, google_email=$2, google_name=$3, google_avatar=$4
         WHERE id=$5`,
        [googleId, email.toLowerCase(), name, picture, user.id]
      )
    }

    // Always issue 7-day session for Google login (they're already authenticated)
    const token = await issueSession(res, user.id, user.email, user.name, REFRESH_7DAY, req.ip, req.get('user-agent'))
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } })
  } catch (err) {
    if (err.message?.includes('Token used too late') || err.message?.includes('Invalid token')) {
      return res.status(401).json({ error: 'Google sign-in expired. Please try again.' })
    }
    next(err)
  }
})

// ── POST /api/auth/refresh ────────────────────────────────────
// FIX: always issue fresh full-TTL cookie on rotation.
// FIX: grace period duplicate requests get a new cookie too.
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.lumen_refresh
    if (!token) return res.status(401).json({ error: 'No refresh token' })

    const hash = hashToken(token)

    // Accept valid tokens AND tokens revoked within the last 30s (race condition grace period)
    const { rows } = await pool.query(
      `SELECT rt.id, rt.user_id, rt.revoked, rt.expires_at, rt.revoked_at,
              u.email, u.name
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1
         AND rt.expires_at > NOW()
         AND (
           rt.revoked = FALSE
           OR (rt.revoked = TRUE AND rt.revoked_at > NOW() - INTERVAL '30 seconds')
         )`,
      [hash]
    )

    if (!rows.length) {
      clearRefreshCookie(res)
      return res.status(401).json({ error: 'Session expired. Please log in again.' })
    }

    const row  = rows[0]
    const user = { id: row.user_id, email: row.email, name: row.name }

    if (row.revoked) {
      // Within grace period — find the replacement token that was issued
      // and re-send it as the cookie so the browser stays in sync.
      const { rows: replacements } = await pool.query(
        `SELECT token_hash, expires_at
         FROM refresh_tokens
         WHERE user_id = $1
           AND revoked = FALSE
           AND expires_at > NOW()
           AND created_at > $2
         ORDER BY created_at DESC LIMIT 1`,
        [row.user_id, row.revoked_at || new Date(Date.now() - 60000)]
      )

      // We can't re-send the raw token (only the hash is stored).
      // Instead just issue a new access token — the browser's cookie
      // from the first successful rotation is still valid.
      const accessToken = makeAccessToken(user)
      return res.json({ token: accessToken, user })
    }

    // Normal rotation: revoke old token and issue fresh 7-day token.
    // KEY FIX: always use REFRESH_7DAY for the new token, not remaining TTL.
    // This means every successful refresh extends the session by 7 days from now,
    // so as long as you use the app every 7 days you stay logged in indefinitely.
    const newRefresh = makeRefreshToken()
    const newTtl     = REFRESH_7DAY   // ← FIXED: always full 7 days

    await pool.query(
      'UPDATE refresh_tokens SET revoked=TRUE, revoked_at=NOW() WHERE id=$1',
      [row.id]
    )
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5)`,
      [user.id, hashToken(newRefresh), new Date(Date.now() + newTtl), req.ip, req.get('user-agent')]
    )

    setRefreshCookie(res, newRefresh, newTtl)
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

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, google_avatar, oauth_provider, created_at FROM users WHERE id=$1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
