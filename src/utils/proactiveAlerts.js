/**
 * proactiveAlerts.js
 * Phase E — Proactive Alerts (all run from cron hourly)
 *
 * Exports:
 *  - runAnomalyDetection(userId)      → unusual merchant spend, ATM, first-time charges
 *  - runPatternDetection(userId)      → weekend spikes, category creep, missed recurring bills
 *  - runSubscriptionAudit(userId)     → monthly subscription summary
 *  - runDoubleBillingDetection(userId)→ same charge hitting multiple accounts same day
 *  - runAllProactiveAlerts(userId)    → calls all four (used by cron)
 */

const pool = require('../db/pool')
const { createNotification } = require('../routes/notifications')
const { normalizeMerchant }  = require('./transactionIntelligence')

// ── Dedupe helper — returns true if this alert is new (not already fired) ─────
async function isNewAlert(userId, key) {
  try {
    await pool.query(
      `INSERT INTO proactive_alert_log (user_id, alert_key) VALUES ($1, $2)
       ON CONFLICT (user_id, alert_key) DO NOTHING`,
      [userId, key]
    )
    // If the row was actually inserted, rowCount = 1 → new alert
    // But pool.query doesn't reliably return rowCount for ON CONFLICT DO NOTHING
    // So we check if a row with this key already existed before we inserted
    const { rows } = await pool.query(
      'SELECT fired_at FROM proactive_alert_log WHERE user_id=$1 AND alert_key=$2',
      [userId, key]
    )
    if (!rows.length) return false
    // If fired_at is within the last minute, it's brand new
    const age = Date.now() - new Date(rows[0].fired_at).getTime()
    return age < 60_000
  } catch {
    return false
  }
}

// ── 1. ANOMALY DETECTION ──────────────────────────────────────────────────────
/**
 * Looks at transactions from the last 48 hours and flags:
 *   a) Merchant spend 3x+ above the user's baseline for that merchant
 *   b) ATM withdrawals (unusual for most users)
 *   c) First-time merchants (never seen before)
 */
async function runAnomalyDetection(userId) {
  let fired = 0

  // ── a) Update merchant baselines from last 90 days ──
  await pool.query(
    `INSERT INTO merchant_baselines (user_id, merchant_key, avg_amount, visit_count, last_updated)
     SELECT
       $1,
       LOWER(TRIM(COALESCE(name, ''))),
       AVG(ABS(amount)),
       COUNT(*),
       NOW()
     FROM transactions
     WHERE user_id = $1
       AND amount < 0
       AND COALESCE(tx_type, 'expense') NOT IN ('transfer', 'income')
       AND date >= CURRENT_DATE - INTERVAL '90 days'
     GROUP BY LOWER(TRIM(COALESCE(name, '')))
     ON CONFLICT (user_id, merchant_key)
     DO UPDATE SET
       avg_amount   = EXCLUDED.avg_amount,
       visit_count  = EXCLUDED.visit_count,
       last_updated = NOW()`,
    [userId]
  )

  // ── Get new transactions from last 48h ──
  const { rows: recent } = await pool.query(
    `SELECT id, name, amount, date, category
     FROM transactions
     WHERE user_id = $1
       AND amount < 0
       AND COALESCE(tx_type, 'expense') NOT IN ('transfer', 'income')
       AND date >= CURRENT_DATE - INTERVAL '2 days'
     ORDER BY date DESC`,
    [userId]
  )

  for (const tx of recent) {
    const key        = LOWER(tx.name)
    const amt        = Math.abs(Number(tx.amount))
    const dateStr    = String(tx.date).slice(0, 10)

    // a) Anomalous spend — 3x baseline
    const { rows: baseline } = await pool.query(
      'SELECT avg_amount, visit_count FROM merchant_baselines WHERE user_id=$1 AND merchant_key=$2',
      [userId, key]
    )
    if (baseline.length && baseline[0].visit_count >= 3) {
      const avg   = Number(baseline[0].avg_amount)
      const ratio = avg > 0 ? amt / avg : 0
      if (ratio >= 3) {
        const alertKey = `anomaly-spend-${tx.id}`
        if (await isNewAlert(userId, alertKey)) {
          await createNotification(userId, {
            type:  'alert',
            icon:  '👀',
            title: `Unusual charge at ${displayName(tx.name)}`,
            body:  `$${fmt(amt)} at ${displayName(tx.name)} — that's ${Math.round(ratio)}× your usual $${fmt(avg)}. Was this you?`,
            metadata: { transaction_id: tx.id, merchant: tx.name, amount: amt, avg_amount: avg, ratio }
          })
          fired++
        }
      }
    }

    // b) ATM withdrawal
    if (isAtm(tx.name)) {
      const alertKey = `anomaly-atm-${tx.id}`
      if (await isNewAlert(userId, alertKey)) {
        await createNotification(userId, {
          type:  'insight',
          icon:  '🏧',
          title: `ATM withdrawal — $${fmt(amt)}`,
          body:  `You made an ATM withdrawal of $${fmt(amt)} on ${friendlyDate(dateStr)}. You don't usually do this.`,
          metadata: { transaction_id: tx.id, amount: amt }
        })
        fired++
      }
    }

    // c) First-time merchant (baseline exists but visit_count = 1, or no baseline)
    const isFirstTime = !baseline.length ||
      (baseline.length && baseline[0].visit_count === 1)
    if (isFirstTime && amt > 20) {
      // Only flag genuinely unknown merchants (not common brands)
      const alertKey = `anomaly-firsttime-${tx.id}`
      if (await isNewAlert(userId, alertKey)) {
        await createNotification(userId, {
          type:  'insight',
          icon:  '🆕',
          title: `First charge from ${displayName(tx.name)}`,
          body:  `$${fmt(amt)} — this is the first time you've been charged by ${displayName(tx.name)}.`,
          metadata: { transaction_id: tx.id, merchant: tx.name, amount: amt }
        })
        fired++
      }
    }
  }

  return fired
}

