/**
 * Phase H — Document Intelligence
 *
 * POST /api/documents/upload        → upload + auto-detect doc type, extract data
 * POST /api/documents/bank-statement → parse bank statement PDF → import transactions
 * POST /api/documents/pay-stub      → parse pay stub → update income model
 * POST /api/documents/loan          → parse loan doc → create recurring item
 * GET  /api/documents/tax-summary   → generate year-end tax summary from transactions
 * GET  /api/documents/history       → list past document uploads
 *
 * All PDF parsing uses:
 *   1. pdf-parse to extract raw text
 *   2. Claude to interpret the text into structured data
 *   (AI-first means it works on ANY bank/employer/lender format)
 */

const express  = require('express')
const router   = express.Router()
const multer   = require('multer')
const pool     = require('../db/pool')
const requireAuth = require('../middleware/requireAuth')
const Anthropic   = require('@anthropic-ai/sdk')

router.use(requireAuth)

// Multer — memory storage (no disk writes, buffer passed to pdf-parse)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20MB max
  fileFilter(req, file, cb) {
    const ok = file.mimetype === 'application/pdf' ||
               file.mimetype.startsWith('image/') ||
               file.originalname.toLowerCase().endsWith('.pdf')
    cb(ok ? null : new Error('Only PDF and image files are supported'), ok)
  },
})

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getApiKey(userId) {
  const { rows } = await pool.query('SELECT anthropic_key FROM users WHERE id=$1', [userId])
  return rows[0]?.anthropic_key || process.env.ANTHROPIC_API_KEY || null
}

async function extractPdfText(buffer) {
  try {
    const pdfParse = require('pdf-parse')
    const data     = await pdfParse(buffer)
    return data.text || ''
  } catch (err) {
    throw new Error(`PDF text extraction failed: ${err.message}`)
  }
}

function parseDate(str) {
  if (!str) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str
  const d = new Date(str)
  if (!isNaN(d)) return d.toISOString().slice(0, 10)
  return null
}

// ── Auto-detect document type ─────────────────────────────────────────────────
async function detectDocType(text, filename, apiKey) {
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `What type of financial document is this? Reply with ONLY one of: bank_statement, pay_stub, loan_doc, insurance, tax_form, other\n\nFilename: ${filename}\nText preview: ${text.slice(0, 500)}`
    }]
  })
  const t = res.content[0].text.trim().toLowerCase()
  const types = ['bank_statement', 'pay_stub', 'loan_doc', 'insurance', 'tax_form']
  return types.find(x => t.includes(x)) || 'other'
}

// ── POST /api/documents/upload — auto-detect + route to correct parser ────────
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })

    const apiKey = await getApiKey(req.user.id)
    if (!apiKey) return res.status(402).json({ error: 'NO_KEY' })

    const text    = await extractPdfText(req.file.buffer)
    const docType = await detectDocType(text, req.file.originalname, apiKey)

    // Route to the right parser
    req.docText   = text
    req.docType   = docType
    req.apiKey    = apiKey

    switch (docType) {
      case 'bank_statement': return parseBankStatement(req, res, next)
      case 'pay_stub':       return parsePayStub(req, res, next)
      case 'loan_doc':       return parseLoanDoc(req, res, next)
      default:               return parseGeneric(req, res, next)
    }
  } catch (err) { next(err) }
})

// ── POST /api/documents/bank-statement ────────────────────────────────────────
router.post('/bank-statement', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const apiKey = await getApiKey(req.user.id)
    if (!apiKey) return res.status(402).json({ error: 'NO_KEY' })
    req.docText = await extractPdfText(req.file.buffer)
    req.docType = 'bank_statement'
    req.apiKey  = apiKey
    return parseBankStatement(req, res, next)
  } catch (err) { next(err) }
})

async function parseBankStatement(req, res, next) {
  try {
    const { docText, apiKey } = req
    const client = new Anthropic({ apiKey })

    // Chunk text if large — bank statements can be long
    const textChunk = docText.slice(0, 12000)

    const extraction = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Extract all transactions from this bank statement. Return ONLY valid JSON, no markdown:

{
  "account_name": "string or null",
  "account_last4": "string or null",
  "institution": "string or null",
  "statement_period": "string or null",
  "opening_balance": number or null,
  "closing_balance": number or null,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "merchant/description",
      "amount": number (negative = debit/expense, positive = credit/income),
      "balance": number or null,
      "type": "debit" | "credit" | "transfer"
    }
  ]
}

