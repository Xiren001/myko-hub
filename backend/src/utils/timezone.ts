export interface TimezoneNow {
  year:      number
  month:     number // 0-indexed
  dayOfMonth: number
  weekday:   number // 0=Sun … 6=Sat
  hour:      number
  minute:    number
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

export function getDateTimeInTimezone(tz: string): TimezoneNow {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''

  return {
    year:       parseInt(get('year')),
    month:      parseInt(get('month')) - 1,
    dayOfMonth: parseInt(get('day')),
    weekday:    WEEKDAY[get('weekday')] ?? 0,
    hour:       parseInt(get('hour')) || 0,
    minute:     parseInt(get('minute')) || 0,
  }
}
