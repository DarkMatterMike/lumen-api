/**
 * transactionIntelligence.js
 * Phase B — Shared utilities for transaction processing
 *
 * Exports:
 *  - cleanMerchantName(rawName, userId)       → cleaned display name + category hint
 *  - categorizeTransaction(name, amount, userId) → rules-first → corrections → AI
 *  - detectDuplicates(userId, txIds)          → finds & notifies on duplicate transactions
 *  - detectRecurringAmountChanges(userId)     → alerts when a recurring charge changes
 */

const pool       = require('../db/pool')
const Anthropic  = require('@anthropic-ai/sdk')

// ── Category list ─────────────────────────────────────────────────────────────
const CATEGORY_LIST = [
  'Housing', 'Groceries', 'Dining', 'Transport', 'Subscriptions',
  'Shopping', 'Utilities', 'Healthcare', 'Entertainment', 'Income',
  'Transfer', 'Other',
]

// ── API key helper ────────────────────────────────────────────────────────────
async function getUserApiKey(userId) {
  try {
    const { rows } = await pool.query(
      'SELECT anthropic_key FROM users WHERE id = $1',
      [userId]
    )
    return rows[0]?.anthropic_key || process.env.ANTHROPIC_API_KEY || null
  } catch {
    return process.env.ANTHROPIC_API_KEY || null
  }
}

// ── Normalize a raw merchant string for matching ──────────────────────────────
function normalizeMerchant(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/[#*0-9]/g, ' ')   // strip numbers and symbols common in Plaid names
    .replace(/\s+/g, ' ')
    .trim()
}

// ── 1. MERCHANT NAME CLEANING ─────────────────────────────────────────────────
/**
 * Given a raw transaction name (as from Plaid or CSV), return a cleaned display
 * name and optional category/icon hint.
 *
 * Priority:
 *   1. User's own merchant_names entries (exact prefix match)
 *   2. Global merchant_names entries (exact prefix match)
 *   3. AI cleaning (if name looks messy: has *, numbers, ALL CAPS, etc.)
 *   4. Title-case of original name as fallback
 *
 * Returns: { cleanedName, category, icon }
 */
async function cleanMerchantName(rawName, userId) {
  if (!rawName) return { cleanedName: rawName, category: null, icon: null }

  const normalized = normalizeMerchant(rawName)

  // 1 & 2 — DB lookup: user-specific first, then global (user_id IS NULL)
  const { rows: matches } = await pool.query(
    `SELECT clean_name, category, icon, user_id
     FROM merchant_names
     WHERE (user_id = $1 OR user_id IS NULL)
       AND $2 LIKE raw_pattern || '%'
     ORDER BY user_id NULLS LAST, LENGTH(raw_pattern) DESC
     LIMIT 1`,
    [userId, normalized]
  )

  if (matches.length) {
    return {
      cleanedName: matches[0].clean_name,
      category:    matches[0].category || null,
      icon:        matches[0].icon || null,
    }
  }

  // 3 — Looks messy? (contains *, digits, ALL CAPS segment, slash, #)
  const looksMessy = /[*#\/]/.test(rawName) || /[A-Z]{4,}/.test(rawName) || /\d{4,}/.test(rawName)
  if (looksMessy) {
    try {
      const apiKey = await getUserApiKey(userId)
      if (apiKey) {
        const client = new Anthropic({ apiKey })
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 60,
          messages: [{
            role: 'user',
            content: `Clean this raw bank transaction name into a short, human-friendly merchant name (2-4 words max). Return ONLY the cleaned name, nothing else.\n\nRaw: "${rawName}"\nCleaned:`
          }]
        })
        const cleaned = msg.content[0]?.text?.trim()
        if (cleaned && cleaned.length < 50) {
          // Cache this for next time
          pool.query(
            `INSERT INTO merchant_names (user_id, raw_pattern, clean_name)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [userId, normalized.substring(0, 80), cleaned]
          ).catch(() => {})

          return { cleanedName: cleaned, category: null, icon: null }
        }
      }
    } catch {
      // Fall through to title-case
    }
  }

  // 4 — Title-case fallback
  const titleCased = rawName
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()

  return { cleanedName: titleCased, category: null, icon: null }
}

// ── 2. RULES-FIRST → CORRECTIONS → AI CATEGORIZATION ─────────────────────────
/**
 * Full categorization pipeline. Returns { category, icon, source }
 * source: 'rule' | 'correction' | 'ai' | 'default'
 */
async function categorizeTransaction(name, amount, userId) {
  const nameLower = (name || '').toLowerCase()

  // Step 1: Rules
  const { rows: rules } = await pool.query(
    'SELECT * FROM rules WHERE user_id = $1 AND active = TRUE ORDER BY id ASC',
    [userId]
  )
  for (const rule of rules) {
    const val = (rule.match_value || '').toLowerCase()
    const matched =
      rule.operator === 'equals'      ? nameLower === val :
      rule.operator === 'starts_with' ? nameLower.startsWith(val) :
      nameLower.includes(val)

    if (matched && rule.action === 'set_category') {
      return { category: rule.action_value, icon: null, source: 'rule' }
    }
  }

  // Step 2: Category corrections (user's learned preferences)
  const normalized = normalizeMerchant(name)
  const { rows: corrections } = await pool.query(
    `SELECT corrected_category
     FROM category_corrections
     WHERE user_id = $1 AND merchant_name = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, normalized]
  )
  if (corrections.length) {
    return { category: corrections[0].corrected_category, icon: null, source: 'correction' }
  }

  // Step 3: Merchant name DB — may have a category hint
  const { rows: merchantMatch } = await pool.query(
    `SELECT category FROM merchant_names
     WHERE (user_id = $1 OR user_id IS NULL)
       AND $2 LIKE raw_pattern || '%'
       AND category IS NOT NULL
     ORDER BY user_id NULLS LAST, LENGTH(raw_pattern) DESC
     LIMIT 1`,
    [userId, normalized]
  )
  if (merchantMatch.length && merchantMatch[0].category) {
    return { category: merchantMatch[0].category, icon: null, source: 'merchant_db' }
  }

  // Step 4: AI
  try {
    const apiKey = await getUserApiKey(userId)
    if (apiKey) {
      // Fetch recent corrections for AI context (improves accuracy over time)
      const { rows: recentCorrections } = await pool.query(
        `SELECT DISTINCT merchant_name, corrected_category
         FROM category_corrections
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 30`,
        [userId]
      )
      const correctionContext = recentCorrections.length
        ? '\nUser corrections (use these as hints):\n' +
          recentCorrections.map(c => `  "${c.merchant_name}" → ${c.corrected_category}`).join('\n')
        : ''

      const client = new Anthropic({ apiKey })
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{
          role: 'user',
          content: `Categorize this bank transaction into exactly one category.\nCategories: ${CATEGORY_LIST.join(', ')}${correctionContext}\n\nTransaction: "${name}" | Amount: ${amount}\nCategory:`
        }]
      })
      const cat = msg.content[0]?.text?.trim()
      if (CATEGORY_LIST.includes(cat)) {
        return { category: cat, icon: null, source: 'ai' }
      }
    }
  } catch {
    // Fall through
  }

  // Default
  const defaultCat = amount > 0 ? 'Income' : 'Other'
  return { category: defaultCat, icon: null, source: 'default' }
}