Rules:
- Debits/withdrawals/purchases → negative amounts
- Credits/deposits/refunds → positive amounts
- Parse EVERY transaction visible in the text
- Normalize dates to YYYY-MM-DD format
- If year is missing, infer from context

STATEMENT TEXT:
${textChunk}`
      }]
    })

    let parsed = null
    try {
      const text = extraction.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      parsed = JSON.parse(text)
    } catch {
      return res.status(422).json({ error: 'Could not parse transactions from this document. Try uploading a cleaner PDF.' })
    }

    const txs = parsed.transactions || []
    if (!txs.length) {
      return res.status(422).json({ error: 'No transactions found in this document.' })
    }

    // Import the transactions
    const { categorizeTransaction, cleanMerchantName } = require('../utils/transactionIntelligence')
    const { rows: accounts } = await pool.query(
      'SELECT id, name FROM accounts WHERE user_id=$1 AND is_debt=FALSE ORDER BY balance DESC LIMIT 1',
      [req.user.id]
    )
    const accountId  = req.body.account_id || accounts[0]?.id || null

    let imported = 0
    const importedTxs = []

    for (const tx of txs) {
      const date = parseDate(tx.date)
      if (!date || isNaN(Number(tx.amount))) continue

      const { cleanedName } = await cleanMerchantName(tx.description, req.user.id).catch(() => ({ cleanedName: null }))
      const { category }    = await categorizeTransaction(tx.description, Number(tx.amount), req.user.id).catch(() => ({ category: 'Other' }))

      const { rows: inserted } = await pool.query(
        `INSERT INTO transactions (user_id, account_id, name, cleaned_name, amount, category, date, source, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'document',null)
         ON CONFLICT DO NOTHING RETURNING *`,
        [req.user.id, accountId, tx.description, cleanedName !== tx.description ? cleanedName : null,
         Number(tx.amount), category, date]
      )
      if (inserted.length) { imported++; importedTxs.push(inserted[0]) }
    }

    // Log the upload
    await pool.query(
      `INSERT INTO document_uploads (user_id, doc_type, filename, result, tx_imported)
       VALUES ($1,'bank_statement',$2,$3,$4)`,
      [req.user.id, req.file?.originalname || 'statement.pdf', JSON.stringify({ ...parsed, transactions: undefined, tx_count: txs.length }), imported]
    )

    res.json({
      doc_type:    'bank_statement',
      institution: parsed.institution,
      period:      parsed.statement_period,
      tx_found:    txs.length,
      tx_imported: imported,
      transactions: importedTxs,
    })
  } catch (err) { next(err) }
}

// ── POST /api/documents/pay-stub ──────────────────────────────────────────────
router.post('/pay-stub', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const apiKey = await getApiKey(req.user.id)
    if (!apiKey) return res.status(402).json({ error: 'NO_KEY' })
    req.docText = await extractPdfText(req.file.buffer)
    req.docType = 'pay_stub'
    req.apiKey  = apiKey
    return parsePayStub(req, res, next)
  } catch (err) { next(err) }
})

async function parsePayStub(req, res, next) {
  try {
    const { docText, apiKey } = req
    const client = new Anthropic({ apiKey })

    const extraction = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Extract pay information from this pay stub. Return ONLY valid JSON:

{
  "employer": "string or null",
  "employee_name": "string or null",
  "pay_period_end": "YYYY-MM-DD or null",
  "pay_frequency": "weekly" | "biweekly" | "semimonthly" | "monthly" | null,
  "gross_pay": number or null,
  "net_pay": number or null,
  "federal_tax": number or null,
  "state_tax": number or null,
  "social_security": number or null,
  "medicare": number or null,
  "health_insurance": number or null,
  "retirement_401k": number or null,
  "other_deductions": number or null,
  "ytd_gross": number or null,
  "ytd_net": number or null,
  "pay_date": "YYYY-MM-DD or null"
}

PAY STUB TEXT:
${docText.slice(0, 4000)}`
      }]
    })

    let parsed = null
    try {
      const text = extraction.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      parsed = JSON.parse(text)
    } catch {
      return res.status(422).json({ error: 'Could not parse pay stub.' })
    }

    // If there's a matching recurring income item, update it
    if (parsed.net_pay && parsed.net_pay > 0) {
      const { rows: incomeItems } = await pool.query(
        `SELECT id, name, amount FROM recurring
         WHERE user_id=$1 AND type='income' AND active=TRUE
         ORDER BY ABS(amount - $2) ASC LIMIT 1`,
        [req.user.id, parsed.net_pay]
      )

      let recurringUpdated = null
      if (incomeItems.length && Math.abs(Number(incomeItems[0].amount) - parsed.net_pay) < parsed.net_pay * 0.15) {
        // Close enough — update the amount
        await pool.query(
          'UPDATE recurring SET amount=$1 WHERE id=$2 AND user_id=$3',
          [parsed.net_pay, incomeItems[0].id, req.user.id]
        )
        recurringUpdated = { id: incomeItems[0].id, name: incomeItems[0].name, old_amount: incomeItems[0].amount, new_amount: parsed.net_pay }
      }

      // Optionally create a transaction for this paycheck
      if (parsed.pay_date && req.body.import_transaction === 'true') {
        const date = parseDate(parsed.pay_date)
        if (date) {
          await pool.query(
            `INSERT INTO transactions (user_id, name, amount, category, date, source, tx_type)
             VALUES ($1,$2,$3,'Income',$4,'document','income') ON CONFLICT DO NOTHING`,
            [req.user.id, `${parsed.employer || 'Paycheck'} — Net Pay`, parsed.net_pay, date]
          )
        }
      }

      await pool.query(
        `INSERT INTO document_uploads (user_id, doc_type, filename, result)
         VALUES ($1,'pay_stub',$2,$3)`,
        [req.user.id, req.file?.originalname || 'paystub.pdf', JSON.stringify(parsed)]
      )

      return res.json({ doc_type: 'pay_stub', ...parsed, recurring_updated: recurringUpdated })
    }

    res.json({ doc_type: 'pay_stub', ...parsed })
  } catch (err) { next(err) }
}