// ── 2. PATTERN DETECTION ──────────────────────────────────────────────────────
/**
 * Checks weekly patterns and trends:
 *   a) Weekend spending spike vs weekday average
 *   b) Category creep — a category has grown 30%+ over 3 months
 *   c) Missed recurring bill — expected this month but not yet seen
 */
async function runPatternDetection(userId) {
  let fired = 0
  const today   = new Date()
  const weekKey = getWeekKey(today) // 'YYYY-WW'

  // ── a) Weekend spending spike ──
  // Compare this past weekend's spend to the prior 4-weekend average
  const dayOfWeek = today.getDay() // 0=Sun, 1=Mon...
  if (dayOfWeek === 1 || dayOfWeek === 2) {
    // Monday or Tuesday — recent enough to analyse last weekend
    const { rows: weekendData } = await pool.query(
      `SELECT
         SUM(CASE WHEN EXTRACT(DOW FROM date) IN (0,6) AND date >= CURRENT_DATE - INTERVAL '3 days'
           THEN ABS(amount) ELSE 0 END) AS this_weekend,
         AVG(weekly_sum) AS avg_weekend
       FROM (
         SELECT
           DATE_TRUNC('week', date) AS week_start,
           SUM(CASE WHEN EXTRACT(DOW FROM date) IN (0,6) THEN ABS(amount) ELSE 0 END) AS weekly_sum
         FROM transactions
         WHERE user_id = $1
           AND amount < 0
           AND COALESCE(tx_type,'expense') NOT IN ('transfer','income')
           AND date >= CURRENT_DATE - INTERVAL '5 weeks'
           AND date < CURRENT_DATE - INTERVAL '3 days'
         GROUP BY DATE_TRUNC('week', date)
       ) sub`,
      [userId]
    )

    if (weekendData.length) {
      const thisWeekend = Number(weekendData[0].this_weekend) || 0
      const avgWeekend  = Number(weekendData[0].avg_weekend)  || 0
      if (avgWeekend > 20 && thisWeekend > avgWeekend * 1.5) {
        const alertKey = `pattern-weekend-${weekKey}`
        if (await isNewAlert(userId, alertKey)) {
          const over = thisWeekend - avgWeekend
          await createNotification(userId, {
            type:  'insight',
            icon:  '📅',
            title: 'Weekend spending was above average',
            body:  `You spent $${fmt(thisWeekend)} this weekend — $${fmt(over)} more than your usual $${fmt(avgWeekend)} weekend average.`,
            metadata: { this_weekend: thisWeekend, avg_weekend: avgWeekend, over }
          })
          fired++
        }
      }
    }
  }

  // ── b) Category creep — growing 30%+ over 3 months ──
  // Run once per month per category (key includes YYYY-MM)
  const monthKey = today.toISOString().slice(0, 7)
  const { rows: catTrend } = await pool.query(
    `SELECT category,
       SUM(CASE WHEN date >= DATE_TRUNC('month', CURRENT_DATE) THEN ABS(amount) ELSE 0 END) AS this_month,
       SUM(CASE WHEN date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'
                 AND date <  DATE_TRUNC('month', CURRENT_DATE) THEN ABS(amount) ELSE 0 END) / 3.0 AS avg_prior_month
     FROM transactions
     WHERE user_id = $1
       AND amount < 0
       AND COALESCE(tx_type,'expense') NOT IN ('transfer','income')
       AND category NOT IN ('Income','Transfer','Other')
       AND date >= CURRENT_DATE - INTERVAL '4 months'
     GROUP BY category
     HAVING SUM(CASE WHEN date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '3 months'
                      AND date <  DATE_TRUNC('month', CURRENT_DATE) THEN ABS(amount) ELSE 0 END) / 3.0 > 30`,
    [userId]
  )

  for (const row of catTrend) {
    const thisMonth = Number(row.this_month)
    const avgPrior  = Number(row.avg_prior_month)
    if (avgPrior > 0 && thisMonth > avgPrior * 1.3) {
      const alertKey = `pattern-creep-${row.category}-${monthKey}`
      if (await isNewAlert(userId, alertKey)) {
        const pct = Math.round((thisMonth / avgPrior - 1) * 100)
        await createNotification(userId, {
          type:  'insight',
          icon:  '📈',
          title: `${row.category} spending is creeping up`,
          body:  `${row.category} is up ${pct}% vs your 3-month average — $${fmt(thisMonth)} this month vs $${fmt(avgPrior)} usual.`,
          metadata: { category: row.category, this_month: thisMonth, avg_prior: avgPrior, pct }
        })
        fired++
      }
    }
  }

  // ── c) Missed recurring bill — expected by now but not seen ──
  // Run daily. Look for recurring items due in the past 3 days with no matching transaction.
  const { rows: recurring } = await pool.query(
    'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE AND type != $2',
    [userId, 'income']
  )

  for (const r of recurring) {
    const dueDay = r.day_of_month
    if (!dueDay) continue

    const todayDay = today.getDate()
    // Was it due in the last 3 days?
    const daysPast = todayDay - dueDay
    if (daysPast < 1 || daysPast > 3) continue

    // Check if it appeared in transactions this month
    const { rows: found } = await pool.query(
      `SELECT id FROM transactions
       WHERE user_id = $1
         AND LOWER(name) LIKE $2
         AND date >= DATE_TRUNC('month', CURRENT_DATE)
         AND date <= CURRENT_DATE
       LIMIT 1`,
      [userId, `%${normalizeMerchant(r.name).substring(0, 12)}%`]
    )

    if (!found.length) {
      const alertKey = `pattern-missed-${r.id}-${monthKey}`
      if (await isNewAlert(userId, alertKey)) {
        await createNotification(userId, {
          type:  'warning',
          icon:  '❓',
          title: `${r.name} hasn't appeared yet`,
          body:  `${r.name} was due around the ${ordinal(dueDay)} but hasn't shown up yet. It may still be processing, or the amount changed.`,
          metadata: { recurring_id: r.id, name: r.name, day_of_month: dueDay, amount: r.amount }
        })
        fired++
      }
    }
  }

  return fired
}