// ── 3. DUPLICATE DETECTION ────────────────────────────────────────────────────
/**
 * Check a batch of newly inserted transaction IDs for duplicates.
 * A duplicate = same user + same merchant name (normalized) + same amount
 *   + within 3 days of another transaction.
 *
 * For each pair found: creates a notification unless already reviewed.
 */
async function detectDuplicates(userId, newTxIds = []) {
  if (!newTxIds.length) return 0

  const { createNotification } = require('../routes/notifications')
  let alertCount = 0

  // For each new transaction, look for a match in the last 3 days
  for (const txId of newTxIds) {
    const { rows: tx } = await pool.query(
      'SELECT id, name, amount, date FROM transactions WHERE id = $1 AND user_id = $2',
      [txId, userId]
    )
    if (!tx.length) continue
    const t = tx[0]

    // Find potential duplicates (same amount, same normalized name, within 3 days, different id)
    const { rows: dupes } = await pool.query(
      `SELECT id, name, amount, date
       FROM transactions
       WHERE user_id = $1
         AND id != $2
         AND ABS(amount - $3) < 0.01
         AND LOWER(TRIM(name)) = LOWER(TRIM($4))
         AND ABS(date - $5::date) <= 3
         AND COALESCE(tx_type, 'expense') != 'transfer'`,
      [userId, txId, t.amount, t.name, t.date]
    )

    for (const dupe of dupes) {
      // Check if this pair was already reviewed
      const { rows: reviewed } = await pool.query(
        `SELECT id FROM duplicate_reviews
         WHERE user_id = $1
           AND ((transaction_id_1 = $2 AND transaction_id_2 = $3)
             OR (transaction_id_1 = $3 AND transaction_id_2 = $2))`,
        [userId, txId, dupe.id]
      )
      if (reviewed.length) continue

      // Check if we already have an unread notification for this pair
      const { rows: existingNotif } = await pool.query(
        `SELECT id FROM notifications
         WHERE user_id = $1
           AND type = 'duplicate'
           AND dismissed = FALSE
           AND (metadata->>'tx1_id' = $2 OR metadata->>'tx2_id' = $2
             OR metadata->>'tx1_id' = $3 OR metadata->>'tx2_id' = $3)`,
        [userId, String(txId), String(dupe.id)]
      )
      if (existingNotif.length) continue

      const amt = Math.abs(Number(t.amount))
      await createNotification(userId, {
        type:  'duplicate',
        title: 'Possible duplicate charge',
        body:  `"${t.name}" for $${amt.toFixed(2)} appears twice — on ${t.date} and ${dupe.date}. Was this charged twice?`,
        icon:  '⚠️',
        metadata: {
          tx1_id:  txId,
          tx2_id:  dupe.id,
          name:    t.name,
          amount:  t.amount,
          date1:   t.date,
          date2:   dupe.date,
        }
      })
      alertCount++
    }
  }

  return alertCount
}

