const { Resend } = require('resend')

const resend   = new Resend(process.env.RESEND_API_KEY)
const FROM     = process.env.EMAIL_FROM || 'Lumen <hello@lumenfinance.app>'
const FRONTEND = process.env.FRONTEND_URL || 'https://lumenfinance.app'

// ── Brand tokens ──────────────────────────────────────────────
const C = {
  green:      '#5dcaa5',
  greenLight: '#edfaf4',
  greenDark:  '#1a6b52',
  greenMid:   '#2a9e74',
  red:        '#e87363',
  redLight:   '#fff0ee',
  amber:      '#f0b04c',
  bg:         '#f6f8fa',
  surface:    '#ffffff',
  border:     '#e2e8f0',
  borderLight:'#f1f5f9',
  ink:        '#0f172a',
  ink2:       '#475569',
  ink3:       '#94a3b8',
  mono:       'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
  sans:       '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
}

function base({ title, preheader = '', body, accentLine = true }) {
  // ── FIX 1: Solid color instead of linear-gradient (Gmail strips gradients)
  const accent = accentLine
    ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
         <tr>
           <td width="40%" height="3" style="background-color:${C.green};font-size:0;line-height:0;">&nbsp;</td>
           <td width="40%" height="3" style="background-color:${C.greenMid};font-size:0;line-height:0;">&nbsp;</td>
           <td width="20%" height="3" style="background-color:${C.greenDark};font-size:0;line-height:0;">&nbsp;</td>
         </tr>
       </table>`
    : ''

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${title}</title>
  <!--[if mso]>
  <noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
  <![endif]-->
  <style type="text/css">
    /* ── Reset ── */
    body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    body { margin: 0 !important; padding: 0 !important; }

    /* ── Gmail Android font-size fix ── */
    u + .email-body a { color: inherit !important; text-decoration: none !important;
      font-size: inherit !important; font-weight: inherit !important; line-height: inherit !important; }

    /* ── Apple Mail / iOS dark mode — force light ── */
    @media (prefers-color-scheme: dark) {
      .email-bg   { background-color: #f6f8fa !important; }
      .email-card { background-color: #ffffff !important; border-color: #e2e8f0 !important; }
      .email-text { color: #0f172a !important; }
      .email-sub  { color: #475569 !important; }
    }

    /* ── Mobile responsive ── */
    @media only screen and (max-width: 620px) {
      .email-container { width: 100% !important; max-width: 100% !important; }
      .email-padding   { padding: 24px 20px 28px !important; }
    }
  </style>
</head>
<body class="email-body" style="margin:0;padding:0;background-color:${C.bg};">

<!-- Preheader (hidden preview text) -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>

<!-- Wrapper -->
<table class="email-bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.bg};">
  <tr>
    <td align="center" style="padding:40px 16px 60px;">

      <!-- Max-width container -->
      <table class="email-container" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <!-- Logo -->
        <tr>
          <td align="center" style="padding-bottom:28px;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:8px;vertical-align:middle;">
                  <!--
                    FIX 2: Replace radialGradient orb (Gmail strips SVG <defs> entirely).
                    Use layered solid circles to simulate depth — no defs, no filter needed.
                  -->
                  <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <!-- Base dark outer ring -->
                    <circle cx="12" cy="12" r="11" fill="${C.greenDark}"/>
                    <!-- Mid layer -->
                    <circle cx="12" cy="12" r="9" fill="${C.greenMid}"/>
                    <!-- Bright center -->
                    <circle cx="12" cy="12" r="7" fill="${C.green}"/>
                    <!-- Highlight specular — no rgba, use solid with opacity attribute -->
                    <ellipse cx="9.5" cy="8.5" rx="3" ry="2" fill="white" opacity="0.45" transform="rotate(-15 9.5 8.5)"/>
                  </svg>
                </td>
                <td style="vertical-align:middle;">
                  <span style="font-family:${C.sans};font-size:20px;font-weight:300;color:#0f172a;letter-spacing:-0.3px;">Lumen</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Card
             FIX 3: Remove box-shadow (Gmail strips it) and overflow:hidden (breaks border-radius).
             Use border only — clean and consistent across all clients.
        -->
        <tr>
          <td class="email-card" style="background-color:${C.surface};border:1px solid ${C.border};border-radius:12px;">
            ${accent}
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="email-padding" style="padding:32px 36px 36px;">
                  ${body}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td align="center" style="padding-top:24px;">
            <p style="margin:0;font-family:${C.sans};font-size:11px;color:${C.ink3};line-height:1.6;">
              Your financial picture, clearly.
            </p>
            <p style="margin:6px 0 0;font-family:${C.sans};font-size:11px;color:${C.ink3};line-height:1.6;">
              <a href="${FRONTEND}/settings" style="color:${C.ink3};text-decoration:underline;">Manage preferences</a>
              &nbsp;&middot;&nbsp;
              <a href="${FRONTEND}/privacy" style="color:${C.ink3};text-decoration:underline;">Privacy Policy</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`
}

