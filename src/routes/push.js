/**
 * Push Notifications Route
 *
 * POST /api/push/subscribe    — save a push subscription for this device
 * DELETE /api/push/subscribe  — remove push subscription
 * GET  /api/push/vapid-key    — get the public VAPID key for the client
 * POST /api/push/test         — send a test push to this user
 */
const express   = require('express')
const router    = express.Router()
const webpush   = require('web-push')
const pool      = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

// Configure VAPID — keys should be in env vars
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || 'BOhK69ek192aRzYRexvMbZbWAHFEAWOuC_sPDSDkljsSUcfHLMDsiZVWKvjiI__xh-k9PBQJYhyIAZmdoHnZG_s'
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'VcF8IPNKy28uhg2BMOkfkIMsMozGPuaiahwN72tQP6w'
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:lumen@example.com'

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE)

// GET /api/push/vapid-key — public key for client subscription
router.get('/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC })
})

router.use(requireAuth)

// POST /api/push/subscribe — save device subscription
router.post('/subscribe', async (req, res, next) => {
  try {
    const { endpoint, keys, userAgent } = req.body
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' })
    }

    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh=$3, auth=$4, last_used_at=NOW()`,
      [req.user.id, endpoint, keys.p256dh, keys.auth, userAgent || null]
    )

    res.json({ success: true })
  } catch (err) { next(err) }
})

// DELETE /api/push/subscribe — remove subscription
router.delete('/subscribe', async (req, res, next) => {
  try {
    const { endpoint } = req.body
    await pool.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2',
      [req.user.id, endpoint]
    )
    res.json({ success: true })
  } catch (err) { next(err) }
})

// POST /api/push/test — send a test push
router.post('/test', async (req, res, next) => {
  try {
    const count = await sendPushToUser(req.user.id, {
      title: 'Lumen is watching 👀',
      body:  'Push notifications are working. I\'ll tap you when something needs attention.',
      icon:  '/favicon.svg',
      tag:   'test',
    })
    res.json({ success: true, devices_notified: count })
  } catch (err) { next(err) }
})

/**
 * Send a push notification to all devices for a user.
 * Called from cron and from createNotification for high-priority types.
 */
async function sendPushToUser(userId, payload) {
  const { rows: subs } = await pool.query(
    'SELECT * FROM push_subscriptions WHERE user_id=$1',
    [userId]
  )
  if (!subs.length) return 0

  let sent = 0
  const stale = []

  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys:     { p256dh: sub.p256dh, auth: sub.auth },
    }
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: payload.title,
        body:  payload.body,
        icon:  payload.icon || '/favicon.svg',
        badge: '/favicon.svg',
        tag:   payload.tag || 'lumen',
        data:  payload.data || {},
      }))
      await pool.query(
        'UPDATE push_subscriptions SET last_used_at=NOW() WHERE id=$1',
        [sub.id]
      )
      sent++
    } catch (err) {
      // 410 Gone = subscription expired, remove it
      if (err.statusCode === 410 || err.statusCode === 404) {
        stale.push(sub.id)
      }
    }
  }

  // Prune stale subscriptions
  if (stale.length) {
    await pool.query(
      'DELETE FROM push_subscriptions WHERE id = ANY($1::int[])',
      [stale]
    )
  }

  return sent
}

/**
 * Push high-priority notifications that haven't been pushed yet.
 * Called from cron hourly, after notification creation.
 */
async function pushPendingNotifications(userId) {
  const HIGH_PRIORITY = ['alert', 'warning', 'win', 'duplicate', 'cash_crunch']

  const { rows: pending } = await pool.query(
    `SELECT * FROM notifications
     WHERE user_id=$1
       AND pushed=FALSE
       AND dismissed=FALSE
       AND type = ANY($2::text[])
       AND created_at >= NOW() - INTERVAL '2 hours'
     ORDER BY created_at DESC LIMIT 10`,
    [userId, HIGH_PRIORITY]
  )

  if (!pending.length) return 0

  for (const notif of pending) {
    await sendPushToUser(userId, {
      title: notif.title,
      body:  notif.body,
      icon:  '/favicon.svg',
      tag:   `notif-${notif.id}`,
      data:  { notification_id: notif.id, type: notif.type },
    })

    await pool.query(
      'UPDATE notifications SET pushed=TRUE WHERE id=$1',
      [notif.id]
    )
  }

  return pending.length
}

module.exports = router
module.exports.sendPushToUser         = sendPushToUser
module.exports.pushPendingNotifications = pushPendingNotifications
module.exports.VAPID_PUBLIC           = VAPID_PUBLIC
