const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const crypto   = require('crypto')
const pool     = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

const ACCESS_TTL  = '15m'
const REFRESH_TTL        = 30 * 24 * 60 * 60 * 1000  // 30 days ms (default)
const REFRESH_TTL_7DAY   =  7 * 24 * 60 * 60 * 1000  // 7 days — remember me
const REFRESH_TTL_SESSION =  1 * 24 * 60 * 60 * 1000  // 1 day — no remember me
const MAX_FAILS   = 10
const LOCK_MIN    = 15

// ── Helpers ───────────────────────────────────────────────────

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

// Use COOKIE_SECURE env var explicitly — Railway doesn't set NODE_ENV=production
// Set COOKIE_SECURE=true in your Railway environment variables
const IS_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production'

function setRefreshCookie(res, token, ttl = REFRESH_TTL) {
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

function validatePassword(pw) {
  if (!pw || pw.length < 10)    return 'Password must be at least 10 characters'
  if (!/[A-Z]/.test(pw))        return 'Password must contain an uppercase letter'
  if (!/[0-9]/.test(pw))        return 'Password must contain a number'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a special character'
  return null
}

async function checkLockout(email) {
  const { rows } = await pool.query(
    'SELECT locked_until FROM users WHERE email=$1',
    [email.toLowerCase()]
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
    'UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1',
    [userId]
  )
  await pool.query(
    'INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,TRUE)',
    [email.toLowerCase(), ip]
  )
}

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, terms_agreed } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })
    if (!terms_agreed) return res.status(400).json({ error: 'You must agree to the Terms of Service and Privacy Policy to create an account' })

    const pwErr = validatePassword(password)
    if (pwErr) return res.status(400).json({ error: pwErr })

    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()])
    if (existing.rows.length) return res.status(409).json({ error: 'An account with that email already exists' })

    const hash = await bcrypt.hash(password, 12)
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, terms_agreed_at, terms_version, privacy_agreed_at)
       VALUES ($1,$2,$3,NOW(),'1.0',NOW()) RETURNING id, email, name`,
      [email.toLowerCase(), hash, name || null]
    )
    const user = rows[0]

    const refresh = makeRefreshToken()
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [user.id, hashToken(refresh), new Date(Date.now() + REFRESH_TTL_7DAY), req.ip, req.get('user-agent')]
    )

    setRefreshCookie(res, refresh, REFRESH_TTL_7DAY)
    res.status(201).json({ token: makeAccessToken(user), user })
  } catch (err) { next(err) }
})

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })

    await checkLockout(email)

    const { rows } = await pool.query(
      'SELECT id, email, name, password_hash FROM users WHERE email=$1',
      [email.toLowerCase()]
    )
    const user  = rows[0]
    const valid = user ? await bcrypt.compare(password, user.password_hash) : false

    if (!user || !valid) {
      if (user) await recordFail(email, req.ip)
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    await recordSuccess(user.id, email, req.ip)

    const rememberMe = req.body.rememberMe !== false  // default true
    const ttl = rememberMe ? REFRESH_TTL_7DAY : REFRESH_TTL_SESSION

    const refresh = makeRefreshToken()
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [user.id, hashToken(refresh), new Date(Date.now() + ttl), req.ip, req.get('user-agent')]
    )

    setRefreshCookie(res, refresh, ttl)
    res.json({ token: makeAccessToken(user), user: { id: user.id, email: user.email, name: user.name } })
  } catch (err) { next(err) }
})

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.lumen_refresh
    if (!token) return res.status(401).json({ error: 'No refresh token' })

    // Accept token if valid, OR revoked within last 30s (grace period for race conditions)
    const { rows } = await pool.query(
      `SELECT rt.id, rt.user_id, rt.revoked, rt.expires_at,
              COALESCE(rt.revoked_at, NULL) AS revoked_at,
              u.email, u.name
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash=$1
         AND rt.expires_at > NOW()
         AND (rt.revoked=FALSE OR COALESCE(rt.revoked_at, '1970-01-01') > NOW() - INTERVAL '30 seconds')`,
      [hashToken(token)]
    )
    if (!rows.length) {
      clearRefreshCookie(res)
      return res.status(401).json({ error: 'Session expired. Please log in again.' })
    }

    const row  = rows[0]
    const user = { id: row.user_id, email: row.email, name: row.name }

    // If already revoked but within grace period, find the replacement token
    // and return a new access token without re-rotating (idempotent refresh)
    if (row.revoked) {
      // Just issue a new access token — the cookie already has the new refresh token
      // from the first successful refresh call
      return res.json({ token: makeAccessToken(user), user })
    }

    // Preserve remaining TTL from old token so 7-day doesn't shrink on every refresh
    const remaining = new Date(row.expires_at).getTime() - Date.now()
    const newTtl    = Math.max(remaining, 60 * 60 * 1000) // at least 1h

    const newRefresh = makeRefreshToken()
    try {
      // Mark old token revoked (with timestamp for grace-period race condition handling)
      await pool.query(
        'UPDATE refresh_tokens SET revoked=TRUE, revoked_at=NOW() WHERE id=$1',
        [row.id]
      )
    } catch (revokeErr) {
      // If revoked_at column doesn't exist yet (schema not migrated), fall back
      await pool.query(
        'UPDATE refresh_tokens SET revoked=TRUE WHERE id=$1',
        [row.id]
      )
    }
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
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
      'UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1',
      [req.user.id]
    )
    clearRefreshCookie(res)
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── GET /api/auth/sessions ────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ip, user_agent, created_at
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
      'SELECT id, email, name, created_at FROM users WHERE id=$1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

module.exports = router
