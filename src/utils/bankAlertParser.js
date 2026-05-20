/**
 * bankAlertParser.js
 * Parses bank transaction alert emails and creates pending transactions.
 *
 * Supports: Capital One, Chase, Bank of America, Amex, Wells Fargo, Citi, Discover
 *
 * Flow:
 *   1. Search Gmail for transaction alert emails from the last 24h
 *   2. Parse merchant + amount from email body/subject
 *   3. Check if a matching posted transaction already exists
 *      - Yes → skip (Plaid already got it)
 *      - No  → create a pending transaction
 *   4. On Plaid sync, checkForMergeCandidates() is called with new tx IDs
 *      → finds pending txs that match, creates merge_candidates rows
 *   5. User sees merge suggestions in the UI and confirms or dismisses each
 */

const pool = require('../db/pool')
const { getGmailClientForUser } = require('../routes/gmail')

// ── Email patterns per bank ───────────────────────────────────────────────────

const BANK_PATTERNS = [
  {
    name: 'Capital One',
    senderPattern: /capitalone\.com/i,
    subjectPattern: /transaction|purchase|charge|alert/i,
    parse(subject, body) {
      // "You made a $42.50 purchase at Starbucks"
      // "A $42.50 transaction was made at Starbucks"
      const amountMatch = body.match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const merchantPatterns = [
        /(?:purchase|transaction|charge)\s+at\s+([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s+for|\s*\.|\s*\n)/i,
        /at\s+([A-Za-z0-9\s&'.,-]{2,40}?)\s+(?:on|for|\$)/i,
        /([A-Za-z0-9\s&'.,-]{2,40}?)\s+\$[0-9]/i,
      ];
      let merchant = null;
      for (const p of merchantPatterns) {
        const m = body.match(p) || subject.match(p);
        if (m?.[1]) { merchant = m[1].trim(); break; }
      }

      return amount && merchant ? { amount, merchant } : null;
    },
  },
  {
    name: 'Chase',
    senderPattern: /chase\.com/i,
    subjectPattern: /transaction|purchase|charge|alert|activity/i,
    parse(subject, body) {
      // "Your $42.50 transaction at Starbucks"
      const amountMatch = (subject + ' ' + body).match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const m = body.match(/(?:at|from)\s+([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s+was|\s*\.|\s*\n)/i)
             || subject.match(/at\s+([A-Za-z0-9\s&'.,-]{2,40})/i);
      const merchant = m?.[1]?.trim() || null;

      return amount && merchant ? { amount, merchant } : null;
    },
  },
  {
    name: 'Bank of America',
    senderPattern: /bankofamerica\.com/i,
    subjectPattern: /transaction|purchase|charge|alert/i,
    parse(subject, body) {
      const amountMatch = (subject + ' ' + body).match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const m = body.match(/(?:merchant|at|from)\s*:?\s*([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s*\n|\s*\$)/i);
      const merchant = m?.[1]?.trim() || null;

      return amount && merchant ? { amount, merchant } : null;
    },
  },
  {
    name: 'American Express',
    senderPattern: /americanexpress\.com/i,
    subjectPattern: /transaction|purchase|charge|alert/i,
    parse(subject, body) {
      const amountMatch = (subject + ' ' + body).match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const m = body.match(/(?:at|from)\s+([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s+for|\s*\n)/i);
      const merchant = m?.[1]?.trim() || null;

      return amount && merchant ? { amount, merchant } : null;
    },
  },
  {
    name: 'Wells Fargo',
    senderPattern: /wellsfargo\.com/i,
    subjectPattern: /transaction|purchase|charge|alert/i,
    parse(subject, body) {
      const amountMatch = (subject + ' ' + body).match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const m = body.match(/(?:at|from|merchant)\s*:?\s*([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s*\n|\s*\$)/i);
      const merchant = m?.[1]?.trim() || null;

      return amount && merchant ? { amount, merchant } : null;
    },
  },
  {
    name: 'Citi',
    senderPattern: /citi(?:bank)?\.com/i,
    subjectPattern: /transaction|purchase|charge|alert/i,
    parse(subject, body) {
      const amountMatch = (subject + ' ' + body).match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const m = body.match(/(?:at|from)\s+([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s*\n)/i);
      const merchant = m?.[1]?.trim() || null;

      return amount && merchant ? { amount, merchant } : null;
    },
  },
  {
    name: 'Discover',
    senderPattern: /discover(?:card)?\.com/i,
    subjectPattern: /transaction|purchase|charge|alert/i,
    parse(subject, body) {
      const amountMatch = (subject + ' ' + body).match(/\$([0-9,]+\.\d{2})/);
      const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '')) : null;

      const m = body.match(/(?:at|from)\s+([A-Za-z0-9\s&'.,-]{2,40}?)(?:\s+on|\s*\n)/i);
      const merchant = m?.[1]?.trim() || null;

      return amount && merchant ? { amount, merchant } : null;
    },
  },
]

// ── Main: scan Gmail for transaction alerts and create pending txs ─────────────

async function scanBankAlerts(userId) {
  let gmail
  try {
    gmail = await getGmailClientForUser(userId)
  } catch {
    return { created: 0, skipped: 0 }
  }

  const query = 'subject:(transaction OR purchase OR charge OR alert) newer_than:2d'
  const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 })
  const messages = listRes.data.messages || []

  let created = 0
  let skipped  = 0

  for (const stub of messages) {
    try {
      const msg = await gmail.users.messages.get({ userId: 'me', id: stub.id, format: 'full' })
      const data = msg.data

      // Get sender
      const from    = data.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value || ''
      const subject = data.payload?.headers?.find(h => h.name.toLowerCase() === 'subject')?.value || ''
      const dateStr = data.payload?.headers?.find(h => h.name.toLowerCase() === 'date')?.value || ''

      // Match to a bank
      const bank = BANK_PATTERNS.find(b => b.senderPattern.test(from) && b.subjectPattern.test(subject))
      if (!bank) continue

      // Extract body
      const body = extractBody(data.payload)

      // Parse the transaction
      const parsed = bank.parse(subject, body)
      if (!parsed || !parsed.amount || !parsed.merchant) continue

      const txDate = dateStr ? new Date(dateStr).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]

      // Skip if this email's gmail_message_id already created a pending tx
      const { rows: existing } = await pool.query(
        `SELECT id FROM transactions WHERE user_id=$1 AND pending_source='email' AND email_subject=$2 AND status='pending'`,
        [userId, subject]
      )
      if (existing.length) { skipped++; continue }

      // Skip if a posted transaction already matches (Plaid beat us to it)
      const { rows: alreadyPosted } = await pool.query(
        `SELECT id FROM transactions
         WHERE user_id=$1
           AND status='posted'
           AND ABS(amount + $2) < 0.02
           AND date BETWEEN $3::date - INTERVAL '2 days' AND $3::date + INTERVAL '2 days'
           AND LOWER(COALESCE(cleaned_name, name)) LIKE '%' || LOWER($4) || '%'
         LIMIT 1`,
        [userId, parsed.amount, txDate, parsed.merchant.slice(0, 8)]
      )
      if (alreadyPosted.length) { skipped++; continue }

      // Find the user's default account (first non-debt account)
      const { rows: accounts } = await pool.query(
        `SELECT id FROM accounts WHERE user_id=$1 AND is_debt=FALSE ORDER BY id LIMIT 1`,
        [userId]
      )
      const accountId = accounts[0]?.id || null

      // Create the pending transaction
      await pool.query(
        `INSERT INTO transactions
           (user_id, account_id, name, amount, category, date, status, pending_source, email_subject, source)
         VALUES ($1, $2, $3, $4, 'Other', $5, 'pending', 'email', $6, 'email_alert')`,
        [userId, accountId, parsed.merchant, -parsed.amount, txDate, subject]
      )

      created++
    } catch (err) {
      console.warn('[BankAlerts] parse error:', err.message)
    }
  }

  return { created, skipped }
}

// ── Called after Plaid sync — finds pending txs that match new posted txs ─────

async function checkForMergeCandidates(userId, newPostedTxIds) {
  if (!newPostedTxIds.length) return 0

  // Get the newly posted transactions
  const { rows: postedTxs } = await pool.query(
    `SELECT id, name, cleaned_name, amount, date FROM transactions
     WHERE id = ANY($1) AND user_id=$2 AND status='posted'`,
    [newPostedTxIds, userId]
  )

  // Get all unresolved pending transactions for this user (last 14 days)
  const { rows: pendingTxs } = await pool.query(
    `SELECT id, name, cleaned_name, amount, date FROM transactions
     WHERE user_id=$1 AND status='pending'
       AND date >= CURRENT_DATE - INTERVAL '14 days'`,
    [userId]
  )

  if (!pendingTxs.length) return 0

  let candidatesCreated = 0

  for (const posted of postedTxs) {
    for (const pending of pendingTxs) {
      // Skip if a merge candidate already exists for this pair
      const { rows: existing } = await pool.query(
        `SELECT id FROM merge_candidates WHERE pending_tx_id=$1 AND posted_tx_id=$2`,
        [pending.id, posted.id]
      )
      if (existing.length) continue

      const { score, reason, confidence } = scoreMergeCandidate(pending, posted)
      if (score < 0.5) continue

      await pool.query(
        `INSERT INTO merge_candidates
           (user_id, pending_tx_id, posted_tx_id, confidence, confidence_score, match_reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (pending_tx_id, posted_tx_id) DO NOTHING`,
        [userId, pending.id, posted.id, confidence, score, reason]
      )
      candidatesCreated++
    }
  }

  return candidatesCreated
}

// ── Score a pending→posted pair ───────────────────────────────────────────────

function scoreMergeCandidate(pending, posted) {
  let score  = 0
  const reasons = []

  // Amount match (exact = high value)
  const amountDiff = Math.abs(Math.abs(Number(pending.amount)) - Math.abs(Number(posted.amount)))
  if (amountDiff === 0) {
    score += 0.5; reasons.push('exact amount match')
  } else if (amountDiff < 0.02) {
    score += 0.45; reasons.push('amount within $0.02')
  } else if (amountDiff < 1.00) {
    score += 0.25; reasons.push('amount within $1')
  }

  // Date proximity
  const daysDiff = Math.abs(
    (new Date(pending.date) - new Date(posted.date)) / 86400000
  )
  if (daysDiff <= 1) {
    score += 0.35; reasons.push('same or next day')
  } else if (daysDiff <= 3) {
    score += 0.2; reasons.push(`${Math.round(daysDiff)} days apart`)
  } else if (daysDiff <= 7) {
    score += 0.05
  }

  // Merchant name similarity
  const pendingName = normalize(pending.cleaned_name || pending.name)
  const postedName  = normalize(posted.cleaned_name  || posted.name)

  if (pendingName === postedName) {
    score += 0.25; reasons.push('same merchant')
  } else if (postedName.includes(pendingName) || pendingName.includes(postedName)) {
    score += 0.15; reasons.push('merchant name overlap')
  } else if (firstWordMatch(pendingName, postedName)) {
    score += 0.08; reasons.push('partial merchant match')
  }

  const confidence = score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : 'low'
  return { score: Math.min(1, score), reason: reasons.join(', '), confidence }
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
}

function firstWordMatch(a, b) {
  const wa = a.split(' ')[0]
  const wb = b.split(' ')[0]
  return wa.length > 3 && wb.length > 3 && (wa.includes(wb) || wb.includes(wa))
}

// ── Merge action: user confirms merge ─────────────────────────────────────────

async function executeMerge(userId, candidateId) {
  const { rows } = await pool.query(
    `SELECT mc.*, 
            pt.name AS pending_name, pt.amount AS pending_amount,
            po.id AS posted_id, po.category, po.icon, po.cleaned_name
     FROM merge_candidates mc
     JOIN transactions pt ON pt.id = mc.pending_tx_id
     JOIN transactions po ON po.id = mc.posted_tx_id
     WHERE mc.id=$1 AND mc.user_id=$2`,
    [candidateId, userId]
  )
  if (!rows.length) throw new Error('Candidate not found')
  const c = rows[0]

  // Delete the pending transaction
  await pool.query('DELETE FROM transactions WHERE id=$1 AND user_id=$2', [c.pending_tx_id, userId])

  // Mark candidate as merged
  await pool.query(
    `UPDATE merge_candidates SET status='merged', resolved_at=NOW() WHERE id=$1`,
    [candidateId]
  )

  // Dismiss any other candidates involving these same transactions
  await pool.query(
    `UPDATE merge_candidates SET status='merged', resolved_at=NOW()
     WHERE (pending_tx_id=$1 OR posted_tx_id=$2) AND id != $3`,
    [c.pending_tx_id, c.posted_tx_id, candidateId]
  )

  return { posted_tx_id: c.posted_id }
}

// ── Keep separate: user says not a duplicate ──────────────────────────────────

async function keepSeparate(userId, candidateId) {
  await pool.query(
    `UPDATE merge_candidates SET status='kept_separate', resolved_at=NOW()
     WHERE id=$1 AND user_id=$2`,
    [candidateId, userId]
  )
}

// ── Get pending review items for a user ───────────────────────────────────────

async function getMergeCandidates(userId) {
  const { rows } = await pool.query(
    `SELECT
       mc.id, mc.confidence, mc.confidence_score, mc.match_reason, mc.created_at,
       pt.id        AS pending_id,
       pt.name      AS pending_name,
       pt.cleaned_name AS pending_cleaned,
       pt.amount    AS pending_amount,
       pt.date      AS pending_date,
       pt.email_subject AS pending_email_subject,
       po.id        AS posted_id,
       po.name      AS posted_name,
       po.cleaned_name AS posted_cleaned,
       po.amount    AS posted_amount,
       po.date      AS posted_date,
       po.category  AS posted_category,
       po.icon      AS posted_icon
     FROM merge_candidates mc
     JOIN transactions pt ON pt.id = mc.pending_tx_id
     JOIN transactions po ON po.id = mc.posted_tx_id
     WHERE mc.user_id=$1 AND mc.status='pending_review'
     ORDER BY mc.confidence_score DESC, mc.created_at DESC`,
    [userId]
  )
  return rows
}

// ── Body extractor (same logic as gmail-parser) ───────────────────────────────

function extractBody(payload) {
  if (!payload) return ''
  if (payload.body?.data) return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain')
    if (plain?.body?.data) return Buffer.from(plain.body.data, 'base64').toString('utf-8')
    const html = payload.parts.find(p => p.mimeType === 'text/html')
    if (html?.body?.data) {
      return Buffer.from(html.body.data, 'base64').toString('utf-8')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    for (const part of payload.parts) {
      const nested = extractBody(part)
      if (nested) return nested
    }
  }
  return ''
}

module.exports = {
  scanBankAlerts,
  checkForMergeCandidates,
  getMergeCandidates,
  executeMerge,
  keepSeparate,
}
