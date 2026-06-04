export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null
  const diff = new Date(to).getTime() - new Date(from).getTime()
  return Math.round(diff / (1000 * 60 * 60 * 24))
}

export function computePhase(build: {
  phase1_start?: string | null
  into_proofread?: string | null
  into_testing?: string | null
  outcome_decided?: string | null
}): string {
  if (build.outcome_decided) return 'decided'
  if (build.into_testing) return 'testing'
  if (build.into_proofread) return 'proofread'
  if (build.phase1_start) return 'building'
  return 'pending'
}

export interface RawBuild {
  phase1_start?: string | null
  into_proofread?: string | null
  into_testing?: string | null
  outcome_decided?: string | null
  outcome?: string | null
  week_number?: number | null
  type?: string | null
  [key: string]: unknown
}

export function enrichBuild(build: RawBuild) {
  const today = new Date().toISOString().split('T')[0]
  return {
    ...build,
    phase: computePhase(build),
    build_days: daysBetween(build.phase1_start as string, build.into_proofread as string),
    proof_days: daysBetween(build.into_proofread as string, build.into_testing as string),
    test_days: daysBetween(build.into_testing as string, build.outcome_decided as string),
    total_days: build.phase1_start
      ? daysBetween(build.phase1_start as string, (build.outcome_decided as string) ?? today)
      : null,
  }
}

export function avg(nums: (number | null)[]): number | null {
  const valid = nums.filter((n): n is number => n !== null)
  if (valid.length === 0) return null
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10
}

export function monthStart(monthStr: string): string {
  return `${monthStr}-01`
}

export function monthEnd(monthStr: string): string {
  const [year, month] = monthStr.split('-').map(Number)
  const last = new Date(year, month, 0).getDate()
  return `${monthStr}-${String(last).padStart(2, '0')}`
}
