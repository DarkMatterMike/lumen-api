const jwt  = require('jsonwebtoken')
const pool = require('../db/pool')

/* ──────────────────────────────────────────────────────────────
   Lumen — personal-app auth
   This is a single-user app. Rather than ever locking the owner
   out when a token expires (or was never refreshed), requests
   fall back to one fixed account.

   - A valid Authorization token is still honored, so nothing
     changes if you ARE logged in.
   - Missing / expired / invalid tokens fall back to the default
     account below instead of returning 401.

   Pin the account explicitly by setting DEFAULT_USER_EMAIL in
   your environment; otherwise the first row in `users` is used.
   ────────────────────────────────────────────────────────────── */

let cachedDefaultUser = null

async function getDefaultUser() {
  if (cachedDefaultUser) return cachedDefaultUser

  const pinnedEmail = process.env.DEFAULT_USER_EMAIL
  const { rows } = await pool.query(
    pinnedEmail
      ? 'SELECT id, email, role FROM users WHERE email = $1 LIMIT 1'
      : 'SELECT id, email, role FROM users ORDER BY id ASC LIMIT 1',
    pinnedEmail ? [pinnedEmail] : []
  )

  if (!rows[0]) throw new Error('No users found in database')

  cachedDefaultUser = { id: rows[0].id, email: rows[0].email, role: rows[0].role || 'user' }
  return cachedDefaultUser
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization
  const token  = header?.startsWith('Bearer ') ? header.split(' ')[1] : null

  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET)
      return next()
    } catch (err) {
      // expired or invalid — fall through to the default account
    }
  }

  try {
    req.user = await getDefaultUser()
    next()
  } catch (err) {
    next(err)
  }
}

module.exports = requireAuth
