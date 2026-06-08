/**
 * accountForecast.js — Per-account cash-flow forecast for a fixed two-hop pipeline.
 *
 * Pipeline (fixed routes):
 *   Stearns ──(Fri, clears Mon: settleDays)──▶ Autopay ──(instant)──▶ Spending
 *
 *   Autopay  = source (Apex paycheck lands) + protected (pays all bills, feeds Spending)
 *   Spending = protected; topped up on-demand from Autopay (instant) → only at risk if Autopay can't cover it
 *   Stearns  = source (Stearns paycheck lands); funds Autopay; only misc shopping leaves it
 *
 * forecast_role on accounts: 'source' | 'protected' | 'ignore'.
 * We additionally identify the pipeline accounts by which recurring income lands where,
 * but the engine is general: every 'protected' account is projected and must stay >= cushion;
 * Autopay (the protected account that also receives income) is the hub that funds the others.
 *
 * Outputs per protected account: start, pace, trough, troughDate, safe, cause.
 * Recommendations:
 *   - If Spending would dip < cushion → instant top-up from Autopay (no settle lag).
 *   - If Autopay (incl. those top-ups + its bills) would dip < cushion → Stearns transfer,
 *     dated to the preceding Stearns payday Friday, must clear (settleDays) before the dip.
 *   - "safeToSave": how much Autopay can move to savings after covering everything through payday.
 */
const pool = require('../db/pool')
const { getOccurrencesForMonth } = require('../db/recurringUtils')

const DAY = 86400000
const iso = d => d.toISOString().slice(0, 10)
const round2 = n => Math.round(n * 100) / 100
const friendly = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
function businessDaysBefore(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00'); let left = n
  while (left > 0) { d.setDate(d.getDate() - 1); const w = d.getDay(); if (w !== 0 && w !== 6) left-- }
  return iso(d)
}
// nearest Friday on/before a date (the day the Stearns transfer would actually be sent)
function fridayOnOrBefore(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1)
  return iso(d)
}

