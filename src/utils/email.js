const { Resend } = require('resend')

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM   = process.env.EMAIL_FROM || 'Lumen <hello@lumenfinance.com>'
const FRONTEND = process.env.FRONTEND_URL || 'https://lumenfinance.com'

// ── Brand colors ─────────────────────────────────────────────
const C = {
  bg:    '#040608',
  card:  '#0d1117',
  border:'#1c2230',
  safe:  '#5dcaa5',
  ink0:  '#f4f4f1',
  ink2:  '#7c8494',
  ink3:  '#4a5161',
}

// ── Base template wrapper ─────────────────────────────────────
function base({ title, preheader = '', body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body,html{margin:0;padding:0;background:${C.bg};font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;}
  .wrap{max-width:560px;margin:0 auto;padding:40px 20px 60px;}
  .logo{text-align:center;margin-bottom:32px;}
  .logo-text{font-size:28px;font-weight:300;color:${C.safe};letter-spacing:-0.5px;}
  .logo-dot{display:inline-block;width:8px;height:8px;background:${C.safe};border-radius:50%;margin-right:6px;vertical-align:middle;box-shadow:0 0 10px rgba(93,202,165,.6);}
  .card{background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:32px 32px;margin-bottom:16px;}
  .card-title{font-size:22px;font-weight:300;color:${C.ink0};margin:0 0 8px;line-height:1.3;}
  .card-body{font-size:14px;color:${C.ink2};line-height:1.7;margin:0 0 24px;}
  .card-body strong{color:${C.ink0};font-weight:500;}
  .btn{display:inline-block;padding:13px 28px;background:rgba(93,202,165,.1);border:1px solid rgba(93,202,165,.35);border-radius:10px;color:${C.safe};text-decoration:none;font-size:12px;font-family:monospace;letter-spacing:1px;text-transform:uppercase;}
  .btn:hover{background:${C.safe};color:#040608;}
  .divider{border:none;border-top:1px solid ${C.border};margin:24px 0;}
  .meta{font-size:11px;color:${C.ink3};line-height:1.6;}
  .meta a{color:${C.ink2};text-decoration:none;}
  .stat-row{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-bottom:1px solid ${C.border};}
  .stat-row:last-child{border-bottom:none;}
  .stat-label{font-size:12px;color:${C.ink2};}
  .stat-val{font-size:14px;color:${C.ink0};font-family:monospace;}
  .stat-val.green{color:${C.safe};}
  .stat-val.red{color:#e87363;}
  .footer{text-align:center;padding-top:8px;}
</style>
</head>
<body>
<!-- preheader hidden -->
<div style="display:none;max-height:0;overflow:hidden;">${preheader}</div>
<div class="wrap">
  <div class="logo">
    <span class="logo-dot"></span>
    <span class="logo-text">Lumen</span>
  </div>
  ${body}
  <div class="footer">
    <p class="meta">
      Your financial picture, clearly.<br>
      <a href="${FRONTEND}/settings">Manage preferences</a> &nbsp;·&nbsp;
      <a href="${FRONTEND}/privacy">Privacy Policy</a>
    </p>
  </div>
</div>
</body>
</html>`
}

// ── Send helper — never throws, always logs ───────────────────
async function send({ to, subject, html, text }) {
  try {
    const result = await resend.emails.send({
      from: FROM, to, subject, html,
      text: text || subject,
    })
    console.log(`[Email] Sent "${subject}" to ${to}`, result.id)
    return result
  } catch (err) {
    console.error(`[Email] Failed to send "${subject}" to ${to}:`, err.message)
    return null
  }
}

// ══════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════

// 1. Welcome email ─────────────────────────────────────────────
async function sendWelcome({ email, name }) {
  const firstName = (name || email).split(' ')[0].split('@')[0]
  const html = base({
    title: `Welcome to Lumen`,
    preheader: `Your financial picture starts now.`,
    body: `
      <div class="card">
        <div class="card-title">Welcome, ${firstName}.</div>
        <p class="card-body">
          Lumen is now tracking your financial picture. Here's what to do first:
        </p>
        <div style="margin-bottom:24px;">
          <div class="stat-row">
            <span class="stat-label">① Add an account</span>
            <span class="stat-val">Connect bank or enter manually</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">② Set up recurring items</span>
            <span class="stat-val">Bills, subscriptions, paychecks</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">③ Create a budget</span>
            <span class="stat-val">Pick one category to start</span>
          </div>
        </div>
        <a href="${FRONTEND}/dashboard" class="btn">Open Lumen →</a>
      </div>
      <div class="card">
        <p class="meta" style="margin:0;">
          Lumen reads your balance, upcoming bills, and spending patterns in real time.
          The big number on your dashboard is what you can actually spend today —
          after all bills due in the next 30 days.
        </p>
      </div>`
  })
  return send({ to: email, subject: 'Welcome to Lumen', html,
    text: `Welcome to Lumen, ${firstName}. Open your dashboard: ${FRONTEND}/dashboard` })
}

// 2. Family invite email ───────────────────────────────────────
async function sendFamilyInvite({ toEmail, toName, fromName, inviteCode }) {
  const inviteUrl = `${FRONTEND}/family/join/${inviteCode}`
  const html = base({
    title: 'You've been invited to Lumen',
    preheader: `${fromName} wants to share their financial picture with you.`,
    body: `
      <div class="card">
        <div class="card-title">${fromName} invited you to their family plan.</div>
        <p class="card-body">
          You've been invited to join <strong>${fromName}'s</strong> Lumen family plan.
          You'll be able to see shared accounts and transactions, and keep individual
          items private to yourself.
        </p>
        <div style="margin-bottom:24px;">
          <div class="stat-row">
            <span class="stat-label">Shared accounts</span>
            <span class="stat-val green">Visible</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Shared transactions</span>
            <span class="stat-val green">Visible</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Private transactions</span>
            <span class="stat-val">Your choice</span>
          </div>
        </div>
        <a href="${inviteUrl}" class="btn">Accept Invite →</a>
      </div>
      <div class="card">
        <p class="meta" style="margin:0;">
          This invite link is unique and can only be used once. If you don't have a
          Lumen account yet, you'll be able to create one after clicking the link.
          Link expires in 7 days.
        </p>
      </div>`
  })
  const toAddr = toName ? `${toName} <${toEmail}>` : toEmail
  return send({ to: toAddr, subject: `${fromName} invited you to Lumen`, html,
    text: `${fromName} invited you to join their Lumen family plan. Accept: ${inviteUrl}` })
}

// 3. Subscription confirmation ─────────────────────────────────
async function sendSubscriptionConfirmed({ email, name, plan, periodEnd }) {
  const firstName = (name || email).split(' ')[0]
  const planLabel = plan === 'pro' ? 'Lumen Pro' : 'Lumen Plus'
  const price     = plan === 'pro' ? '$9.99' : '$4.99'
  const perks     = plan === 'pro'
    ? ['Live bank sync via Plaid', 'Family plan (up to 3 members)', 'Per-transaction privacy controls']
    : ['Live bank sync via Plaid', 'Auto transaction import', 'Real-time balance updates']
  const endDate = periodEnd
    ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'next month'

  const html = base({
    title: `You're now on ${planLabel}`,
    preheader: `${planLabel} is active. Thank you for subscribing.`,
    body: `
      <div class="card">
        <div class="card-title">You're on ${planLabel}, ${firstName}.</div>
        <p class="card-body">
          Your subscription is active. Here's what you now have access to:
        </p>
        <div style="margin-bottom:24px;">
          ${perks.map(p => `
          <div class="stat-row">
            <span class="stat-label">✓ &nbsp;${p}</span>
            <span class="stat-val green">Active</span>
          </div>`).join('')}
          <div class="stat-row">
            <span class="stat-label">Next billing date</span>
            <span class="stat-val">${endDate}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Amount</span>
            <span class="stat-val">${price}/mo</span>
          </div>
        </div>
        <a href="${FRONTEND}/accounts" class="btn">Connect Your Bank →</a>
      </div>
      <div class="card">
        <p class="meta" style="margin:0;">
          You can manage or cancel your subscription anytime in
          <a href="${FRONTEND}/settings">Settings → Plan</a>.
          Questions? Reply to this email.
        </p>
      </div>`
  })
  return send({ to: email, subject: `You're now on ${planLabel} — welcome`, html,
    text: `Your ${planLabel} subscription is active. Manage at ${FRONTEND}/settings` })
}

// 4. Subscription cancelled ────────────────────────────────────
async function sendSubscriptionCancelled({ email, name, plan, periodEnd }) {
  const firstName = (name || email).split(' ')[0]
  const planLabel = plan === 'pro' ? 'Lumen Pro' : 'Lumen Plus'
  const endDate   = periodEnd
    ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'end of billing period'

  const html = base({
    title: `Your ${planLabel} subscription has ended`,
    preheader: `Your plan has been downgraded to Free.`,
    body: `
      <div class="card">
        <div class="card-title">Your ${planLabel} plan has ended.</div>
        <p class="card-body">
          ${firstName}, your ${planLabel} subscription ended on <strong>${endDate}</strong>.
          Your account has been moved to the free plan. Your data is all still there —
          you just won't have access to paid features until you resubscribe.
        </p>
        <div style="margin-bottom:24px;">
          <div class="stat-row">
            <span class="stat-label">Bank sync (Plaid)</span>
            <span class="stat-val red">Paused</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Your transactions & budgets</span>
            <span class="stat-val green">Safe</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Manual entry & CSV import</span>
            <span class="stat-val green">Still available</span>
          </div>
        </div>
        <a href="${FRONTEND}/pricing" class="btn">Resubscribe →</a>
      </div>`
  })
  return send({ to: email, subject: `Your ${planLabel} subscription has ended`, html,
    text: `Your ${planLabel} plan ended. Your data is safe. Resubscribe at ${FRONTEND}/pricing` })
}

// 5. Payment failed ────────────────────────────────────────────
async function sendPaymentFailed({ email, name, plan }) {
  const firstName = (name || email).split(' ')[0]
  const planLabel = plan === 'pro' ? 'Lumen Pro' : 'Lumen Plus'
  const html = base({
    title: 'Payment issue with your Lumen subscription',
    preheader: 'Action needed — update your payment method.',
    body: `
      <div class="card">
        <div class="card-title">We couldn't process your payment.</div>
        <p class="card-body">
          ${firstName}, the payment for your <strong>${planLabel}</strong> subscription
          didn't go through. This is usually a temporary issue with your card.
          Update your payment method to keep your plan active.
        </p>
        <a href="${FRONTEND}/settings" class="btn" style="margin-bottom:16px;display:inline-block;">Update Payment →</a>
        <hr class="divider">
        <p class="meta" style="margin:0;">
          We'll try again in a few days. If payment continues to fail, your account
          will be moved to the free plan. Your data will remain safe.
        </p>
      </div>`
  })
  return send({ to: email, subject: 'Action needed — Lumen payment failed', html,
    text: `We couldn't process your ${planLabel} payment. Update at ${FRONTEND}/settings` })
}

// 6. Password changed ─────────────────────────────────────────
async function sendPasswordChanged({ email, name }) {
  const firstName = (name || email).split(' ')[0]
  const now = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  const html = base({
    title: 'Your Lumen password was changed',
    preheader: 'Security notice — your password was updated.',
    body: `
      <div class="card">
        <div class="card-title">Password changed.</div>
        <p class="card-body">
          ${firstName}, your Lumen password was changed on <strong>${now}</strong>.
          If you made this change, you're all set — no action needed.
        </p>
        <p class="card-body" style="margin-bottom:24px;">
          If you <strong>did not</strong> make this change, your account may be compromised.
          Reset your password immediately.
        </p>
        <a href="${FRONTEND}/settings" class="btn">Secure My Account →</a>
      </div>`
  })
  return send({ to: email, subject: 'Your Lumen password was changed', html,
    text: `Your Lumen password was changed at ${now}. If this wasn't you, go to ${FRONTEND}/settings` })
}

// 7. Weekly digest ────────────────────────────────────────────
async function sendWeeklyDigest({ email, name, stats }) {
  const firstName = (name || email).split(' ')[0]
  const { balance = 0, spent = 0, upcomingBills = [], nextPaycheck } = stats
  const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const html = base({
    title: 'Your Lumen weekly summary',
    preheader: `Balance: $${fmt(balance)} · ${upcomingBills.length} bills coming up`,
    body: `
      <div class="card">
        <div class="card-title">Your week at a glance, ${firstName}.</div>
        <div>
          <div class="stat-row">
            <span class="stat-label">Current balance</span>
            <span class="stat-val green">$${fmt(balance)}</span>
          </div>
          <div class="stat-row">
            <span class="stat-label">Spent this week</span>
            <span class="stat-val">$${fmt(spent)}</span>
          </div>
          ${nextPaycheck ? `
          <div class="stat-row">
            <span class="stat-label">Next paycheck</span>
            <span class="stat-val green">$${fmt(nextPaycheck.amount)} in ${nextPaycheck.daysUntil} days</span>
          </div>` : ''}
          ${upcomingBills.slice(0, 4).map(b => `
          <div class="stat-row">
            <span class="stat-label">${b.name}</span>
            <span class="stat-val red">−$${fmt(b.amount)} in ${b.daysUntil} days</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="card" style="text-align:center;">
        <a href="${FRONTEND}/dashboard" class="btn">Open Dashboard →</a>
      </div>`
  })
  return send({ to: email, subject: `Your Lumen summary — $${fmt(balance)} available`, html,
    text: `Balance: $${fmt(balance)}. Spent this week: $${fmt(spent)}. Open: ${FRONTEND}/dashboard` })
}

module.exports = {
  sendWelcome,
  sendFamilyInvite,
  sendSubscriptionConfirmed,
  sendSubscriptionCancelled,
  sendPaymentFailed,
  sendPasswordChanged,
  sendWeeklyDigest,
}
