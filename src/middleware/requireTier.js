const pool = require('../db/pool')

/**
 * requireTier('plus') — middleware that blocks free users from a route.
 * Fetches the user's current tier from DB (not token) so it's always fresh.
 */
function requireTier(minTier) {
  const TIERS = { free: 0, plus: 1, pro: 2 }
  const required = TIERS[minTier] ?? 1

  return async (req, res, next) => {
    try {
      // Always check DB — tier changes shouldn't require re-login
      const { rows } = await pool.query(
        'SELECT tier, role FROM users WHERE id=$1', [req.user.id]
      )
      const user = rows[0]
      if (!user) return res.status(401).json({ error: 'User not found' })

      // Owners always have full access
      if (user.role === 'owner') return next()

      const userTier = TIERS[user.tier] ?? 0
      if (userTier < required) {
        return res.status(403).json({
          error: `This feature requires Lumen ${minTier.charAt(0).toUpperCase() + minTier.slice(1)}`,
          upgrade: true,
          requiredTier: minTier,
        })
      }
      next()
    } catch (err) { next(err) }
  }
}

module.exports = requireTier