// ── 3. SUBSCRIPTION AUDIT ─────────────────────────────────────────────────────
/**
 * Once per month: compile all subscriptions from recurring + recent transactions
 * tagged as Subscriptions category, send a summary notification.
 *
 * Also flags: subscriptions that increased in the last 60 days.
 */
async function runSubscriptionAudit(userId) {
  const today    = new Date()
  // Only run on the 1st of the month (±1 day tolerance)
  const dayOfMonth = today.getDate()
  if (dayOfMonth > 3) return 0 // skip unless first 3 days of month

  const monthKey = today.toISOString().slice(0, 7)
  const alertKey = `subscription-audit-${monthKey}`

  // Already sent this month?
  const { rows: existing } = await pool.query(
    'SELECT id FROM proactive_alert_log WHERE user_id=$1 AND alert_key=$2',
    [userId, alertKey]
  )
  if (existing.length) return 0

  // Get recurring items tagged as subscriptions
  const { rows: recurringSubsRows } = await pool.query(
    `SELECT name, amount FROM recurring
     WHERE user_id=$1 AND active=TRUE AND LOWER(COALESCE(category,'')) LIKE '%subscri%'`,
    [userId]
  )

  // Get unique subscription transactions from last 35 days
  const { rows: txSubsRows } = await pool.query(
    `SELECT COALESCE(cleaned_name, name) AS display_name, ABS(AVG(amount)) AS avg_amount, COUNT(*) AS hits
     FROM transactions
     WHERE user_id = $1
       AND LOWER(category) LIKE '%subscri%'
       AND amount < 0
       AND date >= CURRENT_DATE - INTERVAL '35 days'
     GROUP BY COALESCE(cleaned_name, name)
     ORDER BY avg_amount DESC`,
    [userId]
  )

  // Merge — prefer recurring items (they have verified amounts)
  const allSubs  = new Map()
  for (const r of recurringSubsRows) allSubs.set(r.name, Number(r.amount))
  for (const t of txSubsRows)        if (!allSubs.has(t.display_name)) allSubs.set(t.display_name, Number(t.avg_amount))

  if (allSubs.size === 0) return 0

  const total     = Array.from(allSubs.values()).reduce((s, a) => s + a, 0)
  const annual    = total * 12
  const topLine   = Array.from(allSubs.entries()).slice(0, 4).map(([n, a]) => `${n} $${fmt(a)}`).join(' · ')

  await createNotification(userId, {
    type:  'insight',
    icon:  '📋',
    title: `Monthly subscription summary — $${fmt(total)}/mo`,
    body:  `You have ${allSubs.size} active subscriptions totalling $${fmt(total)}/month ($${fmt(annual)}/year). ${topLine}${allSubs.size > 4 ? ' + more.' : '.'}`,
    metadata: {
      type:          'subscription_audit',
      month:         monthKey,
      total_monthly: total,
      total_annual:  annual,
      count:         allSubs.size,
      subscriptions: Object.fromEntries(allSubs),
    }
  })

  await pool.query(
    'INSERT INTO proactive_alert_log (user_id, alert_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [userId, alertKey]
  )

  return 1
}

