const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const crypto   = require('crypto')
const pool     = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

const ACCESS_TTL  = '15m'
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000  // 30 days ms
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

function setRefreshCookie(res, token) {
  res.cookie('lumen_refresh', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   REFRESH_TTL,
    path:     '/api/auth',
  })
}

function clearRefreshCookie(res) {
  res.clearCookie('lumen_refresh', { path: '/api/auth' })
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
    const { email, password, name } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' })

    const pwErr = validatePassword(password)
    if (pwErr) return res.status(400).json({ error: pwErr })

    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()])
    if (existing.rows.length) return res.status(409).json({ error: 'An account with that email already exists' })

    const hash = await bcrypt.hash(password, 12)
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1,$2,$3) RETURNING id, email, name',
      [email.toLowerCase(), hash, name || null]
    )
    const user = rows[0]

    const refresh = makeRefreshToken()
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [user.id, hashToken(refresh), new Date(Date.now() + REFRESH_TTL), req.ip, req.get('user-agent')]
    )

    setRefreshCookie(res, refresh)
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

    const refresh = makeRefreshToken()
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [user.id, hashToken(refresh), new Date(Date.now() + REFRESH_TTL), req.ip, req.get('user-agent')]
    )

    setRefreshCookie(res, refresh)
    res.json({ token: makeAccessToken(user), user: { id: user.id, email: user.email, name: user.name } })
  } catch (err) { next(err) }
})

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.lumen_refresh
    if (!token) return res.status(401).json({ error: 'No refresh token' })

    const { rows } = await pool.query(
      `SELECT rt.id, rt.user_id, u.email, u.name
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash=$1 AND rt.revoked=FALSE AND rt.expires_at > NOW()`,
      [hashToken(token)]
    )
    if (!rows.length) {
      clearRefreshCookie(res)
      return res.status(401).json({ error: 'Session expired. Please log in again.' })
    }

    const row  = rows[0]
    const user = { id: row.user_id, email: row.email, name: row.name }

    // Rotate: revoke old, issue new
    const newRefresh = makeRefreshToken()
    await pool.query('UPDATE refresh_tokens SET revoked=TRUE WHERE id=$1', [row.id])
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)',
      [user.id, hashToken(newRefresh), new Date(Date.now() + REFRESH_TTL), req.ip, req.get('user-agent')]
    )

    setRefreshCookie(res, newRefresh)
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
