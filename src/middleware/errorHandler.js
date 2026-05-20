// Central error handler — never leaks internal details to client in production

const isProd = process.env.NODE_ENV === 'production'

// Safe errors that can be surfaced to the client
const SAFE_MESSAGES = [
  'not found', 'unauthorized', 'forbidden', 'invalid',
  'required', 'already exists', 'not connected', 'too many',
  'gmail not connected', 'no token', 'bad request',
]

function isSafeMessage(msg) {
  if (!msg) return false
  const lower = msg.toLowerCase()
  return SAFE_MESSAGES.some(s => lower.includes(s))
}

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500

  // Always log full error internally
  if (status >= 500) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${status}:`, err.message)
    if (!isProd) console.error(err.stack)
  }

  // Client response — never expose stack traces or DB schema in production
  const clientMessage = isProd
    ? isSafeMessage(err.message)
      ? err.message   // safe to surface
      : 'Something went wrong. Please try again.'
    : err.message    // dev: show full message for debugging

  res.status(status).json({ error: clientMessage })
}

module.exports = errorHandler