// ── POST /api/documents/loan ──────────────────────────────────────────────────
router.post('/loan', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const apiKey = await getApiKey(req.user.id)
    if (!apiKey) return res.status(402).json({ error: 'NO_KEY' })
    req.docText = await extractPdfText(req.file.buffer)
    req.docType = 'loan_doc'
    req.apiKey  = apiKey
    return parseLoanDoc(req, res, next)
  } catch (err) { next(err) }
})

async function parseLoanDoc(req, res, next) {
  try {
    const { docText, apiKey } = req
    const client = new Anthropic({ apiKey })

    const extraction = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Extract loan/lease details from this document. Return ONLY valid JSON:

{
  "lender": "string or null",
  "loan_type": "mortgage" | "auto" | "personal" | "student" | "lease" | "other",
  "loan_amount": number or null,
  "current_balance": number or null,
  "monthly_payment": number or null,
  "interest_rate": number or null,
  "term_months": number or null,
  "first_payment_date": "YYYY-MM-DD or null",
  "due_day_of_month": number or null,
  "maturity_date": "YYYY-MM-DD or null",
  "account_number_last4": "string or null",
  "property_address": "string or null (mortgages only)"
}

DOCUMENT TEXT:
${docText.slice(0, 4000)}`
      }]
    })

    let parsed = null
    try {
      const text = extraction.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      parsed = JSON.parse(text)
    } catch {
      return res.status(422).json({ error: 'Could not parse loan document.' })
    }

    // Auto-create a recurring item for the monthly payment
    let recurringCreated = null
    if (parsed.monthly_payment && parsed.monthly_payment > 0) {
      const name    = `${parsed.lender || 'Loan'} Payment`
      const dayOfMo = parsed.due_day_of_month || 1
      const { rows: existing } = await pool.query(
        'SELECT id FROM recurring WHERE user_id=$1 AND LOWER(name) LIKE $2 LIMIT 1',
        [req.user.id, `%${(parsed.lender || 'loan').toLowerCase().slice(0, 8)}%`]
      )
      if (!existing.length) {
        const { rows: rec } = await pool.query(
          `INSERT INTO recurring (user_id, name, amount, day_of_month, type, category, active)
           VALUES ($1,$2,$3,$4,'bill','Housing',TRUE) RETURNING *`,
          [req.user.id, name, parsed.monthly_payment, dayOfMo]
        )
        recurringCreated = rec[0]
      }
    }

    await pool.query(
      `INSERT INTO document_uploads (user_id, doc_type, filename, result)
       VALUES ($1,'loan_doc',$2,$3)`,
      [req.user.id, req.file?.originalname || 'loan.pdf', JSON.stringify(parsed)]
    )

    res.json({ doc_type: 'loan_doc', ...parsed, recurring_created: recurringCreated })
  } catch (err) { next(err) }
}

// ── Generic document fallback ─────────────────────────────────────────────────
async function parseGeneric(req, res, next) {
  try {
    const { docText, docType, apiKey } = req
    const client = new Anthropic({ apiKey })

    const extraction = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Summarize the key financial figures from this document in JSON:
{
  "summary": "2-3 sentence plain English summary",
  "key_figures": [{"label": "string", "value": "string"}],
  "action_items": ["string"]
}

DOCUMENT TEXT:
${docText.slice(0, 4000)}`
      }]
    })

    let parsed = { summary: '', key_figures: [], action_items: [] }
    try {
      const text = extraction.content[0].text.trim().replace(/```json\n?|\n?```/g, '')
      parsed = JSON.parse(text)
    } catch { /* use defaults */ }

    await pool.query(
      `INSERT INTO document_uploads (user_id, doc_type, filename, result)
       VALUES ($1,$2,$3,$4)`,
      [req.user.id, docType, req.file?.originalname || 'document.pdf', JSON.stringify(parsed)]
    )

    res.json({ doc_type: docType, ...parsed })
  } catch (err) { next(err) }
}

