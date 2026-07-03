/**
 * Seed script — imports Myko_Operations_Hub_Jun (1).xlsx into Supabase.
 * Usage: npm run seed (from backend/)
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env
 */
import * as XLSX from 'xlsx'
import { createClient } from '@supabase/supabase-js'
import * as path from 'path'
import dotenv from 'dotenv'

dotenv.config()

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const XLSX_PATH = path.resolve(
  process.env.XLSX_PATH ?? '/Users/xiren/Downloads/Myko_Operations_Hub_Jun (1).xlsx'
)

function excelDateToISO(val: unknown): string | null {
  if (!val) return null
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val)
    if (!d) return null
    const mm = String(d.m).padStart(2, '0')
    const dd = String(d.d).padStart(2, '0')
    return `${d.y}-${mm}-${dd}`
  }
  if (typeof val === 'string' && val.match(/^\d{4}-\d{2}-\d{2}/)) return val.slice(0, 10)
  return null
}

function monthYearOf(dateStr: string | null): string | null {
  if (!dateStr) return null
  return dateStr.slice(0, 7) + '-01'
}

async function seedBuilds(wb: XLSX.WorkBook) {
  const builds: Record<string, unknown>[] = []

  for (const { sheetName, type } of [
    { sheetName: 'Jewelry Tracker', type: 'jewelry' },
  ]) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null })

    // The sheet has 4 week blocks side by side with 17 columns each
    // Columns: Product/Build, Lang, Approved, Phase1 start, Into Proofread,
    //          Into Testing, Outcome decided, Outcome, Live all geos,
    //          Build d, Proof d, Test d, Exp d, TOTAL d, Phase, Notes, (spacer)
    const WEEK_COLS = 17
    const WEEKS = 4

    // Raw sheet to get actual column headers
    const rawRows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null }) as unknown[][]

    // Find header row (contains "Product / Build")
    let headerRowIdx = -1
    for (let i = 0; i < rawRows.length; i++) {
      if (Array.isArray(rawRows[i]) && String(rawRows[i][0]).includes('Product')) {
        headerRowIdx = i
        break
      }
    }
    if (headerRowIdx === -1) continue

    for (let w = 0; w < WEEKS; w++) {
      const colOffset = w * WEEK_COLS
      for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
        const row = rawRows[r] as unknown[]
        const productName = row[colOffset + 0]
        if (!productName) continue

        const approvedRaw = row[colOffset + 2]
        const approvedDate = excelDateToISO(approvedRaw)

        builds.push({
          type,
          week_number: w + 1,
          month_year: monthYearOf(approvedDate) ?? '2026-06-01',
          product_name: String(productName),
          language: row[colOffset + 1] ? String(row[colOffset + 1]) : null,
          approved_date: approvedDate,
          phase1_start: excelDateToISO(row[colOffset + 3]),
          into_proofread: excelDateToISO(row[colOffset + 4]),
          into_testing: excelDateToISO(row[colOffset + 5]),
          outcome_decided: excelDateToISO(row[colOffset + 6]),
          outcome: row[colOffset + 7] ? String(row[colOffset + 7]).toLowerCase() : null,
          live_all_geos: excelDateToISO(row[colOffset + 8]),
          notes: row[colOffset + 15] ? String(row[colOffset + 15]) : null,
        })
      }
    }
  }

  if (builds.length === 0) {
    console.log('No builds found to seed.')
    return
  }

  const { error } = await supabase.from('builds').insert(builds)
  if (error) throw new Error(`builds insert: ${error.message}`)
  console.log(`✓ Inserted ${builds.length} builds`)
}

async function main() {
  console.log('Reading:', XLSX_PATH)
  const wb = XLSX.readFile(XLSX_PATH, { cellDates: true })

  await seedBuilds(wb)

  console.log('\nSeed complete.')
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