// ── 4. DOUBLE BILLING DETECTION ───────────────────────────────────────────────
/**
 * Same merchant + same amount on the same day across DIFFERENT accounts.
 * This catches cases where e.g. Netflix charges both your card and hits a bank debit.
 */
async function runDoubleBillingDetection(userId) {
  let fired = 0

  // Look at last 7 days for pairs across different accounts
  const { rows: pairs } = await pool.query(
    `SELECT
       t1.id AS id1, t1.name AS name1, t1.amount AS amount1, t1.date AS date1, t1.account_id AS acct1,
       t2.id AS id2, t2.account_id AS acct2
     FROM transactions t1
     JOIN transactions t2
       ON  t1.user_id  = t2.user_id
       AND t1.id       < t2.id
       AND t1.account_id != t2.account_id
       AND ABS(t1.amount - t2.amount) < 0.01
       AND t1.date     = t2.date
       AND LOWER(TRIM(t1.name)) = LOWER(TRIM(t2.name))
     WHERE t1.user_id = $1
       AND t1.amount  < 0
       AND t1.date   >= CURRENT_DATE - INTERVAL '7 days'
       AND COALESCE(t1.tx_type,'expense') NOT IN ('transfer','income')`,
    [userId]
  )

  for (const pair of pairs) {
    const alertKey = `doublebill-${pair.id1}-${pair.id2}`
    if (await isNewAlert(userId, alertKey)) {
      const amt = Math.abs(Number(pair.amount1))
      await createNotification(userId, {
        type:  'alert',
        icon:  '🔁',
        title: `Possible double charge — ${displayName(pair.name1)}`,
        body:  `$${fmt(amt)} from ${displayName(pair.name1)} on ${friendlyDate(String(pair.date1).slice(0,10))} appears on two different accounts. Double billing?`,
        metadata: {
          type:       'double_billing',
          tx1_id:     pair.id1,
          tx2_id:     pair.id2,
          merchant:   pair.name1,
          amount:     amt,
          date:       pair.date1,
        }
      })
      fired++
    }
  }

  return fired
}

// ── Master runner ─────────────────────────────────────────────────────────────
async function runAllProactiveAlerts(userId) {
  const results = {}
  results.anomaly      = await runAnomalyDetection(userId).catch(e => { console.warn('[E] Anomaly:', e.message); return 0 })
  results.pattern      = await runPatternDetection(userId).catch(e => { console.warn('[E] Pattern:', e.message); return 0 })
  results.subscription = await runSubscriptionAudit(userId).catch(e => { console.warn('[E] Subscription:', e.message); return 0 })
  results.doubleBill   = await runDoubleBillingDetection(userId).catch(e => { console.warn('[E] DoubleBill:', e.message); return 0 })
  const total = Object.values(results).reduce((s, n) => s + n, 0)
  if (total > 0) console.log(`[Phase E] user ${userId}: ${total} alerts fired`, results)
  return results
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function LOWER(s) { return (s || '').toLowerCase().trim() }
function fmt(n)   { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) }

function displayName(raw) {
  if (!raw) return 'Unknown'
  return raw.replace(/\s+/g, ' ').trim()
    .split(' ').slice(0, 4).join(' ')
}

function friendlyDate(str) {
  if (!str) return ''
  const d = new Date(str + 'T12:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function getWeekKey(date) {
  const d   = new Date(date)
  const jan = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan) / 86400000 + jan.getDay() + 1) / 7)
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`
}

function isAtm(name) {
  const n = (name || '').toLowerCase()
  return n.includes('atm') || n.includes('cash withdrawal') || n.includes('withdraw')
}

function ordinal(n) {
  const s = ['th','st','nd','rd']
  const v = n % 100
  return n + (s[(v-20)%10] || s[v] || s[0])
}

module.exports = {
  runAnomalyDetection,
  runPatternDetection,
  runSubscriptionAudit,
  runDoubleBillingDetection,
  runAllProactiveAlerts,
}
