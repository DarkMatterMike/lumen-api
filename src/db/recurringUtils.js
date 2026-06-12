/**
 * recurringUtils.js
 *
 * getOccurrencesForMonth(r, year, month)
 *   Returns all occurrence dates for a recurring item within a
 *   given calendar month.
 *
 * monthlyAmount(r)
 *   Returns the expected monthly dollar total for a recurring item,
 *   accounting for frequency (biweekly = ×2, weekly = ×4, etc.)
 *   Uses the AVERAGE over a 4-week month so totals stay consistent.
 */

function getOccurrencesForMonth(r, year, month) {
  const monthStart = new Date(year, month, 1)
  const monthEnd   = new Date(year, month + 1, 0)

  if ((r.frequency === 'biweekly' || r.frequency === 'weekly') && r.start_date) {
    const anchor = new Date(r.start_date)
    anchor.setHours(0, 0, 0, 0)

    const periodDays = r.frequency === 'biweekly' ? 14 : 7
    const PERIOD     = periodDays * 24 * 60 * 60 * 1000

    // Find the last occurrence on or before monthStart, then walk forward
    const msSinceAnchor  = monthStart.getTime() - anchor.getTime()
    const periodsToStart = Math.floor(msSinceAnchor / PERIOD)
    // Step back one period to guarantee we don't miss an occurrence on day 1
    let cur = new Date(anchor.getTime() + (periodsToStart - 1) * PERIOD)

    const dates = []
    while (cur <= monthEnd) {
      if (cur >= monthStart) dates.push(new Date(cur))
      cur = new Date(cur.getTime() + PERIOD)
    }
    return dates
  }

  // Monthly (default)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const day = Math.min(r.day_of_month, daysInMonth)
  return [new Date(year, month, day)]
}

/**
 * Returns the normalised average monthly amount for a recurring item.
 * Biweekly = 26 occurrences/year ÷ 12 months = 2.167× per month on average.
 * Using exact multipliers keeps annual totals accurate.
 */
function monthlyAmount(r) {
  const amt = Number(r.amount) || 0
  switch (r.frequency) {
    case 'biweekly': return amt * 26 / 12   // ≈ 2.167×
    case 'weekly':   return amt * 52 / 12   // ≈ 4.333×
    case 'monthly':
    default:         return amt
  }
}

module.exports = { getOccurrencesForMonth, monthlyAmount }
