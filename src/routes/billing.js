const express = require('express')
const router  = express.Router()
const Stripe  = require('stripe')
const pool    = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_PLACEHOLDER')

const PRICES = {
  plus: process.env.STRIPE_PRICE_PLUS || 'price_PLUS_PLACEHOLDER',  // $4.99/mo
  pro:  process.env.STRIPE_PRICE_PRO  || 'price_PRO_PLACEHOLDER',   // $9.99/mo
}

// ── GET /api/billing/status ───────────────────────────────────
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const { rows: userRows } = await pool.query(
      'SELECT tier, role FROM users WHERE id=$1', [req.user.id]
    )
    const user = userRows[0]
    const { rows: subRows } = await pool.query(
      'SELECT * FROM subscriptions WHERE user_id=$1 LIMIT 1', [req.user.id]
    )
    const sub = subRows[0] || null
    res.json({
      tier:              user?.tier || 'free',
      role:              user?.role || 'user',
      status:            sub?.status || null,
      currentPeriodEnd:  sub?.current_period_end || null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end || false,
    })
  } catch (err) { next(err) }
})

// ── POST /api/billing/checkout ────────────────────────────────
router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const { plan } = req.body  // 'plus' | 'pro'
    if (!PRICES[plan]) return res.status(400).json({ error: 'Invalid plan' })

    const { rows } = await pool.query(
      'SELECT email FROM users WHERE id=$1', [req.user.id]
    )
    const email = rows[0]?.email

    // Get or create Stripe customer
    let { rows: subRows } = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id=$1 LIMIT 1',
      [req.user.id]
    )
    let customerId = subRows[0]?.stripe_customer_id

    if (!customerId) {
      const customer = await stripe.customers.create({
        email, metadata: { lumen_user_id: String(req.user.id) }
      })
      customerId = customer.id
      await pool.query(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, tier, status)
         VALUES ($1,$2,'free','active')
         ON CONFLICT (stripe_customer_id) DO NOTHING`,
        [req.user.id, customerId]
      )
    }

    const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173'
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'subscription',
      line_items:           [{ price: PRICES[plan], quantity: 1 }],
      success_url:          `${FRONTEND}/settings?upgraded=1`,
      cancel_url:           `${FRONTEND}/pricing`,
      subscription_data:    { metadata: { lumen_user_id: String(req.user.id), plan } },
      allow_promotion_codes: true,
    })

    res.json({ url: session.url })
  } catch (err) { next(err) }
})

// ── POST /api/billing/portal ──────────────────────────────────
router.post('/portal', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id=$1 LIMIT 1',
      [req.user.id]
    )
    if (!rows[0]?.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found' })
    }
    const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173'
    const portal = await stripe.billingPortal.sessions.create({
      customer:   rows[0].stripe_customer_id,
      return_url: `${FRONTEND}/settings`,
    })
    res.json({ url: portal.url })
  } catch (err) { next(err) }
})

// ── POST /api/billing/webhook ─────────────────────────────────
// Register in Railway — raw body required (see index.js)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature']
  let event
  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || 'whsec_PLACEHOLDER'
    )
  } catch (err) {
    console.error('[Stripe webhook] Bad signature:', err.message)
    return res.status(400).send(`Webhook Error: ${err.message}`)
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const userId  = Number(session.subscription_data?.metadata?.lumen_user_id ||
                               session.metadata?.lumen_user_id)
        const plan    = session.subscription_data?.metadata?.plan || 'plus'
        if (!userId) break
        // Fetch subscription details
        const sub = await stripe.subscriptions.retrieve(session.subscription)
        await pool.query(
          `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_sub_id, tier, status, current_period_end)
           VALUES ($1,$2,$3,$4,'active',$5)
           ON CONFLICT (stripe_sub_id) DO UPDATE
             SET tier=$4, status='active', current_period_end=$5, updated_at=NOW()`,
          [userId, session.customer, session.subscription, plan,
           new Date(sub.current_period_end * 1000)]
        )
        await pool.query('UPDATE users SET tier=$1 WHERE id=$2', [plan, userId])
        console.log(`[Stripe] User ${userId} upgraded to ${plan}`)
        break
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object
        const sub = await stripe.subscriptions.retrieve(invoice.subscription)
        const userId = Number(sub.metadata?.lumen_user_id)
        if (!userId) break
        await pool.query(
          `UPDATE subscriptions SET status='active', current_period_end=$1, updated_at=NOW()
           WHERE stripe_sub_id=$2`,
          [new Date(sub.current_period_end * 1000), invoice.subscription]
        )
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        await pool.query(
          `UPDATE subscriptions SET status='past_due', updated_at=NOW()
           WHERE stripe_sub_id=$1`,
          [invoice.subscription]
        )
        break
      }
      case 'customer.subscription.deleted': {
        const sub = await stripe.subscriptions.retrieve(event.data.object.id)
        const userId = Number(sub.metadata?.lumen_user_id)
        await pool.query(
          `UPDATE subscriptions SET status='canceled', tier='free', updated_at=NOW()
           WHERE stripe_sub_id=$1`,
          [event.data.object.id]
        )
        if (userId) await pool.query(
          `UPDATE users SET tier='free' WHERE id=$1 AND role != 'owner'`, [userId]
        )
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object
        const userId = Number(sub.metadata?.lumen_user_id)
        if (!userId) break
        const plan = sub.items.data[0]?.price?.id === PRICES.pro ? 'pro' : 'plus'
        await pool.query(
          `UPDATE subscriptions SET tier=$1, status=$2,
           current_period_end=$3, cancel_at_period_end=$4, updated_at=NOW()
           WHERE stripe_sub_id=$5`,
          [plan, sub.status, new Date(sub.current_period_end * 1000),
           sub.cancel_at_period_end, sub.id]
        )
        await pool.query('UPDATE users SET tier=$1 WHERE id=$2', [plan, userId])
        break
      }
    }
  } catch (err) {
    console.error('[Stripe webhook] Handler error:', err.message)
  }

  res.json({ received: true })
})

// ── POST /api/billing/admin/set-tier ─────────────────────────
// Owner-only manual override
router.post('/admin/set-tier', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Owner only' })
    }
    const { userId, tier } = req.body
    if (!['free', 'plus', 'pro'].includes(tier)) {
      return res.status(400).json({ error: 'Invalid tier' })
    }
    await pool.query('UPDATE users SET tier=$1 WHERE id=$2', [tier, userId])
    await pool.query(
      `INSERT INTO subscriptions (user_id, tier, status)
       VALUES ($1,$2,'active')
       ON CONFLICT (user_id) DO UPDATE SET tier=$2, status='active', updated_at=NOW()`,
      [userId, tier]
    )
    res.json({ ok: true, userId, tier })
  } catch (err) { next(err) }
})

module.exports = router
