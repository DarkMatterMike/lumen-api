/**
 * gmail-parser.js
 * Shared email fetching and parsing utilities for Phase 2.
 * Exported functions are used by both the API routes and the hourly cron.
 */

const { google } = require('googleapis')
const pool       = require('../db/pool')
const { getGmailClientForUser } = require('./gmail')

// ── Low-level helpers ─────────────────────────────────────────

/**
 * Search Gmail with a query string, return up to maxResults message stubs.
 */
async function searchMessages(gmail, query, maxResults = 20) {
  const res = await gmail.users.messages.list({
    userId:     'me',
    q:          query,
    maxResults,
  })
  return res.data.messages || []
}

/**
 * Fetch a single message with full payload.
 */
async function getMessage(gmail, id) {
  const res = await gmail.users.messages.get({
    userId:  'me',
    id,
    format:  'full',
  })
  return res.data
}

/**
 * Extract plain-text body from a Gmail message payload.
 * Handles multipart/mixed and multipart/alternative structures.
 */
function extractBody(payload) {
  if (!payload) return ''

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }

  // Multipart — prefer text/plain, fall back to text/html stripped
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain')
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, 'base64').toString('utf-8')
    }
    const html = payload.parts.find(p => p.mimeType === 'text/html')
    if (html?.body?.data) {
      const raw = Buffer.from(html.body.data, 'base64').toString('utf-8')
      // Strip tags for basic text
      return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    // Nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part)
      if (nested) return nested
    }
  }

  return ''
}

/**
 * Get a header value by name (case-insensitive).
 */
function header(msg, name) {
  const h = msg.payload?.headers?.find(
    h => h.name.toLowerCase() === name.toLowerCase()
  )
  return h?.value || ''
}

/**
 * Extract the first dollar amount from a string.
 * Returns a number or null.
 */
function extractAmount(text) {
  const match = text.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/)
  if (!match) return null
  return parseFloat(match[1].replace(/,/g, ''))
}

/**
 * Parse a date from email content, fallback to message internalDate.
 */
function extractDate(text, internalDate) {
  // Try common date patterns in email body
  const patterns = [
    /(\w+ \d{1,2},?\s?\d{4})/,           // January 15, 2025
    /(\d{1,2}\/\d{1,2}\/\d{4})/,         // 01/15/2025
    /(\d{4}-\d{2}-\d{2})/,               // 2025-01-15
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) {
      const d = new Date(m[1])
      if (!isNaN(d)) return d.toISOString().split('T')[0]
    }
  }
  // Fallback to email timestamp
  if (internalDate) {
    return new Date(parseInt(internalDate)).toISOString().split('T')[0]
  }
  return new Date().toISOString().split('T')[0]
}

// ── Subscription icons ────────────────────────────────────────
const SERVICE_ICONS = {
  netflix: '📺', spotify: '🎵', hulu: '📺', 'amazon prime': '📦',
  'disney+': '🏰', 'disney plus': '🏰', 'apple music': '🎵',
  'apple tv': '🍎', 'apple one': '🍎', icloud: '☁️',
  youtube: '▶️', peacock: '🦚', 'paramount+': '⭐',
  hbo: '📺', 'max': '📺', crunchyroll: '🎌',
  adobe: '🎨', 'microsoft 365': '💼', office: '💼',
  dropbox: '📦', notion: '📝', slack: '💬',
  github: '💻', 'chat gpt': '🤖', openai: '🤖',
  'google one': '🌐', 'google workspace': '🌐',
  doordash: '🍕', 'door dash': '🍕', instacart: '🛒',
  'amazon music': '🎵', audible: '🎧',
  peloton: '🚴', 'nytimes': '📰', 'new york times': '📰',
  headspace: '🧘', calm: '🧘',
}

function getServiceIcon(name) {
  const lower = name.toLowerCase()
  for (const [key, icon] of Object.entries(SERVICE_ICONS)) {
    if (lower.includes(key)) return icon
  }
  return '📱'
}

// ── SUBSCRIPTION SCANNER ──────────────────────────────────────

