const express    = require('express')
const router     = express.Router()
const pool       = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// GET /api/notifications — fetch unread + recent dismissed
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND dismissed = FALSE
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    )
    const unread_count = rows.filter(n => !n.read).length
    res.json({ notifications: rows, unread_count })
  } catch (err) {
    console.error('[Notifications] GET error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/notifications/:id/read — mark one as read
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE notifications SET read = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/notifications/read-all — mark all as read
router.patch('/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE notifications SET read = TRUE
       WHERE user_id = $1 AND dismissed = FALSE`,
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/notifications/:id/dismiss — dismiss one
router.patch('/:id/dismiss', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE notifications SET dismissed = TRUE, read = TRUE
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'Not found' })
    res.json(rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/notifications/dismissed — clear all dismissed
router.delete('/dismissed', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM notifications WHERE user_id = $1 AND dismissed = TRUE`,
      [req.user.id]
    )
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Internal helper — other routes can use this to write notifications
async function createNotification(user_id, { type, title, body, icon, metadata }) {
  try {
    // Feature 10 — check suppression before inserting
    // Win and alert types are never suppressed (too important)
    if (type && !['win', 'alert', 'duplicate'].includes(type)) {
      const { isSuppressed } = require('../utils/notificationIntelligence')
      const suppressed = await isSuppressed(user_id, type).catch(() => false)
      if (suppressed) return null
    }

    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, icon, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [user_id, type, title, body, icon || '🔔', metadata ? JSON.stringify(metadata) : null]
    )
    return rows[0]
  } catch (err) {
    console.error('[Notifications] createNotification error:', err.message)
    return null
  }
}

module.exports = router
module.exports.createNotification = createNotification