// ── GET /api/documents/tax-summary ───────────────────────────────────────────
router.get('/tax-summary', async (req, res, next) => {
  try {
    const year   = parseInt(req.query.year || new Date().getFullYear())
    const apiKey = await getApiKey(req.user.id)
    if (!apiKey) return res.status(402).json({ error: 'NO_KEY' })

    // Pull all transactions for the tax year
    const { rows: txs } = await pool.query(
      `SELECT name, COALESCE(cleaned_name, name) AS display_name, amount, category, date, note
       FROM transactions
       WHERE user_id=$1
         AND EXTRACT(YEAR FROM date) = $2
         AND COALESCE(tx_type,'expense') != 'transfer'
       ORDER BY date ASC`,
      [req.user.id, year]
    )

    if (!txs.length) {
      return res.json({ year, message: `No transactions found for ${year}.`, categories: {}, summary: {} })
    }

    // Group by category
    const byCategory = {}
    let totalIncome = 0, totalExpenses = 0

    for (const tx of txs) {
      const cat = tx.category || 'Other'
      if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0, transactions: [] }
      byCategory[cat].total += Number(tx.amount)
      byCategory[cat].count++
      byCategory[cat].transactions.push({
        date:   String(tx.date).slice(0, 10),
        name:   tx.display_name,
        amount: Number(tx.amount),
      })
      if (Number(tx.amount) > 0) totalIncome    += Number(tx.amount)
      else                       totalExpenses   += Math.abs(Number(tx.amount))
    }

    // Identify potentially deductible categories
    const DEDUCTIBLE_CATEGORIES = ['Healthcare', 'Charity', 'Business', 'Education', 'Home Office']
    const potentiallyDeductible = Object.entries(byCategory)
      .filter(([cat]) => DEDUCTIBLE_CATEGORIES.some(d => cat.toLowerCase().includes(d.toLowerCase())))
      .map(([cat, data]) => ({ category: cat, total: Math.abs(data.total), count: data.count }))

    // AI narrative summary
    const client = new Anthropic({ apiKey: apiKey })
    const categoryList = Object.entries(byCategory)
      .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
      .slice(0, 12)
      .map(([cat, d]) => `${cat}: $${Math.abs(d.total).toFixed(2)}`)
      .join(', ')

    const aiRes = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Write a 3-4 sentence plain-English tax year summary for ${year}. Be specific with numbers. Note anything that might be tax-relevant (large healthcare spend, charitable donations, business expenses). Don't give tax advice — just describe what the data shows.

Income: $${totalIncome.toFixed(2)}
Expenses: $${totalExpenses.toFixed(2)}
Net: $${(totalIncome - totalExpenses).toFixed(2)}
Categories: ${categoryList}`
      }]
    })

    res.json({
      year,
      total_income:    Math.round(totalIncome * 100) / 100,
      total_expenses:  Math.round(totalExpenses * 100) / 100,
      net:             Math.round((totalIncome - totalExpenses) * 100) / 100,
      tx_count:        txs.length,
      by_category:     byCategory,
      potentially_deductible: potentiallyDeductible,
      narrative:       aiRes.content[0].text.trim(),
    })
  } catch (err) { next(err) }
})

// ── GET /api/documents/history ────────────────────────────────────────────────
router.get('/history', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, doc_type, filename, parsed_at, tx_imported,
              result->>'institution' AS institution,
              result->>'statement_period' AS period,
              result->>'employer' AS employer,
              result->>'lender' AS lender
       FROM document_uploads
       WHERE user_id=$1
       ORDER BY parsed_at DESC LIMIT 20`,
      [req.user.id]
    )
    res.json({ uploads: rows })
  } catch (err) { next(err) }
})

module.exports = router
