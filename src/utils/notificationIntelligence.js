/**
 * notificationIntelligence.js
 * Feature 10 — Notification Intelligence
 *
 * Tracks which alert types you open vs dismiss, suppresses low-signal types.
 * Creates a feedback loop so the notification system gets smarter over time.
 */
const pool = require('../db/pool')

/**
 * Record a feedback event when user interacts with a notification
 */
async function recordFeedback(userId, notificationType, action) {
  await pool.query(
    'INSERT INTO notification_feedback (user_id, notification_type, action) VALUES ($1,$2,$3)',
    [userId, notificationType, action]
  ).catch(() => {})
}

/**
 * Recompute suppression preferences based on feedback history.
 * Runs weekly from cron.
 *
 * Logic:
 * - If >70% of last 10 notifications of a type were dismissed without opening → suppress
 * - If type has never been opened in 20+ sends → suppress
 * - If user recently acted on a type → un-suppress it
 */
async function recomputeSuppressions(userId) {
  const { rows: typeStats } = await pool.query(
    `SELECT
       notification_type,
       COUNT(*) AS total,
       SUM(CASE WHEN action = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
       SUM(CASE WHEN action = 'opened'    THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN action = 'acted'     THEN 1 ELSE 0 END) AS acted,
       MAX(recorded_at) AS last_interaction
     FROM notification_feedback
     WHERE user_id=$1 AND recorded_at >= NOW() - INTERVAL '60 days'
     GROUP BY notification_type`,
    [userId]
  )

  for (const stat of typeStats) {
    const total      = Number(stat.total)
    const dismissed  = Number(stat.dismissed)
    const opened     = Number(stat.opened)
    const acted      = Number(stat.acted)

    if (total < 5) continue // not enough data

    let suppress     = false
    let reason       = null

    if (acted > 0) {
      // User recently acted → never suppress
      suppress = false
    } else if (total >= 10 && (dismissed / total) >= 0.7) {
      suppress = true
      reason   = 'always_dismissed'
    } else if (total >= 15 && opened === 0 && acted === 0) {
      suppress = true
      reason   = 'low_open_rate'
    }

    await pool.query(
      `INSERT INTO notification_suppression (user_id, notification_type, suppressed, suppress_reason, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id, notification_type)
       DO UPDATE SET suppressed=$3, suppress_reason=$4, updated_at=NOW()`,
      [userId, stat.notification_type, suppress, reason]
    )
  }
}

/**
 * Check if a notification type is suppressed for a user.
 * Used in createNotification to skip silently.
 */
async function isSuppressed(userId, notificationType) {
  const { rows } = await pool.query(
    'SELECT suppressed FROM notification_suppression WHERE user_id=$1 AND notification_type=$2',
    [userId, notificationType]
  )
  return rows.length > 0 && rows[0].suppressed === true
}

/**
 * Get suppression summary for user settings display
 */
async function getSuppressionSummary(userId) {
  const { rows: suppressed } = await pool.query(
    `SELECT notification_type, suppress_reason, updated_at
     FROM notification_suppression WHERE user_id=$1 AND suppressed=TRUE`,
    [userId]
  )
  const { rows: stats } = await pool.query(
    `SELECT notification_type,
       COUNT(*) AS total,
       SUM(CASE WHEN action='opened'    THEN 1 ELSE 0 END) AS opened,
       SUM(CASE WHEN action='dismissed' THEN 1 ELSE 0 END) AS dismissed,
       SUM(CASE WHEN action='acted'     THEN 1 ELSE 0 END) AS acted
     FROM notification_feedback
     WHERE user_id=$1 AND recorded_at >= NOW() - INTERVAL '60 days'
     GROUP BY notification_type`,
    [userId]
  )
  return { suppressed, stats }
}

/**
 * Un-suppress a type (user manually re-enables)
 */
async function unSuppress(userId, notificationType) {
  await pool.query(
    `INSERT INTO notification_suppression (user_id, notification_type, suppressed, suppress_reason, updated_at)
     VALUES ($1,$2,FALSE,'user_enabled',NOW())
     ON CONFLICT (user_id, notification_type)
     DO UPDATE SET suppressed=FALSE, suppress_reason='user_enabled', updated_at=NOW()`,
    [userId, notificationType]
  )
}

module.exports = {
  recordFeedback,
  recomputeSuppressions,
  isSuppressed,
  getSuppressionSummary,
  unSuppress,
}