const SUBSCRIPTION_QUERIES = [
  'subject:(renewal OR "your subscription" OR "subscription renewed" OR "billing confirmation" OR "receipt for") newer_than:90d',
  'subject:("will be charged" OR "upcoming charge" OR "payment confirmation") newer_than:90d',
  'from:(noreply@netflix.com OR no-reply@spotify.com OR no-reply@hulu.com OR billing@adobe.com OR noreply@apple.com) newer_than:90d',
]

// Known subscription sender domains
const SUBSCRIPTION_DOMAINS = [
  'netflix.com', 'spotify.com', 'hulu.com', 'adobe.com', 'apple.com',
  'amazon.com', 'disneyplus.com', 'youtube.com', 'google.com',
  'microsoft.com', 'dropbox.com', 'notion.so', 'github.com',
  'openai.com', 'peacocktv.com', 'paramountplus.com', 'max.com',
  'crunchyroll.com', 'headspace.com', 'calm.com', 'audible.com',
  'doordash.com', 'instacart.com', 'nytimes.com',
]

function isSubscriptionEmail(fromHeader, subject, body) {
  const from    = fromHeader.toLowerCase()
  const subj    = subject.toLowerCase()
  const bodyLow = body.toLowerCase().slice(0, 500)

  if (SUBSCRIPTION_DOMAINS.some(d => from.includes(d))) return true

  const subjectKeywords = ['subscription', 'renewal', 'renew', 'billing', 'receipt', 'invoice', 'charged', 'payment']
  if (subjectKeywords.some(k => subj.includes(k))) return true

  const bodyKeywords = ['subscription', 'renewal date', 'next billing', 'cancel anytime', 'membership']
  if (bodyKeywords.some(k => bodyLow.includes(k))) return true

  return false
}

function extractServiceName(from, subject) {
  // Extract from sender domain
  const domainMatch = from.match(/@([a-zA-Z0-9-]+)\.[a-zA-Z]+/)
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase()
    // Clean up known domains
    const nameMap = {
      netflix: 'Netflix', spotify: 'Spotify', hulu: 'Hulu',
      adobe: 'Adobe', apple: 'Apple', amazon: 'Amazon Prime',
      disneyplus: 'Disney+', google: 'Google', microsoft: 'Microsoft 365',
      dropbox: 'Dropbox', notion: 'Notion', github: 'GitHub',
      openai: 'OpenAI', peacocktv: 'Peacock', paramountplus: 'Paramount+',
      max: 'Max', crunchyroll: 'Crunchyroll', headspace: 'Headspace',
      calm: 'Calm', audible: 'Audible', doordash: 'DoorDash',
      instacart: 'Instacart', nytimes: 'NY Times',
    }
    if (nameMap[domain]) return nameMap[domain]
    // Capitalize the domain name
    return domain.charAt(0).toUpperCase() + domain.slice(1)
  }

  // Fall back to extracting from subject
  const subj = subject.replace(/^(re:|fwd:|fw:)\s*/i, '').trim()
  // "Your Netflix receipt" → "Netflix"
  const receiptMatch = subj.match(/your\s+(\w+)\s+(receipt|subscription|renewal|invoice)/i)
  if (receiptMatch) return receiptMatch[1]

  return 'Unknown Service'
}

function extractBillingCycle(body, subject) {
  const text = (body + ' ' + subject).toLowerCase()
  if (text.includes('annual') || text.includes('yearly') || text.includes('/year') || text.includes('per year')) return 'annual'
  if (text.includes('monthly') || text.includes('/month') || text.includes('per month')) return 'monthly'
  return 'monthly' // default assumption
}

