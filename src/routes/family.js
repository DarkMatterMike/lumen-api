const express = require('express')
const router  = express.Router()
const pool    = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const crypto  = require('crypto')
const { sendFamilyInvite } = require('../utils/email')

async function requirePro(req, res, next) {
  try {
    // Query DB directly — tier column may not exist, role is reliable
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id])
    const role = rows[0]?.role || 'user'
    if (role === 'owner' || role === 'admin') return next()
    return res.status(403).json({ error: 'Family plan requires Lumen Pro', upgrade: true })
  } catch {
    return res.status(403).json({ error: 'Could not verify plan' })
  }
}

// ── GET /api/family/status ────────────────────────────────────
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    // Am I in a family group (as owner or member)?
    const { rows: owned } = await pool.query(
      'SELECT * FROM family_groups WHERE owner_id=$1', [req.user.id]
    )
    if (owned.length) {
      const { rows: members } = await pool.query(
        `SELECT fm.user_id, u.name, u.email, u.google_avatar, fm.joined_at
         FROM family_members fm JOIN users u ON u.id=fm.user_id
         WHERE fm.group_id=$1`, [owned[0].id]
      )
      return res.json({ role: 'owner', group: owned[0], members })
    }
    const { rows: member } = await pool.query(
      `SELECT fg.*, u.name AS owner_name
       FROM family_members fm
       JOIN family_groups fg ON fg.id=fm.group_id
       JOIN users u ON u.id=fg.owner_id
       WHERE fm.user_id=$1`, [req.user.id]
    )
    if (member.length) return res.json({ role: 'member', group: member[0], members: [] })
    res.json({ role: null, group: null, members: [] })
  } catch (err) { next(err) }
})

// ── POST /api/family/create ───────────────────────────────────
router.post('/create', requireAuth, requirePro, async (req, res, next) => {
  try {
    const existing = await pool.query(
      'SELECT id FROM family_groups WHERE owner_id=$1', [req.user.id]
    )
    if (existing.rows.length) {
      return res.json({ group: existing.rows[0] })
    }
    const code = crypto.randomBytes(8).toString('hex')
    const { rows } = await pool.query(
      'INSERT INTO family_groups (owner_id, invite_code) VALUES ($1,$2) RETURNING *',
      [req.user.id, code]
    )
    res.json({ group: rows[0] })
  } catch (err) { next(err) }
})

// ── POST /api/family/regenerate-invite ───────────────────────
router.post('/regenerate-invite', requireAuth, requirePro, async (req, res, next) => {
  try {
    const code = crypto.randomBytes(8).toString('hex')
    const { rows } = await pool.query(
      'UPDATE family_groups SET invite_code=$1 WHERE owner_id=$2 RETURNING *',
      [code, req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'No family group found' })
    res.json({ inviteCode: code })
  } catch (err) { next(err) }
})

// ── GET /api/family/join/:code ────────────────────────────────
router.get('/join/:code', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT fg.*, u.name AS owner_name
       FROM family_groups fg JOIN users u ON u.id=fg.owner_id
       WHERE fg.invite_code=$1`, [req.params.code]
    )
    if (!rows.length) return res.status(404).json({ error: 'Invalid invite link' })
    res.json({ group: rows[0] })
  } catch (err) { next(err) }
})

// ── POST /api/family/join/:code ───────────────────────────────
router.post('/join/:code', requireAuth, async (req, res, next) => {
  try {
    const { rows: groups } = await pool.query(
      'SELECT * FROM family_groups WHERE invite_code=$1', [req.params.code]
    )
    if (!groups.length) return res.status(404).json({ error: 'Invalid invite link' })
    const group = groups[0]

    // Can't join your own group
    if (group.owner_id === req.user.id) {
      return res.status(400).json({ error: 'You own this family group' })
    }

    // Check member limit (max 2 additional members)
    const { rows: members } = await pool.query(
      'SELECT COUNT(*) FROM family_members WHERE group_id=$1', [group.id]
    )
    if (Number(members[0].count) >= 2) {
      return res.status(400).json({ error: 'Family group is full (max 2 additional members)' })
    }

    await pool.query(
      'INSERT INTO family_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [group.id, req.user.id]
    )
    res.json({ ok: true, groupId: group.id, ownerName: group.owner_name })
  } catch (err) { next(err) }
})

// ── DELETE /api/family/members/:userId ───────────────────────
router.delete('/members/:userId', requireAuth, requirePro, async (req, res, next) => {
  try {
    const { rows: groups } = await pool.query(
      'SELECT id FROM family_groups WHERE owner_id=$1', [req.user.id]
    )
    if (!groups.length) return res.status(404).json({ error: 'No family group' })
    await pool.query(
      'DELETE FROM family_members WHERE group_id=$1 AND user_id=$2',
      [groups[0].id, req.params.userId]
    )
    res.json({ ok: true })
  } catch (err) { next(err) }
})

// ── POST /api/family/visibility/transaction ───────────────────
router.post('/visibility/transaction', requireAuth, async (req, res, next) => {
  try {
    const { transactionId, visibility } = req.body // 'blurred' | 'hidden' | 'visible'
    if (visibility === 'visible') {
      await pool.query(
        'DELETE FROM transaction_visibility WHERE transaction_id=$1 AND set_by_user_id=$2',
        [transactionId, req.user.id]
      )
    } else {
      await pool.query(
        `INSERT INTO transaction_visibility (transaction_id, set_by_user_id, visibility)
         VALUES ($1,$2,$3)
         ON CONFLICT (transaction_id, set_by_user_id) DO UPDATE SET visibility=$3`,
        [transactionId, req.user.id, visibility]
      )
    }
    res.json({ ok: true })
  } catch (err) { next(err) }
})

module.exports = router
