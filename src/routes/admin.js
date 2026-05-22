/**
 * /api/admin — User management (owner-only)
 */
const express    = require('express')
const router     = express.Router()
const pool       = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

async function requireOwner(req, res, next) {
  try {
    // Always re-check role from DB — JWT role can be stale if promoted recently
    const { rows } = await pool.query('SELECT role FROM users WHERE id=$1', [req.user.id])
    const role = rows[0]?.role || 'user'
    if (role === 'owner') return next()
    return res.status(403).json({ error: 'Access denied' })
  } catch {
    return res.status(403).json({ error: 'Could not verify role' })
  }
}

router.use(requireAuth, requireOwner)

// GET /api/admin/users
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, created_at, terms_agreed_at,
              (SELECT COUNT(*) FROM accounts WHERE user_id = users.id) AS account_count,
              (SELECT COUNT(*) FROM transactions WHERE user_id = users.id) AS tx_count,
              (SELECT MAX(created_at) FROM refresh_tokens WHERE user_id = users.id AND revoked = FALSE AND expires_at > NOW()) AS last_active
       FROM users
       ORDER BY created_at DESC`
    )
    res.json({ users: rows })
  } catch (err) { next(err) }
})

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const { role } = req.body
    const allowed  = ['owner', 'admin', 'user']
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid role' })

    // Prevent demoting yourself
    if (Number(req.params.id) === req.user.id && role !== 'owner') {
      return res.status(400).json({ error: 'Cannot change your own owner role' })
    }

    const { rows } = await pool.query(
      `UPDATE users SET role = $1 WHERE id = $2 RETURNING id, email, name, role`,
      [role, req.params.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })
    res.json(rows[0])
  } catch (err) { next(err) }
})

// DELETE /api/admin/users/:id — revoke all sessions
router.delete('/users/:id', async (req, res, next) => {
  try {
    const targetId = Number(req.params.id)
    if (!targetId) return res.status(400).json({ error: 'Invalid user ID' })
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot revoke your own account' })
    }

    // Verify target user exists
    const { rows: target } = await pool.query('SELECT id, email FROM users WHERE id=$1', [targetId])
    if (!target.length) return res.status(404).json({ error: 'User not found' })

    // Mark all active refresh tokens as revoked (preserves audit trail)
    const result = await pool.query(
      'UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1 AND revoked=FALSE',
      [targetId]
    )

    console.log(`[Admin] ${req.user.email} revoked sessions for ${target[0].email} (${result.rowCount} tokens)`)
    res.json({ ok: true, sessions_revoked: result.rowCount, email: target[0].email })
  } catch (err) { next(err) }
})

module.exports = router