function extractNextRenewal(body, internalDate) {
  const text = body.toLowerCase()
  // Look for "next billing date", "renews on", "next charge"
  const patterns = [
    /next (?:billing|renewal|charge)[^\d]*(\w+ \d{1,2},?\s?\d{4})/i,
    /renew(?:s|al) on[^\d]*(\w+ \d{1,2},?\s?\d{4})/i,
    /(?:expires?|expiration)[^\d]*(\w+ \d{1,2},?\s?\d{4})/i,
    /next (?:billing|renewal|charge)[^\d]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /renew(?:s|al) on[^\d]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  ]
  for (const p of patterns) {
    const m = body.match(p)
    if (m) {
      const d = new Date(m[1])
      if (!isNaN(d) && d > new Date()) return d.toISOString().split('T')[0]
    }
  }
  // Estimate next renewal as ~30 days from email date
  const base = internalDate ? new Date(parseInt(internalDate)) : new Date()
  base.setDate(base.getDate() + 30)
  return base.toISOString().split('T')[0]
}

async function scanSubscriptions(userId) {
  const auth   = await getGmailClientForUser(userId)
  const gmail  = google.gmail({ version: 'v1', auth })
  const seen   = new Set()
  const found  = []

  for (const query of SUBSCRIPTION_QUERIES) {
    try {
      const messages = await searchMessages(gmail, query, 25)
      for (const stub of messages) {
        if (seen.has(stub.id)) continue
        seen.add(stub.id)

        const msg     = await getMessage(gmail, stub.id)
        const from    = header(msg, 'from')
        const subject = header(msg, 'subject')
        const body    = extractBody(msg.payload)

        if (!isSubscriptionEmail(from, subject, body)) continue

        const serviceName = extractServiceName(from, subject)
        if (serviceName === 'Unknown Service') continue

        const amount       = extractAmount(body) || extractAmount(subject)
        const billingCycle = extractBillingCycle(body, subject)
        const nextRenewal  = extractNextRenewal(body, msg.internalDate)
        const lastSeen     = new Date(parseInt(msg.internalDate)).toISOString().split('T')[0]
        const icon         = getServiceIcon(serviceName)

        found.push({ serviceName, amount, billingCycle, nextRenewal, lastSeen, subject, from, icon })
      }
    } catch (err) {
      console.warn('[Gmail scan subscriptions query error]', err.message)
    }
  }

  // Upsert into DB
  let upserted = 0
  for (const sub of found) {
    await pool.query(
      `INSERT INTO gmail_subscriptions
         (user_id, service_name, amount, billing_cycle, next_renewal, last_seen_date, email_subject, sender, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, service_name) DO UPDATE SET
         amount         = COALESCE(EXCLUDED.amount, gmail_subscriptions.amount),
         billing_cycle  = EXCLUDED.billing_cycle,
         next_renewal   = EXCLUDED.next_renewal,
         last_seen_date = EXCLUDED.last_seen_date,
         email_subject  = EXCLUDED.email_subject,
         icon           = EXCLUDED.icon,
         updated_at     = NOW()
       WHERE gmail_subscriptions.status = 'active'`,
      [sub.userId || userId, sub.serviceName, sub.amount, sub.billingCycle,
       sub.nextRenewal, sub.lastSeen, sub.subject, sub.from, sub.icon]
    )
    upserted++
  }

  // Update last_synced
  await pool.query('UPDATE gmail_tokens SET last_synced=NOW() WHERE user_id=$1', [userId])

  return { found: found.length, upserted }
}

// ── ORDER SCANNER ─────────────────────────────────────────────

const ORDER_QUERIES = [
  'subject:("order confirmation" OR "order received" OR "your order" OR "purchase confirmation") newer_than:30d',
  'subject:("thank you for your order" OR "order #" OR "order number") newer_than:30d',
  'from:(auto-confirm@amazon.com OR ship-confirm@amazon.com OR digital-no-reply@amazon.com) newer_than:30d',
]

const ORDER_DOMAINS = [
  'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com',
  'target.com', 'bestbuy.com', 'apple.com', 'costco.com',
  'chewy.com', 'wayfair.com', 'zappos.com', 'nike.com',
]