async function buildAccountForecast(userId, opts = {}) {
  const settleDays = opts.settleDays ?? 2   // Stearns→Autopay (Fri→Mon)
  const cushion    = opts.cushion    ?? 100
  const horizonCap = opts.horizonDays ?? 35
  const today = new Date(); today.setHours(0, 0, 0, 0)

  // Select accounts; tolerate the forecast_role column not existing yet (migration not run).
  let accounts
  try {
    const r = await pool.query(
      `SELECT id, name, type, balance, mask, icon, forecast_role
       FROM accounts WHERE user_id = $1 AND COALESCE(is_debt,FALSE)=FALSE ORDER BY balance DESC`, [userId]
    )
    accounts = r.rows
  } catch (e) {
    if (e && /forecast_role/.test(e.message || '')) {
      // column missing → return an "unconfigured" result instead of crashing
      const r = await pool.query(
        `SELECT id, name, type, balance, mask, icon
         FROM accounts WHERE user_id = $1 AND COALESCE(is_debt,FALSE)=FALSE ORDER BY balance DESC`, [userId]
      )
      return {
        horizonDays: 0, nextPayDate: null, settleDays, cushion,
        hubAccountId: null, stearnsAccountId: null, safeToSave: 0,
        accounts: [], sources: [], recommendations: [],
        unconfigured: true,
        needsMigration: true,
      }
    }
    throw e
  }
  const role = a => (a.forecast_role || 'ignore')
  const protectedAccts = accounts.filter(a => role(a) === 'protected')
  const sourceAccts    = accounts.filter(a => role(a) === 'source')

  const { rows: recurring } = await pool.query(
    'SELECT * FROM recurring WHERE user_id = $1 AND active = TRUE', [userId]
  )
  const incomes = recurring.filter(r => (r.type || '') === 'income')

  // ── occurrences helper: all dated occurrences of a recurring item from today forward ──
  function occurrences(r) {
    const out = []
    for (let mo = 0; mo <= 2; mo++) {
      const dd = new Date(today); dd.setMonth(dd.getMonth() + mo)
      for (const occ of getOccurrencesForMonth(r, dd.getFullYear(), dd.getMonth()))
        if (occ >= today) out.push(iso(occ))
    }
    return out
  }

  // ── next paycheck (any income) → horizon ──
  let nextPayDate = null
  for (const r of incomes) for (const dstr of occurrences(r))
    if (!nextPayDate || dstr < nextPayDate) nextPayDate = dstr
  const horizonDays = nextPayDate
    ? Math.min(horizonCap, Math.max(1, Math.round((new Date(nextPayDate + 'T12:00:00') - today) / DAY) + 1))
    : horizonCap

  // ── Discretionary pace per account ──
  // Robust anti-double-count: take each account's 60-day outflow total, then SUBTRACT
  // the recurring-bill spend we already model as scheduled events. Whatever remains is
  // genuinely discretionary (gas/groceries on Spending, shopping on Stearns). A bills-only
  // hub like Autopay nets to ~0, so it gets no phantom pace.
  const { rows: spendRows } = await pool.query(
    `SELECT account_id, COALESCE(SUM(ABS(amount)),0) AS spent
     FROM transactions WHERE user_id=$1 AND amount<0
       AND COALESCE(tx_type,'expense') NOT IN ('income','transfer')
       AND account_id IS NOT NULL AND date >= CURRENT_DATE - INTERVAL '60 days' AND date < CURRENT_DATE
     GROUP BY account_id`, [userId]
  )
  // recurring monthly bill total per account, scaled to 60 days (≈ 2 months)
  const recurringMonthlyByAccount = {}
  for (const r of recurring) {
    if (!r.account_id || (r.type || '') === 'income') continue
    recurringMonthlyByAccount[r.account_id] = (recurringMonthlyByAccount[r.account_id] || 0) + Number(r.amount || 0)
  }
  const paceByAccount = {}
  for (const r of spendRows) {
    const total60 = Number(r.spent) || 0
    const billPortion60 = (recurringMonthlyByAccount[r.account_id] || 0) * 2  // ~2 months in 60 days
    const discretionary60 = Math.max(0, total60 - billPortion60)
    paceByAccount[r.account_id] = discretionary60 / 60
  }
  // The hub (Autopay) is bills-only by definition → force pace to 0 regardless of noisy history.
  // (set after we identify the hub, below)

  // ── recurring events (bills + income) per account, keyed by date ──
  const evByAccount = {}
  for (const a of accounts) evByAccount[a.id] = {}
  for (const r of recurring) {
    if (!r.account_id || !evByAccount[r.account_id]) continue
    for (const dstr of occurrences(r)) {
      ;(evByAccount[r.account_id][dstr] ||= []).push({
        name: r.name, amount: Number(r.amount), type: r.type || 'expense',
        icon: r.icon || (r.type === 'income' ? '💰' : '📄'),
      })
    }
  }

  // ── project one account: returns daily points + trough (ignoring inter-account transfers) ──
  function project(a, extraOutflows = {}) {
    const pace = paceByAccount[a.id] || 0
    const ev = evByAccount[a.id]
    const points = []
    let bal = Number(a.balance) || 0
    let trough = { balance: bal, date: iso(today) }, cause = null
    for (let i = 0; i < horizonDays; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i); const key = iso(d)
      const evts = ev[key] || []
      let delta = 0, hadIncome = false
      for (const e of evts) { if (e.type === 'income') { delta += e.amount; hadIncome = true } else delta -= e.amount }
      if (!hadIncome) delta -= pace
      if (extraOutflows[key]) delta -= extraOutflows[key]
      bal = round2(bal + delta)
      points.push({ date: key, balance: bal, events: evts, delta: round2(delta) })
      if (bal < trough.balance) {
        trough = { balance: bal, date: key }
        const bills = evts.filter(e => e.type !== 'income')
        if (bills.length) cause = bills.reduce((m, e) => e.amount > (m?.amount || 0) ? e : m, cause)
      }
    }
    return { pace: round2(pace), points, trough, cause }
  }

  // ── identify pipeline hub: the protected account that also receives income (Autopay) ──
  const incomeAcctIds = new Set(incomes.map(r => r.account_id).filter(Boolean))
  const hub = protectedAccts.find(a => incomeAcctIds.has(a.id)) || null   // Autopay
  if (hub) paceByAccount[hub.id] = 0   // bills-only hub: no discretionary pace
  const spendingAccts = protectedAccts.filter(a => !hub || a.id !== hub.id) // Spending (+any other protected)
  // Stearns = a source account that is NOT the hub
  const stearns = sourceAccts.find(a => !hub || a.id !== hub.id) || null

  const recommendations = []

  // STEP 1 — project each Spending account; on-demand instant top-up from hub when it would dip < cushion.
  // Record the per-date top-up the hub must provide.
  const hubExtra = {}   // date → amount hub must forward to Spending that day
  const spendingOut = []
  for (const s of spendingAccts) {
    const { pace, points, trough, cause } = project(s)
    let topUpTotal = 0, firstDipDate = null
    if (trough.balance < cushion) {
      // simulate day-by-day, refilling to cushion the day it would go under
      const p = paceByAccount[s.id] || 0
      const ev = evByAccount[s.id]
      let bal = Number(s.balance) || 0
      for (let i = 0; i < horizonDays; i++) {
        const d = new Date(today); d.setDate(d.getDate() + i); const key = iso(d)
        const evts = ev[key] || []
        let delta = 0, hadIncome = false
        for (const e of evts) { if (e.type === 'income') { delta += e.amount; hadIncome = true } else delta -= e.amount }
        if (!hadIncome) delta -= p
        bal = round2(bal + delta)
        if (bal < cushion) {
          const need = round2(cushion - bal)
          hubExtra[key] = round2((hubExtra[key] || 0) + need)
          bal = cushion
          topUpTotal = round2(topUpTotal + need)
          if (!firstDipDate) firstDipDate = key
        }
      }
    }
    spendingOut.push({
      id: s.id, name: s.name, type: s.type, icon: s.icon, mask: s.mask, role: 'protected',
      startBalance: round2(Number(s.balance) || 0), dailyPace: pace, cushion,
      trough: trough.balance, troughDate: trough.date, safe: trough.balance >= cushion,
      troughCause: cause ? { name: cause.name, amount: cause.amount } : null, points,
    })
    if (topUpTotal > 0 && hub) {
      recommendations.push({
        kind: 'instant',
        from_account_id: hub.id, from_account_name: hub.name,
        to_account_id: s.id, to_account_name: s.name,
        amount: Math.ceil(topUpTotal / 10) * 10,
        send_by: firstDipDate,
        reason: `${s.name} would dip below $${cushion} starting ${friendly(firstDipDate)}. Top it up from ${hub.name} (instant) — about $${Math.ceil(topUpTotal/10)*10} keeps it above your cushion through payday.`,
      })
    }
  }

  // STEP 2 — project the hub (Autopay) INCLUDING the Spending top-ups it must forward.
  let hubOut = null, safeToSave = 0
  if (hub) {
    const { pace, points, trough, cause } = project(hub, hubExtra)
    hubOut = {
      id: hub.id, name: hub.name, type: hub.type, icon: hub.icon, mask: hub.mask, role: 'protected+source',
      startBalance: round2(Number(hub.balance) || 0), dailyPace: pace, cushion,
      trough: trough.balance, troughDate: trough.date, safe: trough.balance >= cushion,
      troughCause: cause ? { name: cause.name, amount: cause.amount } : null, points,
    }
    // STEP 3 — if hub would dip < cushion, recommend a Stearns→hub transfer.
    if (trough.balance < cushion && stearns) {
      const deficit = round2(cushion - trough.balance)
      const amount = Math.ceil(deficit / 10) * 10
      // ideal send date = Friday on/before (troughDate − settleDays business days)
      const idealSend = fridayOnOrBefore(businessDaysBefore(trough.date, settleDays))
      const todayStr = iso(today)
      // never recommend a past date — if ideal already passed, send ASAP (today)
      const isLate = idealSend < todayStr
      const sendBy = isLate ? todayStr : idealSend
      const clearsBy = (() => {            // when an ASAP transfer would actually land
        const d = new Date(todayStr + 'T12:00:00'); let n = settleDays
        while (n > 0) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n-- }
        return iso(d)
      })()
      recommendations.push({
        kind: 'transfer',
        urgent: isLate,
        from_account_id: stearns.id, from_account_name: stearns.name,
        to_account_id: hub.id, to_account_name: hub.name,
        amount,
        trough: trough.balance, trough_date: trough.date, send_by: sendBy,
        reason: isLate
          ? `${hub.name} dips to $${trough.balance} by ${friendly(trough.date)}${cause ? ` (around ${cause.name} $${cause.amount})` : ''}. The ideal send date has passed — send $${amount} from ${stearns.name} ASAP; it should clear around ${friendly(clearsBy)} (1–2 business days).`
          : `${hub.name} dips to $${trough.balance} by ${friendly(trough.date)}${cause ? ` (around ${cause.name} $${cause.amount})` : ''}, counting its bills + Spending top-ups. Send $${amount} from ${stearns.name} by ${friendly(sendBy)} so it clears in time.`,
      })
    }
    // STEP 4 — safe-to-save: how much the hub can release to savings and still
    // stay >= cushion at its lowest point (after bills + top-ups + any Stearns transfer).
    // Conservative: based on current projection without assuming the Stearns transfer.
    safeToSave = Math.max(0, Math.floor((trough.balance - cushion) / 10) * 10)
  }

  // attach safeToSave to the hub output + as a note on transfer actions
  if (hubOut) hubOut.safeToSave = safeToSave

  const accountsOut = [hubOut, ...spendingOut].filter(Boolean)

  // order actions by the date you'd actually do them (earliest first)
  recommendations.sort((a, b) => String(a.send_by || '').localeCompare(String(b.send_by || '')))

  return {
    horizonDays, nextPayDate, settleDays, cushion,
    hubAccountId: hub?.id || null,
    stearnsAccountId: stearns?.id || null,
    safeToSave,
    accounts: accountsOut,
    sources: sourceAccts.map(a => {
      const { pace, trough, points } = project(a)
      return { id: a.id, name: a.name, startBalance: round2(Number(a.balance)||0), dailyPace: pace, trough: trough.balance, troughDate: trough.date, points }
    }),
    recommendations,
    unconfigured: accounts.every(a => !a.forecast_role),
  }
}

module.exports = { buildAccountForecast }