// ── Inner components ──────────────────────────────────────────

function heading(text) {
  return `<h1 style="margin:0 0 12px;font-family:${C.sans};font-size:24px;font-weight:600;color:${C.ink};line-height:1.3;letter-spacing:-0.3px;">${text}</h1>`
}

function para(text, style = '') {
  return `<p style="margin:0 0 20px;font-family:${C.sans};font-size:15px;color:${C.ink2};line-height:1.7;${style}">${text}</p>`
}

function ctaButton(label, url, style = '') {
  // FIX 4: VML button for Outlook + standard <a> for everyone else.
  // The <a> uses line-height instead of padding so Gmail renders it reliably.
  return `
    <table cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;margin-bottom:8px;${style}">
      <tr>
        <td align="center">
          <!--[if mso]>
          <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}"
            style="height:44px;v-text-anchor:middle;width:220px;"
            arcsize="22%" strokecolor="${C.greenDark}" fillcolor="${C.green}">
            <w:anchorlock/>
            <center style="color:#ffffff;font-family:sans-serif;font-size:14px;font-weight:bold;">${label}</center>
          </v:roundrect>
          <![endif]-->
          <!--[if !mso]><!-->
          <a href="${url}" target="_blank"
             style="background-color:${C.green};border-radius:8px;color:#ffffff;display:inline-block;
                    font-family:${C.sans};font-size:14px;font-weight:600;line-height:44px;
                    text-align:center;text-decoration:none;width:220px;
                    -webkit-text-size-adjust:none;mso-hide:all;">
            ${label}
          </a>
          <!--<![endif]-->
        </td>
      </tr>
    </table>`
}

function divider() {
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr><td height="1" style="background-color:${C.borderLight};font-size:0;line-height:0;">&nbsp;</td></tr>
  </table>`
}

function statTable(rows) {
  const rowsHtml = rows.map(r => `
    <tr>
      <td style="padding:11px 0;font-family:${C.sans};font-size:13px;color:${C.ink2};border-bottom:1px solid ${C.borderLight};">${r.label}</td>
      <td style="padding:11px 0;font-family:${C.mono};font-size:13px;color:${r.color || C.ink};text-align:right;border-bottom:1px solid ${C.borderLight};">${r.value}</td>
    </tr>`).join('')
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px;">
      ${rowsHtml}
    </table>`
}

function badge(text, color = C.green, bg = C.greenLight) {
  return `<span style="display:inline-block;padding:3px 10px;background-color:${bg};color:${color};font-family:${C.sans};font-size:11px;font-weight:600;border-radius:20px;letter-spacing:0.3px;text-transform:uppercase;">${text}</span>`
}

function note(text) {
  return `<p style="margin:16px 0 0;font-family:${C.sans};font-size:12px;color:${C.ink3};line-height:1.6;">${text}</p>`
}

// ── Send ──────────────────────────────────────────────────────
async function send({ to, subject, html, text }) {
  try {
    const result = await resend.emails.send({ from: FROM, to, subject, html, text: text || subject })
    if (result.error) {
      console.error(`[Email] Resend error for "${subject}" to ${to}:`, JSON.stringify(result.error))
      return null
    }
    console.log(`[Email] Sent "${subject}" to ${to} — id: ${result.data?.id}`)
    return result.data
  } catch (err) {
    console.error(`[Email] Failed to send "${subject}" to ${to}:`, err.message)
    return null
  }
}

// ══════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════

