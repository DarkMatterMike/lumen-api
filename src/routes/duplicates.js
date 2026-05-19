/**
 * Phase B — Duplicate review routes
 * POST /api/duplicates/:notifId/confirm  — user confirms it IS a duplicate (deletes one tx)
 * POST /api/duplicates/:notifId/dismiss  — user says it's NOT a duplicate
 * GET  /api/duplicates                   — list all pending duplicate notifications
 */
const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/duplicates — list pending duplicate notifications
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*, 
              t1.name AS tx1_name, t1.amount AS tx1_amount, t1.date AS tx1_date,
              t2.name AS tx2_name, t2.amount AS tx2_amount, t2.date AS tx2_date
       FROM notifications n
       LEFT JOIN transactions t1 ON (n.metadata->>'tx1_id')::int = t1.id
       LEFT JOIN transactions t2 ON (n.metadata->>'tx2_id')::int = t2.id
       WHERE n.user_id = $1 AND n.type = 'duplicate' AND n.dismissed = FALSE
       ORDER BY n.created_at DESC`,
      [req.user.id]
    )
    res.json({ duplicates: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/duplicates/:notifId/confirm — mark as duplicate, delete the newer transaction
router.post('/:notifId/confirm', async (req, res) => {
  try {
    // Get the notification
    const { rows: notifs } = await pool.query(
      'SELECT * FROM notifications WHERE id = $1 AND user_id = $2 AND type = $3',
      [req.params.notifId, req.user.id, 'duplicate']
    )
    if (!notifs.length) return res.status(404).json({ error: 'Notification not found' })

    const notif = notifs[0]
    const meta  = notif.metadata || {}
    const tx1Id = meta.tx1_id
    const tx2Id = meta.tx2_id

    // Keep the older transaction (lower id or earlier date), delete the newer one
    const { rows: txs } = await pool.query(
      'SELECT id, date FROM transactions WHERE id = ANY($1::int[]) AND user_id = $2',
      [[tx1Id, tx2Id], req.user.id]
    )

    if (txs.length < 2) {
      // One was already deleted — just dismiss the notification
      await pool.query(
        'UPDATE notifications SET dismissed = TRUE, read = TRUE WHERE id = $1',
        [req.params.notifId]
      )
      return res.json({ success: true, deleted_id: null, kept_id: txs[0]?.id })
    }

    txs.sort((a, b) => new Date(a.date) - new Date(b.date))
    const keepTx   = txs[0] // older
    const deleteTx = txs[1] // newer

    // Delete the newer one
    await pool.query(
      'DELETE FROM transactions WHERE id = $1 AND user_id = $2',
      [deleteTx.id, req.user.id]
    )

    // Record the review
    await pool.query(
      `INSERT INTO duplicate_reviews (user_id, transaction_id_1, transaction_id_2, action)
       VALUES ($1, $2, $3, 'confirmed_duplicate')`,
      [req.user.id, keepTx.id, deleteTx.id]
    ).catch(() => {}) // non-fatal

    // Dismiss the notification
    await pool.query(
      'UPDATE notifications SET dismissed = TRUE, read = TRUE WHERE id = $1',
      [req.params.notifId]
    )

    res.json({ success: true, deleted_id: deleteTx.id, kept_id: keepTx.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/duplicates/:notifId/dismiss — user says it's NOT a duplicate, remember decision
router.post('/:notifId/dismiss', async (req, res) => {
  try {
    const { rows: notifs } = await pool.query(
      'SELECT * FROM notifications WHERE id = $1 AND user_id = $2 AND type = $3',
      [req.params.notifId, req.user.id, 'duplicate']
    )
    if (!notifs.length) return res.status(404).json({ error: 'Notification not found' })

    const meta  = (notifs[0].metadata || {})
    const tx1Id = meta.tx1_id
    const tx2Id = meta.tx2_id

    // Record so we don't alert on this pair again
    if (tx1Id && tx2Id) {
      await pool.query(
        `INSERT INTO duplicate_reviews (user_id, transaction_id_1, transaction_id_2, action)
         VALUES ($1, $2, $3, 'dismissed')
         ON CONFLICT DO NOTHING`,
        [req.user.id, tx1Id, tx2Id]
      ).catch(() => {})
    }

    // Dismiss notification
    await pool.query(
      'UPDATE notifications SET dismissed = TRUE, read = TRUE WHERE id = $1',
      [req.params.notifId]
    )

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