function extractMerchant(from, subject) {
  const domainMatch = from.match(/@([a-zA-Z0-9-]+)\.[a-zA-Z]+/)
  const nameMap = {
    amazon: 'Amazon', ebay: 'eBay', etsy: 'Etsy', walmart: 'Walmart',
    target: 'Target', bestbuy: 'Best Buy', apple: 'Apple',
    costco: 'Costco', chewy: 'Chewy', wayfair: 'Wayfair',
    zappos: 'Zappos', nike: 'Nike',
  }
  if (domainMatch) {
    const domain = domainMatch[1].toLowerCase()
    if (nameMap[domain]) return nameMap[domain]
    return domain.charAt(0).toUpperCase() + domain.slice(1)
  }
  return 'Online Order'
}

function getMerchantIcon(merchant) {
  const icons = {
    amazon: '📦', ebay: '🛍️', etsy: '🎨', walmart: '🏪',
    target: '🎯', 'best buy': '🔌', apple: '🍎', costco: '🏬',
    chewy: '🐾', wayfair: '🏠', zappos: '👟', nike: '👟',
  }
  const lower = merchant.toLowerCase()
  for (const [key, icon] of Object.entries(icons)) {
    if (lower.includes(key)) return icon
  }
  return '📦'
}

function extractDelivery(body) {
  const patterns = [
    /(?:estimated delivery|arriving|expected delivery|deliver(?:s|ed) by)[^\d]*(\w+ \d{1,2},?\s?\d{4})/i,
    /(?:estimated delivery|arriving|expected delivery|deliver(?:s|ed) by)[^\d]*(\w+day(?:,)?\s+\w+ \d{1,2})/i,
    /arrives?[:\s]+(\w+day(?:,)?\s+\w+ \d{1,2})/i,
  ]
  for (const p of patterns) {
    const m = body.match(p)
    if (m) return m[1].trim()
  }
  return null
}