async function sendWelcome({ email, name }) {
  const firstName = (name || email).split(' ')[0].split('@')[0]
  const html = base({
    title: 'Welcome to Lumen',
    preheader: 'Your financial picture starts now.',
    body: `
      ${heading(`Welcome, ${firstName}.`)}
      ${para("Lumen is now tracking your financial picture. Here's how to get the most out of it:")}
      ${statTable([
        { label: '① Connect an account',       value: 'Bank sync or manual entry' },
        { label: '② Add your recurring items',  value: 'Bills, paycheck, subscriptions' },
        { label: '③ Set one budget',             value: 'Pick a category to track' },
      ])}
      ${ctaButton('Open Lumen →', `${FRONTEND}/dashboard`)}
      ${divider()}
      ${note('The big number on your dashboard is what you can actually spend — after all bills due before your next paycheck.')}
    `
  })
  return send({ to: email, subject: 'Welcome to Lumen', html,
    text: `Welcome to Lumen, ${firstName}. Open your dashboard: ${FRONTEND}/dashboard` })
}

async function sendFamilyInvite({ toEmail, toName, fromName, inviteCode }) {
  const inviteUrl = `${FRONTEND}/family/join/${inviteCode}`
  const html = base({
    title: "You've been invited to Lumen",
    preheader: `${fromName} invited you to their Lumen family plan.`,
    body: `
      ${heading(`${fromName} invited you.`)}
      ${para(`<strong style="color:${C.ink};">${fromName}</strong> wants to share their financial picture with you on Lumen — a personal finance app that tracks balances, bills, and spending in real time.`)}
      ${statTable([
        { label: 'Shared accounts',      value: 'Visible',     color: C.greenDark },
        { label: 'Shared transactions',  value: 'Visible',     color: C.greenDark },
        { label: 'Private items',        value: 'Your choice', color: C.ink2 },
      ])}
      ${ctaButton('Accept Invite →', inviteUrl)}
      ${note("This link is unique to you and expires in 7 days. If you don't have a Lumen account yet, you can create one after clicking the link.")}
    `
  })
  const toAddr = toName ? `${toName} <${toEmail}>` : toEmail
  return send({ to: toAddr, subject: `${fromName} invited you to Lumen`, html,
    text: `${fromName} invited you to their Lumen family plan. Accept here: ${inviteUrl}` })
}

async function sendSubscriptionConfirmed({ email, name, plan, periodEnd }) {
  const firstName = (name || email).split(' ')[0]
  const planLabel = plan === 'pro' ? 'Lumen Pro' : 'Lumen Plus'
  const price     = plan === 'pro' ? '$9.99/mo' : '$4.99/mo'
  const perks     = plan === 'pro'
    ? ['Live bank sync via Plaid', 'Family plan (up to 3 members)', 'Per-transaction privacy controls']
    : ['Live bank sync via Plaid', 'Auto transaction import', 'Real-time balance updates']
  const endDate   = periodEnd
    ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'next month'

  const html = base({
    title: `You're on ${planLabel}`,
    preheader: `${planLabel} is active. Thank you.`,
    body: `
      ${heading(`You're on ${planLabel}, ${firstName}.`)}
      ${para('Your subscription is active and all features are unlocked.')}
      ${statTable([
        ...perks.map(p => ({ label: `✓ ${p}`, value: 'Active', color: C.greenDark })),
        { label: 'Next billing date', value: endDate },
        { label: 'Amount',            value: price },
      ])}
      ${ctaButton('Connect Your Bank →', `${FRONTEND}/accounts`)}
      ${note(`Manage or cancel anytime in <a href="${FRONTEND}/settings" style="color:${C.ink2};">Settings → Plan</a>. Questions? Reply to this email.`)}
    `
  })
  return send({ to: email, subject: `You're now on ${planLabel} — welcome`, html,
    text: `Your ${planLabel} subscription is active. Manage at ${FRONTEND}/settings` })
}

