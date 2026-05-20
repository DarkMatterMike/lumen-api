const jwt = require('jsonwebtoken')

function requireAuth(req, res, next) {
  // Accept token from Authorization header (Bearer) — frontend sends this
  const header = req.headers.authorization
  const token  = header?.startsWith('Bearer ') ? header.split(' ')[1] : null

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' })
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch (err) {
    // Expired token — client should call /api/auth/refresh
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', expired: true })
    }
    return res.status(401).json({ error: 'Invalid token' })
  }
}

module.exports = requireAuth