async function scanOrders(userId) {
  const auth  = await getGmailClientForUser(userId)
  const gmail = google.gmail({ version: 'v1', auth })
  const seen  = new Set()
  const found = []

  for (const query of ORDER_QUERIES) {
    try {
      const messages = await searchMessages(gmail, query, 20)
      for (const stub of messages) {
        if (seen.has(stub.id)) continue
        seen.add(stub.id)

        const msg      = await getMessage(gmail, stub.id)
        const from     = header(msg, 'from')
        const subject  = header(msg, 'subject')
        const body     = extractBody(msg.payload)

        const merchant  = extractMerchant(from, subject)
        const amount    = extractAmount(body) || extractAmount(subject)
        const orderDate = extractDate(body, msg.internalDate)
        const delivery  = extractDelivery(body)
        const icon      = getMerchantIcon(merchant)

        found.push({ merchant, amount, orderDate, subject, from, delivery, icon })
      }
    } catch (err) {
      console.warn('[Gmail scan orders query error]', err.message)
    }
  }

  // Insert new orders (don't upsert — same merchant can have multiple orders)
  // Dedup by subject + user_id to avoid re-inserting on rescan
  let inserted = 0
  for (const order of found) {
    const existing = await pool.query(
      'SELECT id FROM gmail_orders WHERE user_id=$1 AND email_subject=$2',
      [userId, order.subject]
    )
    if (existing.rows.length) continue

    await pool.query(
      `INSERT INTO gmail_orders
         (user_id, merchant, amount, order_date, email_subject, sender, estimated_delivery, icon)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, order.merchant, order.amount, order.orderDate,
       order.subject, order.from, order.delivery, order.icon]
    )
    inserted++
  }

  return { found: found.length, inserted }
}

// ── BILL SCANNER ──────────────────────────────────────────────

const BILL_QUERIES = [
  'subject:("payment due" OR "bill ready" OR "statement available" OR "your bill" OR "amount due") newer_than:30d',
  'subject:("payment reminder" OR "due date" OR "past due" OR "invoice") newer_than:14d',
]

async function scanBills(userId) {
  const auth  = await getGmailClientForUser(userId)
  const gmail = google.gmail({ version: 'v1', auth })
  const seen  = new Set()
  const found = []

  for (const query of BILL_QUERIES) {
    try {
      const messages = await searchMessages(gmail, query, 15)
      for (const stub of messages) {
        if (seen.has(stub.id)) continue
        seen.add(stub.id)

        const msg     = await getMessage(gmail, stub.id)
        const from    = header(msg, 'from')
        const subject = header(msg, 'subject')
        const body    = extractBody(msg.payload)

        const amount  = extractAmount(body) || extractAmount(subject)
        const date    = extractDate(body, msg.internalDate)

        found.push({ from, subject, amount, date, body: body.slice(0, 300) })
      }
    } catch (err) {
      console.warn('[Gmail scan bills query error]', err.message)
    }
  }

  return { found: found.length, bills: found }
}

// ── Master sync for one user — called by cron ─────────────────
async function syncGmailForUser(userId) {
  const { rows } = await pool.query(
    'SELECT id FROM gmail_tokens WHERE user_id=$1',
    [userId]
  )
  if (!rows.length) return

  try {
    const [subs, orders] = await Promise.all([
      scanSubscriptions(userId),
      scanOrders(userId),
    ])
    console.log(`[Gmail] user ${userId}: ${subs.upserted} subs, ${orders.inserted} orders`)
  } catch (err) {
    console.error(`[Gmail] user ${userId} sync error:`, err.message)
  }
}

// ── PHASE 3: Transaction Enrichment ──────────────────────────
/**
 * Given a transaction name and date, search Gmail for a matching receipt
 * and return enriched data: cleaner name, category hint, order details.
 *
 * Called after Plaid sync for each new transaction.
 */
async function enrichTransaction(userId, txName, txDate, amount) {
  try {
    const auth  = await getGmailClientForUser(userId)
    const gmail = google.gmail({ version: 'v1', auth })

    // Build merchant keyword from transaction name
    // Strip common Plaid noise: "SQ *", "TST*", store numbers, locations
    const merchantRaw = txName
      .replace(/^(SQ\s*\*|TST\*|SP\s+|PP\*|AUT\s+|APL\*|WAL-|PAYPAL\s*\*)/i, '')
      .replace(/\s*#\d+\s*$/,  '')    // trailing store number
      .replace(/\s{2,}/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 2)                    // first 2 words are usually the merchant
      .join(' ')

    if (!merchantRaw || merchantRaw.length < 3) return null

    // Search window: ±2 days of the transaction date
    const txDay   = new Date(txDate)
    const before  = new Date(txDay); before.setDate(before.getDate() + 3)
    const after   = new Date(txDay); after.setDate(after.getDate()  - 3)
    const bStr    = `${before.getFullYear()}/${before.getMonth()+1}/${before.getDate()}`
    const aStr    = `${after.getFullYear()}/${after.getMonth()+1}/${after.getDate()}`

    const query = `"${merchantRaw}" (receipt OR order OR confirmation OR purchase) after:${aStr} before:${bStr}`

    const messages = await searchMessages(gmail, query, 5)
    if (!messages.length) return null

    // Take the first matching message
    const msg     = await getMessage(gmail, messages[0].id)
    const subject = header(msg, 'subject')
    const from    = header(msg, 'from')
    const body    = extractBody(msg.payload).slice(0, 1000)

    // Try to extract a cleaner merchant name from the email
    const cleanName = extractCleanMerchantName(from, subject, merchantRaw)

    // Try to get a category hint from the email content
    const categoryHint = extractCategoryHint(from, subject, body)

    // Try to extract the exact amount to verify it's the right receipt
    const emailAmount = extractAmount(body) || extractAmount(subject)
    const amountMatch = emailAmount && Math.abs(emailAmount - Math.abs(amount)) < 2

    return {
      cleanName:    cleanName || null,
      categoryHint: categoryHint || null,
      emailSubject: subject,
      sender:       from,
      amountMatch,
      confidence:   amountMatch ? 'high' : 'medium',
    }
  } catch (err) {
    // Gmail not connected or query failed — silent fallback
    return null
  }
}

function extractCleanMerchantName(from, subject, fallback) {
  // e.g. "Your Blue Bottle Coffee receipt" → "Blue Bottle Coffee"
  const patterns = [
    /your\s+(.+?)\s+(?:receipt|order|purchase|confirmation)/i,
    /(?:receipt|order)\s+from\s+(.+?)(?:\s+[-–]|\s+#|\s+\(|$)/i,
    /thank you for (?:your order|shopping) (?:at|with)\s+(.+?)(?:\s+[-–]|!|\.|\s*$)/i,
  ]
  for (const p of patterns) {
    const m = subject.match(p)
    if (m && m[1].length > 2 && m[1].length < 40) return m[1].trim()
  }
  return fallback
}

// Map email signals to budget category names
const CATEGORY_SIGNALS = {
  'Groceries':     ['grocery', 'supermarket', 'whole foods', 'trader joe', 'kroger', 'safeway', 'aldi', 'wegmans'],
  'Dining':        ['restaurant', 'cafe', 'coffee', 'pizza', 'doordash', 'grubhub', 'uber eats', 'instacart', 'food delivery'],
  'Transport':     ['uber', 'lyft', 'transit', 'parking', 'gas station', 'fuel', 'amtrak', 'airline', 'flight'],
  'Shopping':      ['amazon', 'ebay', 'etsy', 'target', 'walmart', 'best buy', 'order confirmation', 'purchase confirmation'],
  'Subscriptions': ['subscription', 'membership', 'renewal', 'netflix', 'spotify', 'hulu', 'adobe', 'apple'],
  'Health':        ['pharmacy', 'cvs', 'walgreens', 'doctor', 'medical', 'dental', 'vision', 'prescription'],
  'Entertainment': ['ticketmaster', 'eventbrite', 'cinema', 'movies', 'concert', 'ticket'],
  'Travel':        ['hotel', 'airbnb', 'vrbo', 'booking.com', 'expedia', 'car rental', 'hertz', 'avis'],
}

function extractCategoryHint(from, subject, body) {
  const text = `${from} ${subject} ${body}`.toLowerCase()
  for (const [category, signals] of Object.entries(CATEGORY_SIGNALS)) {
    if (signals.some(s => text.includes(s))) return category
  }
  return null
}

/**
 * Enrich a batch of new transactions after Plaid sync.
 * Runs in parallel with a concurrency cap to avoid Gmail rate limits.
 * Only enriches expense transactions that have a generic-looking name.
 */
async function enrichNewTransactions(userId, transactionIds) {
  if (!transactionIds.length) return 0

  // Check Gmail is connected
  const { rows: gmailRows } = await pool.query(
    'SELECT id FROM gmail_tokens WHERE user_id=$1', [userId]
  )
  if (!gmailRows.length) return 0

  const { rows: txs } = await pool.query(
    `SELECT id, name, amount, date FROM transactions
     WHERE id = ANY($1) AND user_id=$2 AND amount < 0`,
    [transactionIds, userId]
  )

  let enriched = 0
  // Process up to 5 at a time to respect Gmail API rate limits
  for (let i = 0; i < txs.length; i += 5) {
    const batch = txs.slice(i, i + 5)
    await Promise.all(batch.map(async (tx) => {
      try {
        const result = await enrichTransaction(userId, tx.name, tx.date, tx.amount)
        if (!result) return

        const updates = []
        const values  = []
        let idx = 1

        // Only update name if we found a cleaner version and confidence is high
        if (result.cleanName && result.confidence === 'high' && result.cleanName !== tx.name) {
          updates.push(`name=$${idx++}`)
          values.push(result.cleanName)
        }

        // Only set category hint if transaction has no budget category assigned yet
        if (result.categoryHint) {
          updates.push(`category=COALESCE(NULLIF(category,'Other'), $${idx++})`)
          values.push(result.categoryHint)
        }

        if (!updates.length) return

        values.push(tx.id)
        values.push(userId)
        await pool.query(
          `UPDATE transactions SET ${updates.join(', ')} WHERE id=$${idx} AND user_id=$${idx+1}`,
          values
        )
        enriched++
      } catch (err) {
        console.warn(`[Enrichment] tx ${tx.id}:`, err.message)
      }
    }))
    // Small delay between batches to stay under Gmail quota
    if (i + 5 < txs.length) await new Promise(r => setTimeout(r, 500))
  }

  return enriched
}

// ── PHASE 4: Gmail Context Builder ───────────────────────────
/**
 * Build a Gmail intelligence summary for injection into Lumen's AI context.
 * Called by buildFinancialContext in lumen.js.
 */
async function buildGmailContext(userId) {
  try {
    // Check connected
    const { rows: gmailRows } = await pool.query(
      'SELECT id FROM gmail_tokens WHERE user_id=$1', [userId]
    )
    if (!gmailRows.length) return null

    // Active subscriptions
    const { rows: subs } = await pool.query(
      `SELECT service_name, amount, billing_cycle, next_renewal, icon
       FROM gmail_subscriptions
       WHERE user_id=$1 AND status='active'
       ORDER BY next_renewal ASC NULLS LAST
       LIMIT 10`,
      [userId]
    )

    // Recent orders (last 30 days)
    const { rows: orders } = await pool.query(
      `SELECT merchant, amount, order_date, estimated_delivery, icon
       FROM gmail_orders
       WHERE user_id=$1 AND status='active'
         AND order_date >= CURRENT_DATE - INTERVAL '30 days'
       ORDER BY order_date DESC
       LIMIT 8`,
      [userId]
    )

    if (!subs.length && !orders.length) return null

    const today = new Date()

    // Subscriptions section
    const subLines = subs.map(s => {
      const days    = s.next_renewal
        ? Math.ceil((new Date(s.next_renewal) - today) / 86400000)
        : null
      const renewal = days !== null
        ? (days <= 0 ? 'renews today/recently' : `renews in ${days} days`)
        : 'renewal date unknown'
      const cost = s.amount
        ? `$${Number(s.amount).toFixed(2)}/${s.billing_cycle || 'mo'}`
        : 'amount unknown'
      return `  - ${s.icon} ${s.service_name}: ${cost}, ${renewal}`
    })

    // Monthly sub cost
    const monthlySubCost = subs.reduce((sum, s) => {
      if (!s.amount) return sum
      return sum + (s.billing_cycle === 'annual' ? Number(s.amount) / 12 : Number(s.amount))
    }, 0)

    // Orders section
    const orderLines = orders.map(o => {
      const delivery = o.estimated_delivery ? `, arriving ${o.estimated_delivery}` : ''
      const cost     = o.amount ? ` — $${Number(o.amount).toFixed(2)}` : ''
      return `  - ${o.icon} ${o.merchant}${cost} on ${new Date(o.order_date).toLocaleDateString('en-US',{month:'short',day:'numeric'})}${delivery}`
    })

    // Upcoming renewals in next 7 days (urgent)
    const urgentRenewals = subs.filter(s => {
      if (!s.next_renewal) return false
      const days = Math.ceil((new Date(s.next_renewal) - today) / 86400000)
      return days >= 0 && days <= 7
    })

    let context = '\nGMAIL INTELLIGENCE\n'

    if (subs.length) {
      context += `\nACTIVE SUBSCRIPTIONS (${subs.length} detected, ~$${monthlySubCost.toFixed(2)}/mo combined)\n`
      context += subLines.join('\n')
    }

    if (urgentRenewals.length) {
      context += `\n\n⚠️ RENEWING IN NEXT 7 DAYS\n`
      context += urgentRenewals.map(s => `  - ${s.service_name} on ${new Date(s.next_renewal).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`).join('\n')
    }

    if (orders.length) {
      context += `\n\nRECENT ORDERS (last 30 days)\n`
      context += orderLines.join('\n')
    }

    return context
  } catch (err) {
    console.warn('[buildGmailContext]', err.message)
    return null
  }
}

module.exports = {
  scanSubscriptions,
  scanOrders,
  scanBills,
  syncGmailForUser,
  enrichNewTransactions,
  buildGmailContext,
}