async function sendSubscriptionCancelled({ email, name, plan, periodEnd }) {
  const firstName = (name || email).split(' ')[0]
  const planLabel = plan === 'pro' ? 'Lumen Pro' : 'Lumen Plus'
  const endDate   = periodEnd
    ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'end of billing period'

  const html = base({
    title: `Your ${planLabel} plan has ended`,
    preheader: 'Your plan has been downgraded to Free.',
    body: `
      ${heading('Your plan has ended.')}
      ${para(`${firstName}, your <strong style="color:${C.ink};">${planLabel}</strong> subscription ended on ${endDate}. Your account is now on the free plan — your data is all still there.`)}
      ${statTable([
        { label: 'Bank sync (Plaid)',           value: 'Paused',          color: C.red },
        { label: 'Your transactions & budgets',  value: 'Safe',            color: C.greenDark },
        { label: 'Manual entry & CSV import',    value: 'Still available', color: C.greenDark },
      ])}
      ${ctaButton('Resubscribe →', `${FRONTEND}/pricing`)}
    `
  })
  return send({ to: email, subject: `Your ${planLabel} subscription has ended`, html,
    text: `Your ${planLabel} plan ended on ${endDate}. Your data is safe. Resubscribe at ${FRONTEND}/pricing` })
}

async function sendPaymentFailed({ email, name, plan }) {
  const firstName = (name || email).split(' ')[0]
  const planLabel = plan === 'pro' ? 'Lumen Pro' : 'Lumen Plus'
  const html = base({
    title: 'Payment issue with your Lumen subscription',
    preheader: 'Action needed — update your payment method.',
    body: `
      ${heading("We couldn't process your payment.")}
      ${para(`${firstName}, the payment for your <strong style="color:${C.ink};">${planLabel}</strong> subscription didn't go through. This is usually a temporary issue with your card.`)}
      ${ctaButton('Update Payment Method →', `${FRONTEND}/settings`)}
      ${divider()}
      ${note("We'll try again in a few days. If payment continues to fail your account will be moved to the free plan. Your data will remain safe.")}
    `
  })
  return send({ to: email, subject: 'Action needed — Lumen payment failed', html,
    text: `We couldn't process your ${planLabel} payment. Update at ${FRONTEND}/settings` })
}

async function sendPasswordChanged({ email, name }) {
  const firstName = (name || email).split(' ')[0]
  const now = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  const html = base({
    title: 'Your Lumen password was changed',
    preheader: 'Security notice — your password was updated.',
    body: `
      ${heading('Password changed.')}
      ${para(`${firstName}, your Lumen password was changed on <strong style="color:${C.ink};">${now}</strong>.`)}
      ${para("If you made this change — you're all set, no action needed.")}
      ${para(`If you <strong style="color:${C.ink};">did not</strong> make this change, your account may be compromised. Secure it immediately.`)}
      ${ctaButton('Secure My Account →', `${FRONTEND}/settings`)}
    `
  })
  return send({ to: email, subject: 'Your Lumen password was changed', html,
    text: `Your Lumen password was changed at ${now}. If this wasn't you, go to ${FRONTEND}/settings` })
}

async function sendWeeklyDigest({ email, name, stats }) {
  const firstName = (name || email).split(' ')[0]
  const { balance = 0, spent = 0, upcomingBills = [], nextPaycheck } = stats
  const fmt = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const rows = [
    { label: 'Available balance', value: `$${fmt(balance)}`, color: C.greenDark },
    { label: 'Spent this week',   value: `$${fmt(spent)}` },
  ]
  if (nextPaycheck) {
    rows.push({ label: 'Next paycheck', value: `$${fmt(nextPaycheck.amount)} in ${nextPaycheck.daysUntil}d`, color: C.greenDark })
  }
  upcomingBills.slice(0, 4).forEach(b => {
    rows.push({ label: b.name, value: `-$${fmt(b.amount)} in ${b.daysUntil}d`, color: C.red })
  })

  const html = base({
    title: 'Your Lumen weekly summary',
    preheader: `Balance: $${fmt(balance)} · ${upcomingBills.length} bills coming up`,
    body: `
      ${heading(`Your week, ${firstName}.`)}
      ${statTable(rows)}
      ${ctaButton('Open Dashboard →', `${FRONTEND}/dashboard`)}
    `
  })
  return send({ to: email, subject: `Lumen weekly — $${fmt(balance)} available`, html,
    text: `Balance: $${fmt(balance)}. Spent: $${fmt(spent)}. Open: ${FRONTEND}/dashboard` })
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
