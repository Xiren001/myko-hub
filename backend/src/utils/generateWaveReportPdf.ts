import PDFDocument from 'pdfkit'
import type { WaveReportData } from './computeWavesReport'

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  ink:     '#0f172a',
  mid:     '#334155',
  muted:   '#64748b',
  faint:   '#94a3b8',
  rule:    '#e2e8f0',
  accent:  '#1d4ed8',
  surface: '#f8fafc',
  white:   '#ffffff',
}

const PAGE_W  = 595.28
const PAGE_H  = 841.89
const MARGIN  = 48
const BODY_W  = PAGE_W - MARGIN * 2

function formatCurrency(n: number): string {
  if (n >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)     return `€${(n / 1_000).toFixed(1)}K`
  return `€${n.toLocaleString()}`
}

function fmtDate(isoStr: string): string {
  return new Date(isoStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function weekRangeLabel(data: WaveReportData): string {
  const s = new Date(data.weekStart)
  const e = new Date(data.weekEnd)
  const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return `${fmt(s)} – ${fmt(e)}, ${s.getFullYear()}`
}

interface MetricRow {
  label: string
  value: string
  note?: string
  desc: string
}

function wave1Metrics(d: WaveReportData): MetricRow[] {
  return [
    {
      label: 'Wave 1 → Wave 2',
      value: d.pctWave1ToWave2 !== null ? `${d.pctWave1ToWave2}%` : '—',
      note:  `${d.wave1ToWave2Count} of ${d.wave1Total} products`,
      desc:  'Percentage of Wave 1 products promoted to Wave 2. Denominator is Wave 1 + Wave 2 combined.',
    },
    {
      label: 'Products Tested',
      value: String(d.productsTested),
      desc:  'Wave 1 products where EN, ES, and DE are all in "launched" status — each product counts as 1.',
    },
    {
      label: 'Days: Spot → English Test Done',
      value: d.avgDaysSpotToEnTest !== null ? `${d.avgDaysSpotToEnTest}d` : '—',
      desc:  'Average Phase 1 days (lp_building_at → lp_ready_at) for English subitems in Wave 1.',
    },
    {
      label: 'Avg Days in Proofread',
      value: d.avgDaysProofread !== null ? `${d.avgDaysProofread}d` : '—',
      desc:  'Average days from Proofread start to Ready to Launch (lp_proofread_at → lp_ready_to_launch_at), excluding EN subitems.',
    },
    {
      label: 'Proofread Queue (Wave 1)',
      value: String(d.proofreadQueue),
      desc:  'Non-English Wave 1 subitems with "proofread" in status, whose product is active in the Proofreading page.',
    },
    {
      label: 'Days: EN Done → Others Done',
      value: d.avgDaysEnToOthers !== null ? `${d.avgDaysEnToOthers}d` : '—',
      desc:  'Average Phase 1 days across all Wave 1 subitems (EN, ES, DE and others combined).',
    },
  ]
}

function waves27Metrics(d: WaveReportData, period: 'week' | 'month'): MetricRow[] {
  const periodLabel = period === 'month' ? 'Month' : 'Week'
  const validAvgs = d.newWaveCampaignAvgDays.map(r => r.avg).filter((v): v is number => v !== null)
  const overall = validAvgs.length > 0
    ? Math.round((validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length) * 10) / 10
    : null

  return [
    {
      label: 'Proofread Queue (Waves 2–7)',
      value: String(d.proofreadQueueWaves27),
      desc:  'Waves 2–7 subitems with "proofread" in status, whose product is active in the Proofreading page.',
    },
    {
      label: 'Avg Languages per Active Product',
      value: d.avgLangsPerProduct !== null ? String(d.avgLangsPerProduct) : '—',
      desc:  'Total language subitem count across all active Waves 2–7 products divided by the number of products.',
    },
    {
      label: 'Most Languages Live',
      value: d.mostLangsProduct !== null ? String(d.mostLangsProduct.count) : '—',
      note:  d.mostLangsProduct?.name,
      desc:  'The single Waves 2–7 product live in the highest number of languages.',
    },
    {
      label: `New Languages Launched This ${periodLabel}`,
      value: String(d.newLanguagesLaunchedThisWeek),
      desc:  `Across all products, all waves — subitems whose ad and website status are both now launched/running but weren't both at the last ${period}ly snapshot.`,
    },
    {
      label: 'Active Winners — Small (1–7 langs)',
      value: String(d.activeWinners.small),
      desc:  'Products live in 1–7 language markets simultaneously.',
    },
    {
      label: 'Active Winners — Medium (8–15 langs)',
      value: String(d.activeWinners.medium),
      desc:  'Products live in 8–15 language markets simultaneously.',
    },
    {
      label: 'Active Winners — Big (16+ langs)',
      value: String(d.activeWinners.big),
      desc:  'Products live in 16 or more language markets simultaneously.',
    },
    {
      label: '% Language Launches Profitable',
      value: d.profitableLaunchPct !== null ? `${d.profitableLaunchPct}%` : '—',
      note:  d.totalLaunches > 0 ? `${d.profitableLaunches} of ${d.totalLaunches} markets` : undefined,
      desc:  'Language markets where Net sales > Cost of goods sold, per the uploaded Shopify billing-country CSV.',
    },
    {
      label: 'Avg Revenue per Active Winner',
      value: d.avgRevenuePerWinner !== null ? formatCurrency(d.avgRevenuePerWinner) : '—',
      note:  d.activeWinnerCount > 0 ? `${d.activeWinnerCount} products` : undefined,
      desc:  'Revenue for Waves 2–7 products with a language whose ad + website status are both running or launched, divided by their count, from the Shopify product-title CSV.',
    },
    {
      label: 'Arriving to New Wave — Overall Avg',
      value: overall !== null ? `${overall}d` : '—',
      desc:  'Average Phase 1 days (lp_building_at → lp_ready_at) for new language campaigns introduced per wave. Overall across waves 2–7.',
    },
    ...d.newWaveCampaignAvgDays.map(({ wave, avg }) => ({
      label: `  Wave ${wave} new languages`,
      value: avg !== null ? `${avg}d` : '—',
      desc:  `Phase 1 avg for the 3 new languages introduced in Wave ${wave}.`,
    })),
  ]
}

export function generateWaveReportPdf(
  data: WaveReportData,
  isSnapshot: boolean,
  period: 'week' | 'month' = 'week'
): Promise<Buffer> {
  const reportTitle = period === 'month' ? 'Waves Monthly Report' : 'Waves Weekly Report'
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: {
      Title:   `${reportTitle} — ${weekRangeLabel(data)}`,
      Author:  'Myko Hub',
      Subject: reportTitle,
    }})
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end',  () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    let y = 0

    // ── HEADER BAND ──────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 110).fill(C.ink)

    doc.font('Helvetica-Bold').fontSize(20).fillColor(C.white)
       .text(reportTitle.toUpperCase(), MARGIN, 28, { width: BODY_W })

    doc.font('Helvetica').fontSize(11).fillColor('#94a3b8')
       .text(weekRangeLabel(data), MARGIN, 56, { width: BODY_W })

    const tag = isSnapshot ? 'Saved Snapshot' : 'Live Data'
    const tagX = PAGE_W - MARGIN - 90
    doc.roundedRect(tagX, 32, 88, 20, 4).fill(isSnapshot ? C.accent : '#475569')
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.white)
       .text(tag.toUpperCase(), tagX, 38.5, { width: 88, align: 'center' })

    doc.font('Helvetica').fontSize(8).fillColor('#64748b')
       .text(`Generated ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
             MARGIN, 86, { width: BODY_W })

    y = 126

    // ── SECTION RENDERER ─────────────────────────────────────────────────────
    function sectionHeader(title: string) {
      // rule
      doc.rect(MARGIN, y, BODY_W, 0.5).fill(C.rule)
      y += 10
      doc.rect(MARGIN, y, 3, 13).fill(C.accent)
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
         .text(title.toUpperCase(), MARGIN + 10, y + 2, { width: BODY_W - 10, characterSpacing: 1 })
      y += 22
    }

    function metricRow(row: MetricRow) {
      if (y > PAGE_H - 100) {
        doc.addPage()
        y = MARGIN
      }

      const COL_VAL  = 110
      const COL_BODY = BODY_W - COL_VAL

      // Label
      doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
         .text(row.label, MARGIN, y, { width: COL_BODY - 12 })

      // Value
      doc.font('Helvetica-Bold').fontSize(18).fillColor(C.accent)
         .text(row.value, MARGIN + COL_BODY, y - 2, { width: COL_VAL, align: 'right' })

      const labelH = doc.heightOfString(row.label, { width: COL_BODY - 12 })
      y += Math.max(labelH, 22)

      if (row.note) {
        doc.font('Helvetica').fontSize(8).fillColor(C.muted)
           .text(row.note, MARGIN, y, { width: COL_BODY })
        y += 12
      }

      // Description
      doc.font('Helvetica').fontSize(8).fillColor(C.faint)
         .text(row.desc, MARGIN, y, { width: COL_BODY - 4 })
      const descH = doc.heightOfString(row.desc, { width: COL_BODY - 4 })
      y += descH + 12

      // thin separator
      doc.rect(MARGIN, y, BODY_W, 0.5).fill(C.rule)
      y += 10
    }

    function newLanguagesSection(period: 'week' | 'month') {
      const periodLabel = period === 'month' ? 'Month' : 'Week'
      sectionHeader(`New Languages Launched This ${periodLabel} — Detail`)

      const list = data.newLanguagesLaunchedList ?? []
      if (list.length === 0) {
        doc.font('Helvetica').fontSize(8).fillColor(C.faint)
           .text('No new languages launched this period.', MARGIN, y, { width: BODY_W })
        y += 16
        return
      }

      const grouped: Record<string, string[]> = {}
      for (const { product, language } of list) {
        (grouped[product] ??= []).push(language)
      }
      const products = Object.keys(grouped).sort((a, b) => a.localeCompare(b))

      for (const product of products) {
        if (y > PAGE_H - 60) { doc.addPage(); y = MARGIN }

        const langs = grouped[product].sort().join(', ')
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
           .text(product, MARGIN, y, { width: 200, continued: false })
        doc.font('Helvetica').fontSize(8).fillColor(C.muted)
           .text(langs, MARGIN + 200, y, { width: BODY_W - 200, align: 'right' })

        const rowH = Math.max(
          doc.heightOfString(product, { width: 200 }),
          doc.heightOfString(langs, { width: BODY_W - 200 }),
        )
        y += Math.max(rowH, 12) + 6
      }

      y += 4
      doc.rect(MARGIN, y, BODY_W, 0.5).fill(C.rule)
      y += 10
    }

    function teamQueueSection() {
      sectionHeader('Team Queue')

      const groups = [
        { label: 'Wave 1',    queue: data.teamQueue.wave1 },
        { label: 'Waves 2–7', queue: data.teamQueue.waves27 },
      ]

      for (const { label, queue } of groups) {
        if (y > PAGE_H - 80) { doc.addPage(); y = MARGIN }

        doc.font('Helvetica-Bold').fontSize(8).fillColor(C.mid)
           .text(label.toUpperCase(), MARGIN, y, { characterSpacing: 0.5 })
        y += 14

        const HALF = BODY_W / 2 - 10
        const teams = [
          { name: 'Ad Team',  q: queue.ad },
          { name: 'Web Team', q: queue.web },
        ]

        const startY = y
        let maxY = y

        for (let i = 0; i < 2; i++) {
          const { name, q } = teams[i]
          const xOff = MARGIN + i * (HALF + 20)
          let ty = startY

          const total = Object.values(q).reduce((s, n) => s + n, 0)
          doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
             .text(name, xOff, ty, { width: HALF })
          ty += 14
          doc.font('Helvetica-Bold').fontSize(16).fillColor(C.accent)
             .text(String(total), xOff, ty, { width: HALF })
          ty += 22

          const entries = Object.entries(q).sort(([, a], [, b]) => b - a)
          for (const [status, count] of entries) {
            doc.font('Helvetica').fontSize(8).fillColor(C.muted)
               .text(status, xOff, ty, { width: HALF - 30, continued: false })
            doc.font('Helvetica-Bold').fontSize(8).fillColor(C.ink)
               .text(String(count), xOff + HALF - 28, ty, { width: 28, align: 'right' })
            ty += 12
          }
          if (entries.length === 0) {
            doc.font('Helvetica').fontSize(8).fillColor(C.faint)
               .text('All clear', xOff, ty)
            ty += 12
          }

          maxY = Math.max(maxY, ty)
        }

        y = maxY + 12
        doc.rect(MARGIN, y, BODY_W, 0.5).fill(C.rule)
        y += 16
      }
    }

    // ── BUILD SECTIONS ────────────────────────────────────────────────────────
    sectionHeader('Wave 1')
    for (const row of wave1Metrics(data)) metricRow(row)
    y += 4

    sectionHeader('Waves 2–7')
    for (const row of waves27Metrics(data, period)) metricRow(row)
    y += 4

    newLanguagesSection(period)
    y += 4

    teamQueueSection()

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const footerY = PAGE_H - 36
    doc.rect(0, footerY - 1, PAGE_W, 0.5).fill(C.rule)
    doc.font('Helvetica').fontSize(8).fillColor(C.faint)
       .text(`Myko Hub — ${reportTitle}`, MARGIN, footerY + 6, { width: BODY_W, align: 'center' })

    doc.end()
  })
}
