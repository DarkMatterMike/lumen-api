const express     = require('express')
const router      = express.Router()
const pool        = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic   = require('@anthropic-ai/sdk')

const client = new Anthropic()
router.use(requireAuth)

// ─────────────────────────────────────────────────────────────
// UTILITY: computeEffectiveBalance
//
// Takes the raw reported balance of an account and subtracts
// any recurring charges that:
//   - were due on or before today (due today, yesterday, etc.)
//   - have NOT yet posted as a matching transaction
//
// Returns:
//   effectiveBalance  — what's really available
//   pendingItems      — list of items subtracted (for display)
//   missingItems      — items overdue beyond match window (flag to user)
// ─────────────────────────────────────────────────────────────
function computeEffectiveBalance(account, dueItems, recentTx) {
  const today    = new Date()
  today.setHours(0, 0, 0, 0)
  const MATCH_WINDOW_DAYS = 7   // look back up to 7 days for a posting
  const AMT_TOLERANCE     = 1.5 // dollar tolerance for amount matching

  let pendingDeduction = 0
  const pendingItems   = []
  const missingItems   = []

  for (const item of dueItems) {
    if (item.type === 'income') continue // don't deduct income

    const dueDate = new Date(item._dueDate)
    dueDate.setHours(0, 0, 0, 0)
    const daysOverdue = Math.floor((today - dueDate) / 86400000)

    // Only process items due today or in the past
    if (daysOverdue < 0) continue

    // Check if a matching transaction has already posted
    const posted = recentTx.some(tx => {
      if (tx.account_id !== account.id) return false
      const txAmt = Math.abs(Number(tx.amount))
      const expAmt = Number(item.amount)
      if (Math.abs(txAmt - expAmt) > AMT_TOLERANCE) return false

      const txDate = new Date(tx.date)
      const daysSinceTx = Math.floor((today - txDate) / 86400000)
      if (daysSinceTx > MATCH_WINDOW_DAYS + daysOverdue + 2) return false

      // Fuzzy merchant name match
      const txName  = (tx.cleaned_name || tx.name || '').toLowerCase()
      const recName = (item.name || '').toLowerCase()
      const recWords = recName.split(/\s+/).filter(w => w.length > 2)
      return recWords.some(w => txName.includes(w)) || txName.includes(recName.slice(0, 6))
    })

    if (posted) continue // already cleared — don't double-count

    pendingDeduction += Number(item.amount)
    const entry = { ...item, daysOverdue }

    if (daysOverdue > MATCH_WINDOW_DAYS) {
      // Overdue beyond match window — flag as potentially missing
      missingItems.push(entry)
    } else {
      pendingItems.push(entry)
    }
  }

  return {
    reportedBalance:  Number(account.balance),
    effectiveBalance: Number(account.balance) - pendingDeduction,
    pendingDeduction,
    pendingItems,
    missingItems,
  }
}

