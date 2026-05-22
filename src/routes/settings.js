const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const { sendPasswordChanged } = require('../utils/email')
const bcrypt      = require('bcryptjs')
const requireAuth = require('../middleware/requireAuth')

router.use(requireAuth)

// GET /api/settings — get current user profile + keys (keys masked)
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, anthropic_key, created_at, terms_agreed_at, privacy_agreed_at, terms_version FROM users WHERE id=$1',
      [req.user.id]
    )
    if (!rows.length) return res.status(404).json({ error: 'User not found' })

    const user = rows[0]

    // Gmail connection status
    const { rows: gmailRows } = await pool.query(
      'SELECT gmail_address, connected_at, last_synced FROM gmail_tokens WHERE user_id=$1',
      [req.user.id]
    )
    const gmail = gmailRows[0] || null

    res.json({
      id:           user.id,
      email:        user.email,
      name:         user.name,
      created_at:   user.created_at,
      terms_agreed_at:   user.terms_agreed_at,
      privacy_agreed_at: user.privacy_agreed_at,
      terms_version:     user.terms_version,
      has_anthropic_key: !!user.anthropic_key,
      anthropic_key_hint: user.anthropic_key ? `...${user.anthropic_key.slice(-4)}` : null,
      gmail: gmail ? {
        connected:     true,
        gmail_address: gmail.gmail_address,
        connected_at:  gmail.connected_at,
        last_synced:   gmail.last_synced,
      } : { connected: false },
    })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/settings/profile — update name and/or email
router.patch('/profile', async (req, res, next) => {
  try {
    const { name, email } = req.body
    if (!name && !email) return res.status(400).json({ error: 'Nothing to update' })

    const updates = []
    const values  = []
    let idx = 1

    if (name)  { updates.push(`name=$${idx++}`);  values.push(name.trim()) }
    if (email) { updates.push(`email=$${idx++}`); values.push(email.toLowerCase().trim()) }

    values.push(req.user.id)
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id=$${idx} RETURNING id, email, name`,
      values
    )
    res.json(rows[0])
  } catch (err) {
    next(err)
  }
})

// PATCH /api/settings/password — change password
router.patch('/password', async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Both current and new password are required' })
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' })
    }

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id])
    const valid = await bcrypt.compare(current_password, rows[0].password_hash)
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' })

    const hash = await bcrypt.hash(new_password, 12)
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id])
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/settings/keys — save API keys
router.patch('/keys', async (req, res, next) => {
  try {
    const { anthropic_key, google_key } = req.body

    const updates = []
    const values  = []
    let idx = 1

    if (anthropic_key !== undefined) { updates.push(`anthropic_key=$${idx++}`); values.push(anthropic_key || null) }
    if (google_key    !== undefined) { updates.push(`google_key=$${idx++}`);    values.push(google_key    || null) }

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' })

    values.push(req.user.id)
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id=$${idx}`, values)
    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

module.exports = router
