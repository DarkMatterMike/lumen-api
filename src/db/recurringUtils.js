// Shared utility — returns all occurrence dates for a recurring item in a given year/month
function getOccurrencesForMonth(r, year, month) {
  if (r.frequency === 'biweekly' && r.start_date) {
    const start      = new Date(r.start_date)
    start.setHours(0, 0, 0, 0)
    const monthStart = new Date(year, month, 1)
    const monthEnd   = new Date(year, month + 1, 0)
    const dates      = []

    let cur = new Date(start)
    while (cur < monthStart)  cur = new Date(cur.getTime() + 14 * 86400000)
    while (cur >= monthStart) cur = new Date(cur.getTime() - 14 * 86400000)
    cur = new Date(cur.getTime() + 14 * 86400000)

    while (cur <= monthEnd) {
      if (cur >= monthStart) dates.push(new Date(cur))
      cur = new Date(cur.getTime() + 14 * 86400000)
    }
    return dates
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const day = Math.min(r.day_of_month, daysInMonth)
  return [new Date(year, month, day)]
}

module.exports = { getOccurrencesForMonth }