// ── 4. RECURRING AMOUNT CHANGE DETECTION ─────────────────────────────────────
/**
 * After a sync, check if any recurring items were charged at a different amount
 * than last time. Alert the user if so.
 *
 * Matches recurring items to new transactions by:
 *   - Name similarity (normalized)
 *   - Date proximity (within 5 days of day_of_month)
 *   - Amount ballpark (within 50% — to catch real amount changes, not mismatches)
 */
async function detectRecurringAmountChanges(userId, newTxIds = []) {
  if (!newTxIds.length) return 0

  const { createNotification } = require('../routes/notifications')
  let alertCount = 0

  // Get active recurring items for this user
  const { rows: recurring } = await pool.query(
    'SELECT * FROM recurring WHERE user_id = $1 AND active = TRUE',
    [userId]
  )
  if (!recurring.length) return 0

  // Get the new transactions
  const { rows: newTxs } = await pool.query(
    `SELECT id, name, amount, date
     FROM transactions
     WHERE id = ANY($1::int[]) AND user_id = $2`,
    [newTxIds, userId]
  )

  for (const tx of newTxs) {
    const txDay  = new Date(tx.date).getDate()
    const txAmt  = Math.abs(Number(tx.amount))
    const txName = normalizeMerchant(tx.name)

    for (const rec of recurring) {
      const recAmt  = Math.abs(Number(rec.amount))
      const recName = normalizeMerchant(rec.name)

      // Name similarity: one must contain the other or overlap 60%+
      const nameSimilar = txName.includes(recName) || recName.includes(txName) ||
        sharedWords(txName, recName) >= 0.6

      // Day proximity: within 5 days of scheduled day
      const dayDiff = Math.abs(txDay - rec.day_of_month)
      const dayClose = dayDiff <= 5 || dayDiff >= 25 // handle month-end wrapping

      // Amount ballpark: within 50% to match the recurring item
      const amtBallpark = recAmt > 0 && txAmt / recAmt >= 0.5 && txAmt / recAmt <= 2.0

      if (nameSimilar && dayClose && amtBallpark) {
        // Fetch last known amount for this recurring item
        const { rows: history } = await pool.query(
          `SELECT amount FROM recurring_amount_history
           WHERE user_id = $1 AND recurring_id = $2
           ORDER BY recorded_at DESC LIMIT 1`,
          [userId, rec.id]
        )

        // Record this occurrence
        await pool.query(
          `INSERT INTO recurring_amount_history (user_id, recurring_id, transaction_id, amount)
           VALUES ($1, $2, $3, $4)`,
          [userId, rec.id, tx.id, txAmt]
        )

        if (history.length) {
          const lastAmt   = Math.abs(Number(history[0].amount))
          const diff      = txAmt - lastAmt
          const diffPct   = lastAmt > 0 ? Math.abs(diff / lastAmt) * 100 : 0

          // Alert if changed by more than $0.50 and more than 2%
          if (Math.abs(diff) > 0.50 && diffPct > 2) {
            const direction = diff > 0 ? 'up' : 'down'
            const emoji     = diff > 0 ? '📈' : '📉'

            await createNotification(userId, {
              type:  'recurring_change',
              title: `${rec.name} charge changed`,
              body:  `Your ${rec.name} charge went ${direction} from $${lastAmt.toFixed(2)} to $${txAmt.toFixed(2)} (${direction === 'up' ? '+' : ''}${diff.toFixed(2)}).`,
              icon:  emoji,
              metadata: {
                recurring_id:  rec.id,
                transaction_id: tx.id,
                old_amount:    lastAmt,
                new_amount:    txAmt,
                diff,
                diff_pct:      diffPct.toFixed(1),
              }
            })
            alertCount++
          }
        }
      }
    }
  }

  return alertCount
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ratio of shared words between two normalized strings (Jaccard-ish)
 */
function sharedWords(a, b) {
  const wordsA = new Set(a.split(' ').filter(w => w.length > 2))
  const wordsB = new Set(b.split(' ').filter(w => w.length > 2))
  if (!wordsA.size || !wordsB.size) return 0
  let shared = 0
  for (const w of wordsA) if (wordsB.has(w)) shared++
  return shared / Math.max(wordsA.size, wordsB.size)
}

module.exports = {
  cleanMerchantName,
  categorizeTransaction,
  detectDuplicates,
  detectRecurringAmountChanges,
  normalizeMerchant,
  CATEGORY_LIST,
}
