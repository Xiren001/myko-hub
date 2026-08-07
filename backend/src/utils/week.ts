// Monday-anchored ISO week bucketing, shared by team-performance event logging and reporting
// so both sides agree on which calendar week a given timestamp falls into.
export function weekStartISO(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = utc.getUTCDay() // 0=Sun … 6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1
  utc.setUTCDate(utc.getUTCDate() - diffToMonday)
  return utc.toISOString().slice(0, 10)
}

export function recentWeekStarts(count: number, from: Date = new Date()): string[] {
  const start = weekStartISO(from)
  const weeks: string[] = []
  const cursor = new Date(`${start}T00:00:00.000Z`)
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(cursor)
    d.setUTCDate(d.getUTCDate() - i * 7)
    weeks.push(d.toISOString().slice(0, 10))
  }
  return weeks
}