// ─────────────────────────────────────────────────────────────
// GET /api/paycheck/allocation
//
// Returns a full paycheck allocation breakdown:
//  - which paycheck triggered it (upcoming or just landed)
//  - per-account: reported balance, effective balance,
//    bills due, buffer target, amount needed from paycheck
//  - savings goal contributions
//  - surplus / deficit
//  - AI-generated plain-English summary
// ─────────────────────────────────────────────────────────────
router.get('/allocation', async (req, res, next) => {
  try {
    const uid   = req.user.id
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    // ── 1. Find the triggering paycheck ──────────────────────
    // "Triggering" = landed in last 48h OR arriving in next 3 days
    const { rows: recurring } = await pool.query(
      'SELECT * FROM recurring WHERE user_id=$1 AND active=TRUE ORDER BY day_of_month ASC',
      [uid]
    )

    const incomeItems = recurring.filter(r => r.type === 'income')

    // Build occurrence dates for this month and next
    const { getOccurrencesForMonth } = require('../db/recurringUtils')
    let allPaychecks = []
    for (const offset of [0, 1]) {
      const d = new Date(today)
      d.setMonth(d.getMonth() + offset)
      for (const r of incomeItems) {
        const dates = getOccurrencesForMonth(r, d.getFullYear(), d.getMonth())
        for (const date of dates) {
          allPaychecks.push({ ...r, _date: date })
        }
      }
    }
    allPaychecks.sort((a, b) => a._date - b._date)

    // Find paycheck within ±3 days of today
    const TRIGGER_WINDOW_DAYS = 3
    const triggerPaycheck = allPaychecks.find(p => {
      const daysFromToday = Math.round((p._date - today) / 86400000)
      return daysFromToday >= -2 && daysFromToday <= TRIGGER_WINDOW_DAYS
    }) || allPaychecks.find(p => p._date >= today)

    if (!triggerPaycheck) {
      return res.json({ hasPaycheck: false, reason: 'No upcoming paycheck found in recurring items.' })
    }

    const paycheckAmount = Number(triggerPaycheck.amount)
    const daysUntilPaycheck = Math.round((triggerPaycheck._date - today) / 86400000)
    const paycheckLanded  = daysUntilPaycheck <= 0

    // Check if paycheck has actually posted yet
    const paycheckPostedCheck = await pool.query(
      `SELECT id FROM transactions
       WHERE user_id=$1 AND amount > 0
         AND date >= $2::date - interval '2 days'
         AND date <= $2::date + interval '1 day'
         AND ABS(amount - $3) < 50
       LIMIT 1`,
      [uid, triggerPaycheck._date.toISOString().split('T')[0], paycheckAmount]
    )
    const paycheckPosted = paycheckPostedCheck.rows.length > 0

    // ── 2. Find next paycheck after this one (determines bill window) ─
    const nextPaychecks = allPaychecks.filter(p => p._date > triggerPaycheck._date)
    const nextPaycheck  = nextPaychecks[0] || null
    const windowEnd     = nextPaycheck
      ? new Date(nextPaycheck._date.getTime() - 86400000)
      : new Date(today.getTime() + 30 * 86400000)

    // ── 3. Load all accounts (non-debt) ──────────────────────
    const { rows: accounts } = await pool.query(
      `SELECT a.*, COALESCE(a.spending_buffer, 0) AS spending_buffer
       FROM accounts a
       WHERE a.user_id=$1 AND a.is_debt=FALSE
       ORDER BY
         (a.id IN (SELECT DISTINCT account_id FROM recurring WHERE user_id=$1 AND active=TRUE AND account_id IS NOT NULL)) DESC,
         a.include_in_balance DESC,
         a.balance DESC`,
      [uid]
    )

    // ── 4. Load recent transactions (for effective balance) ──
    const { rows: recentTx } = await pool.query(
      `SELECT id, account_id, name, cleaned_name, amount, date
       FROM transactions
       WHERE user_id=$1
         AND date >= CURRENT_DATE - interval '14 days'
       ORDER BY date DESC`,
      [uid]
    )

    // ── 5. Build per-account bill lists ──────────────────────
    // Bills due between today and windowEnd (before next paycheck)
    const billItems = recurring.filter(r => r.type !== 'income')
    const { getOccurrencesForMonth: getOcc } = require('../db/recurringUtils')

    // Get all bill occurrences in the window
    let allBillOccurrences = []
    for (const offset of [0, 1, 2]) {
      const d = new Date(today)
      d.setMonth(d.getMonth() + offset)
      for (const r of billItems) {
        const dates = getOcc(r, d.getFullYear(), d.getMonth())
        for (const date of dates) {
          if (date >= today && date <= windowEnd) {
            allBillOccurrences.push({ ...r, _dueDate: date })
          }
        }
      }
    }
    // Also include overdue items (due before today, not yet posted)
    let overdueOccurrences = []
    for (const r of billItems) {
      const dates = getOcc(r, today.getFullYear(), today.getMonth())
      for (const date of dates) {
        if (date < today) {
          overdueOccurrences.push({ ...r, _dueDate: date })
        }
      }
    }
    const allDueItems = [...overdueOccurrences, ...allBillOccurrences]

    // ── 6. Group bills by account ─────────────────────────────
    const billsByAccount = {}
    const unassignedBills = []
    for (const item of allDueItems) {
      if (item.account_id) {
        if (!billsByAccount[item.account_id]) billsByAccount[item.account_id] = []
        billsByAccount[item.account_id].push(item)
      } else {
        unassignedBills.push(item)
      }
    }

    // ── 7. Compute effective balance + allocation per account ─
    const accountBreakdowns = []
    let totalNeeded = 0

    for (const acct of accounts) {
      const dueForAcct  = allDueItems.filter(i => i.account_id === acct.id)
      const dueFuture   = allBillOccurrences.filter(i => i.account_id === acct.id)
      const dueOrOverdue = [...overdueOccurrences.filter(i => i.account_id === acct.id), ...dueFuture]

      const { effectiveBalance, reportedBalance, pendingDeduction, pendingItems, missingItems }
        = computeEffectiveBalance(acct, dueOrOverdue, recentTx)

      const futureBillsTotal = dueFuture.reduce((s, i) => s + Number(i.amount), 0)
      const buffer           = Number(acct.spending_buffer) || 0

      // How much this account needs:
      // future bills + buffer - what's effectively already there
      // (negative = account already funded, nothing needed from paycheck)
      const rawNeed  = futureBillsTotal + buffer - effectiveBalance
      const needFrom = Math.max(0, rawNeed)

      totalNeeded += needFrom

      // Skip accounts that need nothing AND have no bills
      const hasBills = dueOrOverdue.length > 0 || buffer > 0
      if (!hasBills && effectiveBalance > 0 && needFrom === 0) continue

      accountBreakdowns.push({
        id:              acct.id,
        name:            acct.name,
        type:            acct.type,
        icon:            acct.icon,
        mask:            acct.mask,
        reportedBalance,
        pendingDeduction,
        effectiveBalance,
        pendingItems:    pendingItems.map(i => ({ name: i.name, amount: Number(i.amount), daysOverdue: i.daysOverdue, dueDate: i._dueDate })),
        missingItems:    missingItems.map(i => ({ name: i.name, amount: Number(i.amount), daysOverdue: i.daysOverdue })),
        futureBills:     dueFuture.map(i => ({ name: i.name, amount: Number(i.amount), dueDate: i._dueDate, icon: i.icon })),
        futureBillsTotal,
        buffer,
        needFrom,
        alreadyFunded:   needFrom === 0,
      })
    }

    // ── 8. Savings goals ─────────────────────────────────────
    const { rows: goals } = await pool.query(
      `SELECT id, name, icon, color, type, target_amount, current_amount,
              monthly_contribution, paycheck_contribution, account_id
       FROM goals
       WHERE user_id=$1 AND active=TRUE
         AND type IN ('savings','emergency_fund')
       ORDER BY created_at ASC`,
      [uid]
    )

    const goalAllocations = goals.map(g => {
      const contrib = Number(g.paycheck_contribution || g.monthly_contribution || 0) / 2 // assume bimonthly paychecks
      totalNeeded += contrib
      return {
        id:         g.id,
        name:       g.name,
        icon:       g.icon,
        contrib,
        targetAmount:  Number(g.target_amount),
        currentAmount: Number(g.current_amount),
        accountId:  g.account_id,
      }
    }).filter(g => g.contrib > 0)

    // ── 9. Unassigned bills ───────────────────────────────────
    const unassignedTotal = unassignedBills.reduce((s, i) => s + Number(i.amount), 0)
    if (unassignedBills.length > 0) totalNeeded += unassignedTotal

    // ── 10. Surplus / deficit ─────────────────────────────────
    const surplus  = paycheckAmount - totalNeeded
    const isDeficit = surplus < 0

    // ── 11. AI summary ────────────────────────────────────────
    const contextLines = [
      `Paycheck: $${paycheckAmount.toFixed(2)} (${paycheckLanded ? 'just landed' : `in ${daysUntilPaycheck} days`}, ${paycheckPosted ? 'confirmed posted' : 'not yet posted'})`,
      `Coverage window: today → ${windowEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      '',
      'Account allocations:',
      ...accountBreakdowns.map(a =>
        `  ${a.name}: reported $${a.reportedBalance.toFixed(0)}, effective $${a.effectiveBalance.toFixed(0)}` +
        (a.pendingDeduction > 0 ? ` (-$${a.pendingDeduction.toFixed(0)} pending)` : '') +
        `, bills $${a.futureBillsTotal.toFixed(0)}, buffer $${a.buffer.toFixed(0)}, needs $${a.needFrom.toFixed(0)} from paycheck`
      ),
      '',
      goalAllocations.length > 0 ? `Savings goals: ${goalAllocations.map(g => `${g.name} $${g.contrib.toFixed(0)}`).join(', ')}` : '',
      unassignedBills.length > 0 ? `Unassigned bills: ${unassignedBills.map(b => `${b.name} $${Number(b.amount).toFixed(0)}`).join(', ')} = $${unassignedTotal.toFixed(0)}` : '',
      '',
      `Total needed: $${totalNeeded.toFixed(0)} / Paycheck: $${paycheckAmount.toFixed(0)} / ${isDeficit ? `DEFICIT $${Math.abs(surplus).toFixed(0)}` : `Surplus $${surplus.toFixed(0)}`}`,
    ].filter(Boolean)

    let summary = ''
    try {
      const aiRes = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `You are Lumen, a personal finance AI. Write a 2-3 sentence plain-English paycheck allocation summary. Be specific with dollar amounts. Start with the paycheck amount. Tell the user exactly where to move money and how much. Mention if the account is already funded. End with surplus or deficit.

${contextLines.join('\n')}`
        }]
      })
      summary = aiRes.content.find(b => b.type === 'text')?.text || ''
    } catch (e) {
      console.error('AI summary failed:', e.message)
      summary = `Your $${paycheckAmount.toFixed(0)} paycheck needs to cover ${accountBreakdowns.filter(a => !a.alreadyFunded).length} account(s). ${isDeficit ? `You're $${Math.abs(surplus).toFixed(0)} short this cycle.` : `You have $${surplus.toFixed(0)} left over.`}`
    }

    res.json({
      hasPaycheck:       true,
      paycheck: {
        amount:          paycheckAmount,
        name:            triggerPaycheck.name,
        date:            triggerPaycheck._date.toISOString().split('T')[0],
        daysUntil:       daysUntilPaycheck,
        landed:          paycheckLanded,
        posted:          paycheckPosted,
      },
      windowEnd:         windowEnd.toISOString().split('T')[0],
      accounts:          accountBreakdowns,
      goals:             goalAllocations,
      unassignedBills:   unassignedBills.map(b => ({ name: b.name, amount: Number(b.amount), icon: b.icon })),
      unassignedTotal,
      totalNeeded,
      paycheckAmount,
      surplus,
      isDeficit,
      summary,
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
