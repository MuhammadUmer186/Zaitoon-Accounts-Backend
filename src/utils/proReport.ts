import { Response } from 'express'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { PrismaClient } from '@prisma/client'

// "Professional report" model shared by every catalog report. A report is
// described once (headline KPIs + ordered sections) and rendered three ways:
// the JSON the Reports page draws, a designed PDF, and a formatted Excel
// workbook. CSV exports the primary table.

export type CellFormat = 'text' | 'money' | 'number' | 'integer' | 'date' | 'datetime' | 'status' | 'percent' | 'code'

export interface ReportColumn {
  key: string
  label: string
  format?: CellFormat
  width?: number // relative weight in the PDF / character width hint in Excel
}

export type RowStyle = 'heading' | 'subtotal' | 'indent'
export type ReportRow = Record<string, unknown> & { _style?: RowStyle }

export interface ReportKpi {
  label: string
  value: number | string
  format?: CellFormat
  hint?: string
  tone?: 'default' | 'dark' | 'positive' | 'negative' | 'warning'
}

export interface TableSection {
  type: 'table'
  id: string
  title: string
  subtitle?: string
  columns: ReportColumn[]
  rows: ReportRow[]
  totals?: ReportRow
  newPage?: boolean
  register?: boolean // long transaction list: per-page totals + grand total line in the PDF
  primary?: boolean // the table CSV exports
  emptyMessage?: string
}

export interface StatsSection {
  type: 'stats'
  id: string
  title: string
  items: { label: string; value: number | string; tone?: 'default' | 'positive' | 'negative' | 'warning' }[]
  note?: string
}

export interface NoteSection {
  type: 'note'
  id: string
  title: string
  text: string
  tone?: 'default' | 'warning'
}

export type ReportSection = TableSection | StatsSection | NoteSection

export interface ProReport {
  key: string
  eyebrow: string // e.g. "PURCHASE REPORT"
  headline: string // e.g. "Purchases at a glance"
  summaryLine: string // e.g. "Transaction period: … | 51 purchases | 15 suppliers"
  orgName: string
  scopeLabel: string // branch name or "All branches"
  periodLabel: string
  currency: string
  generatedAt: string
  kpis: ReportKpi[]
  sections: ReportSection[]
  editableName?: string // name of the Excel "editable data" sheet, e.g. "Editable purchases"
}

// ── Formatting ──────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function fmtMoney(n: number): string {
  const v = Math.abs(n) < 0.005 ? 0 : n
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtDateShort(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  if (isNaN(date.getTime())) return String(d)
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return `${MONTHS_LONG[m - 1]} ${y}`
}

export const pct = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0)

export function formatCell(value: unknown, format: CellFormat = 'text'): string {
  if (value === null || value === undefined || value === '') return ''
  switch (format) {
    case 'money': return typeof value === 'number' ? fmtMoney(value) : String(value)
    case 'number': return typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: 3 }) : String(value)
    case 'integer': return typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : String(value)
    case 'percent': return typeof value === 'number' ? `${value.toFixed(1)}%` : String(value)
    case 'date': return fmtDateShort(value as string)
    case 'datetime': {
      const d = new Date(value as string)
      return isNaN(d.getTime()) ? String(value) : `${fmtDateShort(d)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    }
    case 'status': return humanizeStatus(String(value))
    default: return String(value)
  }
}

export function humanizeStatus(s: string): string {
  const map: Record<string, string> = {
    approved: 'Unpaid', partial: 'Partial', paid: 'Paid', void: 'Void', draft: 'Draft', submitted: 'Submitted',
    over: 'Over', short: 'Short', balanced: 'Balanced', bank_transfer: 'Bank Transfer',
  }
  return map[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

const isNumericFormat = (f?: CellFormat) => f === 'money' || f === 'number' || f === 'integer' || f === 'percent'

// ── Scope / period helpers ──────────────────────────────────────────────────

export async function reportScope(prisma: PrismaClient, organizationId: string, branchId?: string) {
  const [org, branch] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true, currency: true } }),
    branchId ? prisma.branch.findFirst({ where: { id: branchId, organizationId }, select: { name: true } }) : null,
  ])
  return {
    orgName: org?.name ?? 'Organization',
    currency: org?.currency ?? 'SAR',
    scopeLabel: branch?.name ?? 'All branches',
  }
}

// Period label from the filter if given, otherwise from the data's own range
export function periodLabelFor(fromDate?: string, toDate?: string, dates: Date[] = []): string {
  if (fromDate || toDate) {
    const f = fromDate ? fmtDateShort(fromDate) : 'Start'
    const t = toDate ? fmtDateShort(toDate) : 'Today'
    return `${f} – ${t}`
  }
  if (dates.length === 0) return 'All time'
  const ms = dates.map((d) => d.getTime())
  return `${fmtDateShort(new Date(Math.min(...ms)))} – ${fmtDateShort(new Date(Math.max(...ms)))}`
}

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`

// ── Dispatcher ──────────────────────────────────────────────────────────────

export async function sendProReport(res: Response, format: string | undefined, report: ProReport, legacy: Record<string, unknown> = {}): Promise<void> {
  const fileBase = `${report.key}-${new Date().toISOString().slice(0, 10)}`
  if (format === 'pdf') return renderPdf(res, report, fileBase)
  if (format === 'excel') return renderExcel(res, report, fileBase)
  if (format === 'csv') return renderCsv(res, report, fileBase)
  res.json({ ...legacy, report })
}

// ── PDF ─────────────────────────────────────────────────────────────────────

const C = {
  ink: '#07131b',
  text: '#1f2933',
  muted: '#5b6b78',
  faint: '#8a99a6',
  accent: '#1d5f7a',
  amber: '#f5b62b',
  card: '#edf2f5',
  zebra: '#f1f5f8',
  totals: '#dce8ef',
  rule: '#cfdbe3',
  positive: '#15803d',
  negative: '#b91c1c',
  warning: '#b45309',
}

const STATUS_COLORS: Record<string, string> = {
  paid: C.positive, approved: C.accent, partial: C.warning, void: C.negative,
  draft: C.faint, submitted: C.accent, over: C.positive, short: C.negative, balanced: C.positive,
}

// The built-in Helvetica font is WinAnsi-encoded: swap characters it can't
// draw for close equivalents instead of letting them render as junk.
const pdfSafe = (t: string) => t.replace(/−/g, '-').replace(/≠/g, '<>').replace(/[←-⇿]/g, '>').replace(/…/g, '...')

const PAGE = { w: 841.89, h: 595.28, m: 40 }
const CONTENT_W = PAGE.w - PAGE.m * 2
const BOTTOM = PAGE.h - 58 // footer zone starts here
const ROW_H = 20
const HEAD_H = 24
const REGISTER_TOP = 104
// Rows per register page — the PDF layout decides it, and the Excel/CSV
// exports paginate the same way so every format lines up page for page.
const REGISTER_PAGE_ROWS = Math.max(1, Math.floor((BOTTOM - REGISTER_TOP - HEAD_H - (ROW_H + 2) - 34) / ROW_H))

function renderPdf(res: Response, report: ProReport, fileBase: string) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`)

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE.m, bufferPages: true, info: { Title: report.headline, Author: report.orgName } })
  doc.pipe(res)

  let y = 0
  let firstPage = true

  const startPage = (title: string, subtitle?: string) => {
    if (!firstPage) doc.addPage()
    firstPage = false
    doc.rect(0, 0, PAGE.w, 9).fill(C.ink)
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent)
      .text(pdfSafe(report.eyebrow.toUpperCase()), PAGE.m, 30, { lineBreak: false, characterSpacing: 0.4 })
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text(pdfSafe(`${report.orgName.toUpperCase()}  /  ${report.scopeLabel.toUpperCase()}`), PAGE.m, 30, { width: CONTENT_W, align: 'right', lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(24).fillColor(C.ink).text(pdfSafe(title), PAGE.m, 46, { width: CONTENT_W, lineBreak: false })
    if (subtitle) doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(pdfSafe(subtitle), PAGE.m, 80, { width: CONTENT_W, lineBreak: false })
    y = subtitle ? 104 : 90
  }

  const ensure = (needed: number, contTitle: string) => {
    if (y + needed > BOTTOM) startPage(contTitle)
  }

  const sectionHeading = (title: string, subtitle?: string) => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text(pdfSafe(title), PAGE.m, y, { lineBreak: false })
    y += 18
    if (subtitle) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(pdfSafe(subtitle), PAGE.m, y, { width: CONTENT_W, lineBreak: false })
      y += 14
    }
    y += 4
  }

  // KPI cards
  const drawKpis = (kpis: ReportKpi[]) => {
    if (kpis.length === 0) return
    const gap = 14
    const w = (CONTENT_W - gap * (kpis.length - 1)) / kpis.length
    const h = 82
    kpis.forEach((k, i) => {
      const x = PAGE.m + i * (w + gap)
      const dark = k.tone === 'dark'
      doc.roundedRect(x, y, w, h, 6).fill(dark ? C.ink : C.card)
      doc.font('Helvetica-Bold').fontSize(8).fillColor(dark ? '#9fc3d6' : C.muted)
        .text(pdfSafe(k.label.toUpperCase()), x + 14, y + 13, { width: w - 28, lineBreak: false, characterSpacing: 0.3 })
      const valueColor = dark ? C.amber
        : k.tone === 'positive' ? C.positive : k.tone === 'negative' ? C.negative : k.tone === 'warning' ? C.warning : C.ink
      const valueText = typeof k.value === 'number' ? formatCell(k.value, k.format ?? 'money') : k.value
      doc.font('Helvetica-Bold').fontSize(valueText.length > 14 ? 17 : 21).fillColor(valueColor)
        .text(pdfSafe(valueText), x + 14, y + 30, { width: w - 28, lineBreak: false, ellipsis: true })
      if (k.hint) {
        doc.font('Helvetica').fontSize(8).fillColor(dark ? '#d5e3ea' : C.muted)
          .text(pdfSafe(k.hint), x + 14, y + 60, { width: w - 28, lineBreak: false, ellipsis: true })
      }
    })
    y += h + 22
  }

  const colWidths = (cols: ReportColumn[]) => {
    const weights = cols.map((c) => c.width ?? (c.format === 'money' ? 1.25 : c.format === 'date' ? 1.05 : c.format === 'datetime' ? 1.35 : c.format === 'status' ? 0.9
      : c.format === 'integer' || c.format === 'number' || c.format === 'percent' ? 0.8 : c.format === 'code' ? 1.35 : 1.9))
    const total = weights.reduce((s, w) => s + w, 0)
    return weights.map((w) => (w / total) * CONTENT_W)
  }

  // Writes one single-line cell: truncates with "..." to the column width
  // and right-aligns numbers by measuring, so text never wraps into the
  // next row.
  const cell = (text: string, x: number, cy: number, width: number, right: boolean) => {
    let t = pdfSafe(text)
    if (doc.widthOfString(t) > width) {
      while (t.length > 1 && doc.widthOfString(`${t}...`) > width) t = t.slice(0, -1)
      t = `${t.trimEnd()}...`
    }
    const tx = right ? x + width - doc.widthOfString(t) : x
    doc.text(t, tx, cy, { lineBreak: false })
  }

  const drawHeader = (cols: ReportColumn[], widths: number[]) => {
    doc.rect(PAGE.m, y, CONTENT_W, HEAD_H).fill(C.ink)
    let x = PAGE.m
    cols.forEach((c, i) => {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
      cell(c.label, x + 7, y + 8, widths[i] - 14, isNumericFormat(c.format))
      x += widths[i]
    })
    y += HEAD_H
  }

  const drawRow = (cols: ReportColumn[], widths: number[], row: ReportRow, index: number, kind: 'row' | 'total' = 'row') => {
    const style = row._style
    if (kind === 'total') {
      doc.rect(PAGE.m, y, CONTENT_W, ROW_H + 2).fill(C.totals)
      doc.moveTo(PAGE.m, y).lineTo(PAGE.m + CONTENT_W, y).lineWidth(0.8).strokeColor(C.ink).stroke()
    } else if (style === 'heading') {
      doc.rect(PAGE.m, y, CONTENT_W, ROW_H).fill(C.card)
    } else if (index % 2 === 1) {
      doc.rect(PAGE.m, y, CONTENT_W, ROW_H).fill(C.zebra)
    }
    if (style === 'subtotal') {
      doc.moveTo(PAGE.m, y).lineTo(PAGE.m + CONTENT_W, y).lineWidth(0.5).strokeColor(C.rule).stroke()
    }
    const bold = kind === 'total' || style === 'heading' || style === 'subtotal'
    const indentCol = cols.findIndex((c) => c.format !== 'code')
    let x = PAGE.m
    cols.forEach((c, i) => {
      const raw = row[c.key]
      const text = formatCell(raw, c.format)
      let color = C.text
      if (c.format === 'status' && typeof raw === 'string') color = STATUS_COLORS[raw] ?? C.accent
      if (c.format === 'code') color = C.ink
      const indent = i === indentCol && style === 'indent' ? 14 : 0
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.3).fillColor(color)
      cell(text, x + 7 + indent, y + 6.5, widths[i] - 14 - indent, isNumericFormat(c.format))
      x += widths[i]
    })
    y += kind === 'total' ? ROW_H + 2 : ROW_H
  }

  const drawTable = (s: TableSection, opts: { headingDrawn: boolean }) => {
    const widths = colWidths(s.columns)
    if (!opts.headingDrawn) {
      ensure(60 + HEAD_H + ROW_H * Math.min(3, Math.max(1, s.rows.length)), s.title)
      sectionHeading(s.title, s.subtitle)
    }
    if (s.rows.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(C.faint).text(s.emptyMessage ?? 'No data for the selected filters', PAGE.m, y + 4)
      y += 26
      return
    }
    drawHeader(s.columns, widths)
    s.rows.forEach((r, i) => {
      if (y + ROW_H > BOTTOM) {
        startPage(s.title, `${s.subtitle ? `${s.subtitle}  |  ` : ''}continued`)
        drawHeader(s.columns, widths)
      }
      drawRow(s.columns, widths, r, i)
    })
    if (s.totals) {
      if (y + ROW_H + 2 > BOTTOM) { startPage(s.title, 'continued'); drawHeader(s.columns, widths) }
      drawRow(s.columns, widths, s.totals, 0, 'total')
    }
    y += 22
  }

  // Register: page-sized chunks, each on its own page with a range subtitle,
  // a PAGE TOTAL row, and the grand-total line (like a printed ledger).
  const drawRegister = (s: TableSection) => {
    const widths = colWidths(s.columns)
    const perPage = REGISTER_PAGE_ROWS
    const total = s.rows.length
    if (total === 0) {
      startPage(s.title, s.subtitle)
      doc.font('Helvetica').fontSize(9).fillColor(C.faint).text(s.emptyMessage ?? 'No data for the selected filters', PAGE.m, y + 4)
      y += 26
      return
    }
    const sumCols = s.columns.filter((c) => c.format === 'money')
    for (let start = 0; start < total; start += perPage) {
      const chunk = s.rows.slice(start, start + perPage)
      const range = `${String(start + 1).padStart(2, '0')}–${String(start + chunk.length).padStart(2, '0')} of ${total}`
      startPage(s.title, `${s.subtitle ? `${s.subtitle}  |  ` : ''}Transactions ${range}`)
      drawHeader(s.columns, widths)
      chunk.forEach((r, i) => drawRow(s.columns, widths, r, i))
      if (sumCols.length > 0 && total > perPage) {
        const pageTotal: ReportRow = { [s.columns[0].key]: 'PAGE TOTAL' }
        for (const c of sumCols) pageTotal[c.key] = round2(chunk.reduce((acc, r) => acc + (Number(r[c.key]) || 0), 0))
        drawRow(s.columns, widths, pageTotal, 0, 'total')
      } else if (s.totals) {
        drawRow(s.columns, widths, s.totals, 0, 'total')
      }
      if (s.totals && sumCols.length > 0) {
        const parts = sumCols.slice(-3).map((c) => `${c.label}: ${formatCell(s.totals![c.key], 'money')}`)
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.accent)
          .text(pdfSafe(`Grand total  —  ${parts.join('   |   ')}`), PAGE.m, y + 14, { width: CONTENT_W, lineBreak: false })
        y += 34
      }
    }
  }

  const drawStats = (s: StatsSection) => {
    ensure(70, s.title)
    sectionHeading(s.title)
    // One continued text run: "Label: value   |   Label: value ..."
    doc.fontSize(10)
    s.items.forEach((it, i) => {
      const last = i === s.items.length - 1
      const value = typeof it.value === 'number' ? it.value.toLocaleString('en-US') : it.value
      const color = it.tone === 'positive' ? C.positive : it.tone === 'negative' ? C.negative : it.tone === 'warning' ? C.warning : C.ink
      const first = i === 0
      doc.font('Helvetica').fillColor(C.text)
      if (first) doc.text(pdfSafe(`${it.label}: `), PAGE.m, y, { continued: true, lineBreak: false })
      else doc.text(pdfSafe(`${it.label}: `), { continued: true, lineBreak: false })
      doc.font('Helvetica-Bold').fillColor(color).text(pdfSafe(value), { continued: !last, lineBreak: false })
      if (!last) doc.font('Helvetica').fillColor(C.faint).text('     |     ', { continued: true, lineBreak: false })
    })
    y += 18
    if (s.note) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(pdfSafe(s.note), PAGE.m, y, { width: CONTENT_W })
      y = doc.y + 6
    }
    y += 16
  }

  const drawNote = (s: NoteSection) => {
    const height = doc.font('Helvetica').fontSize(8.5).heightOfString(pdfSafe(s.text), { width: CONTENT_W * 0.75 })
    ensure(height + 30, s.title)
    doc.font('Helvetica-Bold').fontSize(8).fillColor(s.tone === 'warning' ? C.warning : C.accent)
      .text(pdfSafe(s.title.toUpperCase()), PAGE.m, y, { lineBreak: false, characterSpacing: 0.3 })
    y += 13
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(pdfSafe(s.text), PAGE.m, y, { width: CONTENT_W * 0.75 })
    y = doc.y + 18
  }

  // Page 1: headline, KPIs, then sections in order
  startPage(report.headline, report.summaryLine)
  drawKpis(report.kpis)
  for (const s of report.sections) {
    if (s.type === 'table' && s.register) { drawRegister(s); continue }
    if (s.type === 'table' && s.newPage) {
      startPage(s.title, s.subtitle)
      drawTable(s, { headingDrawn: true })
      continue
    }
    if (s.type === 'table') drawTable(s, { headingDrawn: false })
    else if (s.type === 'stats') drawStats(s)
    else drawNote(s)
  }

  // Footer on every page
  const range = doc.bufferedPageRange()
  const generated = `Generated ${fmtDateShort(report.generatedAt)}`
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const fy = PAGE.h - 40
    doc.moveTo(PAGE.m, fy).lineTo(PAGE.w - PAGE.m, fy).lineWidth(0.5).strokeColor(C.rule).stroke()
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
      .text(pdfSafe(`${report.orgName}  |  ${report.periodLabel}  |  Amounts in ${report.currency}  |  ${generated}`), PAGE.m, fy + 9, { width: CONTENT_W * 0.8, lineBreak: false, height: 10 })
    doc.text(`PAGE ${String(i + 1).padStart(2, '0')} / ${String(range.count).padStart(2, '0')}`, PAGE.m, fy + 9, { width: CONTENT_W, align: 'right', lineBreak: false, height: 10 })
  }
  doc.end()
}

// ── Page plan (shared by Excel and CSV) ─────────────────────────────────────
// Mirrors the PDF's pagination: page 1 = headline + KPIs + following
// sections, every `newPage` table starts a page, and a register is split
// into REGISTER_PAGE_ROWS-row pages with a PAGE TOTAL each.

interface PlannedPage {
  title: string
  subtitle?: string
  kpis?: ReportKpi[]
  blocks: { section: ReportSection; withHeading: boolean }[]
  register?: { section: TableSection; rows: ReportRow[]; start: number; total: number; pageTotal?: ReportRow }
  tabName: string
}

function monthSpan(rows: ReportRow[], cols: ReportColumn[]): string {
  const dateCol = cols.find((c) => c.format === 'date' || c.format === 'datetime')
  if (!dateCol) return ''
  const keys = rows
    .map((r) => new Date(String(r[dateCol.key])))
    .filter((d) => !isNaN(d.getTime()))
    .map((d) => monthKey(d))
  if (keys.length === 0) return ''
  const uniq = [...new Set(keys)].sort().reverse() // newest first, whatever the row order
  const name = (k: string) => monthLabel(k).split(' ')[0]
  const short = (k: string) => name(k).slice(0, 3)
  return uniq.length === 1 ? name(uniq[0]) : `${short(uniq[uniq.length - 1])}-${short(uniq[0])}`
}

// "Supplier summary" -> "Suppliers", "Category summary" -> "Categories"
function tabNameFor(title: string): string {
  const m = title.match(/^(.*) summary$/i)
  if (!m) return title
  const w = m[1]
  return /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /s$/i.test(w) ? w : `${w}s`
}

function planPages(report: ProReport): PlannedPage[] {
  const pages: PlannedPage[] = [{ title: report.headline, subtitle: report.summaryLine, kpis: report.kpis, blocks: [], tabName: 'Overview' }]
  for (const s of report.sections) {
    if (s.type === 'table' && s.register) {
      const total = s.rows.length
      const sumCols = s.columns.filter((c) => c.format === 'money')
      if (total === 0) {
        pages.push({ title: s.title, subtitle: s.subtitle, blocks: [], register: { section: s, rows: [], start: 0, total: 0 }, tabName: 'Register' })
        continue
      }
      for (let start = 0; start < total; start += REGISTER_PAGE_ROWS) {
        const rows = s.rows.slice(start, start + REGISTER_PAGE_ROWS)
        let pageTotal: ReportRow | undefined
        if (sumCols.length > 0 && total > REGISTER_PAGE_ROWS) {
          pageTotal = { [s.columns[0].key]: 'PAGE TOTAL' }
          for (const c of sumCols) pageTotal[c.key] = round2(rows.reduce((acc, r) => acc + (Number(r[c.key]) || 0), 0))
        }
        const range = `${String(start + 1).padStart(2, '0')}–${String(start + rows.length).padStart(2, '0')} of ${total}`
        const span = monthSpan(rows, s.columns)
        pages.push({
          title: s.title,
          subtitle: `${s.subtitle ? `${s.subtitle}  |  ` : ''}Transactions ${range}`,
          blocks: [],
          register: { section: s, rows, start, total, pageTotal },
          tabName: span ? `Register ${span}` : total > REGISTER_PAGE_ROWS ? `Register ${String(start + 1).padStart(2, '0')}-${String(start + rows.length).padStart(2, '0')}` : 'Register',
        })
      }
      continue
    }
    if (s.type === 'table' && s.newPage) {
      pages.push({ title: s.title, subtitle: s.subtitle, blocks: [{ section: s, withHeading: false }], tabName: tabNameFor(s.title) })
      continue
    }
    pages[pages.length - 1].blocks.push({ section: s, withHeading: true })
  }
  // "01 Overview", "02 Suppliers", "03 Register July", ... (Excel's 31-char limit)
  const used = new Set<string>()
  pages.forEach((p, i) => {
    let name = `${String(i + 1).padStart(2, '0')} ${p.tabName}`.replace(/[\\/?*[\]:]/g, '').slice(0, 31)
    while (used.has(name)) name = `${name.slice(0, 28)} ${i}`
    used.add(name)
    p.tabName = name
  })
  return pages
}

// ── Excel ───────────────────────────────────────────────────────────────────
// Report tabs reproduce the PDF pages cell-for-cell (dark band, KPI cards,
// dark table headers, zebra rows, totals, footer with PAGE x / y), then an
// "Editable" sheet holds the register as a real Excel table with SUM totals.

const X = {
  ink: 'FF07131B', text: 'FF1F2933', muted: 'FF5B6B78', faint: 'FF8A99A6', accent: 'FF1D5F7A', amber: 'FFF5B62B',
  card: 'FFEDF2F5', zebra: 'FFF1F5F8', totals: 'FFDCE8EF', white: 'FFFFFFFF', kpiLabelDark: 'FF9FC3D6', kpiHintDark: 'FFD5E3EA',
  positive: 'FF15803D', negative: 'FFB91C1C', warning: 'FFB45309',
}
const XSTATUS: Record<string, string> = {
  paid: X.positive, approved: X.accent, partial: X.warning, void: X.negative, draft: X.faint, submitted: X.accent,
}
const FONT = 'Arial'
const EDITABLE_NAMES: Record<string, string> = {
  purchases: 'Editable purchases', expenses: 'Editable expenses', 'daily-sales': 'Editable sales', 'cash-closing': 'Editable cash closings',
  'supplier-payable': 'Editable open bills', 'inventory-stock': 'Editable stock', wastage: 'Editable wastage', 'branch-sales': 'Editable branch sales',
  'branch-profit': 'Editable branch profit', 'audit-log': 'Editable activity', 'profit-loss': 'Editable profit and loss',
  'trial-balance': 'Editable trial balance', 'balance-sheet': 'Editable balances', 'vat-summary': 'Editable VAT',
}
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
const numFmtFor = (f?: CellFormat) =>
  f === 'money' ? '#,##0.00' : f === 'integer' ? '#,##0' : f === 'number' ? '#,##0.###' : f === 'percent' ? '0.0"%"'
    : f === 'date' ? 'dd mmm yyyy' : f === 'datetime' ? 'dd mmm yyyy hh:mm' : undefined

function excelValue(v: unknown, f?: CellFormat): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null
  if ((f === 'date' || f === 'datetime') && typeof v === 'string') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? v : d
  }
  if (f === 'status' && typeof v === 'string') return humanizeStatus(v)
  if (typeof v === 'number' && f === 'money') return round2(v)
  return v as ExcelJS.CellValue
}

async function renderExcel(res: Response, report: ProReport, fileBase: string) {
  const wb = new ExcelJS.Workbook()
  wb.creator = report.orgName
  wb.created = new Date()
  wb.title = report.headline

  const pages = planPages(report)
  const footerText = `${report.orgName}  |  ${report.periodLabel}  |  Amounts in ${report.currency}  |  Generated ${fmtDateShort(report.generatedAt)}`

  pages.forEach((page, pageIndex) => {
    const ws = wb.addWorksheet(page.tabName, {
      properties: { tabColor: { argb: 'FF17536B' } },
      views: [{ showGridLines: false }],
      pageSetup: {
        paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
        margins: { left: 0.3, right: 0.3, top: 0.35, bottom: 0.35, header: 0.2, footer: 0.2 },
      },
    })

    // Grid: column A is a margin; the widest table on the page sets the columns
    const tables: TableSection[] = [
      ...page.blocks.map((b) => b.section).filter((s): s is TableSection => s.type === 'table'),
      ...(page.register ? [page.register.section] : []),
    ]
    const widest = tables.reduce<TableSection | undefined>((w, t) => (!w || t.columns.length > w.columns.length ? t : w), undefined)
    const gridCols = Math.max(6, widest?.columns.length ?? 0)
    const C0 = 2
    const lastCol = C0 + gridCols - 1
    ws.getColumn(1).width = 2.5
    const weights = widest
      ? widest.columns.map((c) => c.width ?? (c.format === 'money' ? 1.25 : c.format === 'date' ? 1.05 : c.format === 'status' ? 0.9
        : c.format === 'integer' || c.format === 'number' || c.format === 'percent' ? 0.8 : c.format === 'code' ? 1.35 : 1.9))
      : []
    while (weights.length < gridCols) weights.push(1.2)
    const wsum = weights.reduce((s, w) => s + w, 0)
    weights.forEach((w, i) => { ws.getColumn(C0 + i).width = Math.max(10, Math.round((w / wsum) * 150)) })

    let r = 1
    const setRow = (height: number) => { ws.getRow(r).height = height }
    const write = (row: number, c1: number, c2: number, value: ExcelJS.CellValue, font: Partial<ExcelJS.Font>, opts: { fill?: string; align?: 'left' | 'right' | 'center'; wrap?: boolean; numFmt?: string } = {}) => {
      if (c2 > c1) ws.mergeCells(row, c1, row, c2)
      const cell = ws.getCell(row, c1)
      cell.value = value
      cell.font = { name: FONT, ...font }
      cell.alignment = { vertical: 'middle', horizontal: opts.align ?? 'left', wrapText: !!opts.wrap, indent: opts.align === 'right' ? 0 : 1 }
      if (opts.numFmt) cell.numFmt = opts.numFmt
      if (opts.fill) for (let c = c1; c <= c2; c++) ws.getCell(row, c).fill = solid(opts.fill)
    }

    // Top band + page header
    setRow(6)
    for (let c = 1; c <= lastCol + 1; c++) ws.getCell(r, c).fill = solid(X.ink)
    r += 2
    setRow(18)
    const half = C0 + Math.floor(gridCols / 2)
    write(r, C0, half - 1, report.eyebrow.toUpperCase(), { bold: true, size: 9, color: { argb: X.accent } })
    write(r, half, lastCol, `${report.orgName.toUpperCase()}  /  ${report.scopeLabel.toUpperCase()}`, { size: 8, color: { argb: X.muted } }, { align: 'right' })
    r++
    setRow(36)
    write(r, C0, lastCol, page.title, { bold: true, size: 22, color: { argb: X.ink } })
    r++
    if (page.subtitle) {
      setRow(18)
      write(r, C0, lastCol, page.subtitle, { size: 9.5, color: { argb: X.muted } })
      r++
    }
    r++

    // KPI cards
    if (page.kpis && page.kpis.length > 0) {
      const n = page.kpis.length
      const base = Math.floor(gridCols / n)
      let extra = gridCols - base * n
      let c = C0
      const [rl, rv, rh] = [r, r + 1, r + 2]
      ws.getRow(rl).height = 24
      ws.getRow(rv).height = 34
      ws.getRow(rh).height = 22
      for (const k of page.kpis) {
        const span = base + (extra-- > 0 ? 1 : 0)
        const c2 = c + span - 1
        const dark = k.tone === 'dark'
        const fill = dark ? X.ink : X.card
        const valueColor = dark ? X.amber : k.tone === 'positive' ? X.positive : k.tone === 'negative' ? X.negative : k.tone === 'warning' ? X.warning : X.ink
        const numeric = typeof k.value === 'number'
        const fmt = k.format ?? 'money'
        write(rl, c, c2, k.label.toUpperCase(), { bold: true, size: 8, color: { argb: dark ? X.kpiLabelDark : X.muted } }, { fill })
        write(rv, c, c2, numeric && fmt !== 'text' ? (k.value as number) : String(k.value), { bold: true, size: 20, color: { argb: valueColor } },
          { fill, numFmt: numeric ? numFmtFor(fmt) : undefined })
        write(rh, c, c2, k.hint ?? '', { size: 8.5, color: { argb: dark ? X.kpiHintDark : X.muted } }, { fill })
        // white gutter between cards
        for (const row of [rl, rv, rh]) {
          ws.getCell(row, c).border = { left: { style: 'thick', color: { argb: X.white } } }
          ws.getCell(row, c2).border = { ...(c === c2 ? ws.getCell(row, c).border : {}), right: { style: 'thick', color: { argb: X.white } } }
        }
        c = c2 + 1
      }
      r = rh + 2
    }

    const tableHeader = (cols: ReportColumn[]) => {
      setRow(24)
      cols.forEach((col, i) => {
        const numeric = isNumericFormat(col.format)
        write(r, C0 + i, C0 + i, col.label, { bold: true, size: 9, color: { argb: X.white } }, { fill: X.ink, align: numeric ? 'right' : 'left' })
      })
      r++
    }
    const tableRow = (cols: ReportColumn[], row: ReportRow, i: number, kind: 'row' | 'total' = 'row') => {
      const style = row._style
      const fill = kind === 'total' ? X.totals : style === 'heading' ? X.card : i % 2 === 1 ? X.zebra : undefined
      const bold = kind === 'total' || style === 'heading' || style === 'subtotal'
      const indentCol = cols.findIndex((c) => c.format !== 'code')
      setRow(kind === 'total' ? 22 : 20)
      cols.forEach((col, ci) => {
        const raw = row[col.key]
        const numeric = isNumericFormat(col.format)
        const color = col.format === 'status' && typeof raw === 'string' ? XSTATUS[raw] ?? X.accent
          : typeof raw === 'number' && raw < -0.005 && col.format === 'money' ? X.negative : X.text
        write(r, C0 + ci, C0 + ci, excelValue(raw, col.format), { bold, size: 9, color: { argb: color } },
          { fill, align: numeric ? 'right' : 'left', numFmt: numFmtFor(col.format) })
        const cell = ws.getCell(r, C0 + ci)
        if (ci === indentCol && style === 'indent') cell.alignment = { ...cell.alignment, indent: 3 }
        if (kind === 'total') cell.border = { top: { style: 'thin', color: { argb: X.ink } } }
        else if (style === 'subtotal') cell.border = { top: { style: 'thin', color: { argb: 'FFCFDBE3' } } }
      })
      r++
    }
    const sectionHeading = (title: string, subtitle?: string) => {
      setRow(24)
      write(r, C0, lastCol, title, { bold: true, size: 13, color: { argb: X.ink } })
      r++
      if (subtitle) {
        setRow(16)
        write(r, C0, lastCol, subtitle, { size: 9, color: { argb: X.muted } })
        r++
      }
    }

    for (const { section: s, withHeading } of page.blocks) {
      if (s.type === 'table') {
        if (withHeading) sectionHeading(s.title, s.subtitle)
        if (s.rows.length === 0) {
          write(r, C0, lastCol, s.emptyMessage ?? 'No data for the selected filters', { size: 9.5, italic: true, color: { argb: X.faint } })
          r += 2
          continue
        }
        tableHeader(s.columns)
        s.rows.forEach((row, i) => tableRow(s.columns, row, i))
        if (s.totals) tableRow(s.columns, s.totals, 0, 'total')
        r++
      } else if (s.type === 'stats') {
        sectionHeading(s.title)
        setRow(20)
        const rich: ExcelJS.RichText[] = []
        s.items.forEach((it, i) => {
          const color = it.tone === 'positive' ? X.positive : it.tone === 'negative' ? X.negative : it.tone === 'warning' ? X.warning : X.ink
          rich.push({ text: `${it.label}: `, font: { name: FONT, size: 10.5, color: { argb: X.text } } })
          rich.push({ text: typeof it.value === 'number' ? it.value.toLocaleString('en-US') : String(it.value), font: { name: FONT, size: 10.5, bold: true, color: { argb: color } } })
          if (i < s.items.length - 1) rich.push({ text: '     |     ', font: { name: FONT, size: 10.5, color: { argb: X.faint } } })
        })
        write(r, C0, lastCol, { richText: rich }, {})
        r++
        if (s.note) {
          setRow(18)
          write(r, C0, lastCol, s.note, { size: 9, color: { argb: X.muted } })
          r++
        }
        r++
      } else {
        setRow(16)
        write(r, C0, lastCol, s.title.toUpperCase(), { bold: true, size: 8.5, color: { argb: s.tone === 'warning' ? X.warning : X.accent } })
        r++
        setRow(Math.min(90, 15 * Math.ceil(s.text.length / 150) + 4))
        write(r, C0, lastCol, s.text, { size: 9, color: { argb: X.muted } }, { wrap: true })
        ws.getCell(r, C0).alignment = { vertical: 'top', wrapText: true, indent: 1 }
        r += 2
      }
    }

    if (page.register) {
      const { section: s, rows, pageTotal } = page.register
      if (rows.length === 0) {
        write(r, C0, lastCol, s.emptyMessage ?? 'No data for the selected filters', { size: 9.5, italic: true, color: { argb: X.faint } })
        r += 2
      } else {
        tableHeader(s.columns)
        rows.forEach((row, i) => tableRow(s.columns, row, i))
        if (pageTotal) tableRow(s.columns, pageTotal, 0, 'total')
        else if (s.totals) tableRow(s.columns, s.totals, 0, 'total')
        const sumCols = s.columns.filter((c) => c.format === 'money')
        if (s.totals && sumCols.length > 0) {
          r++
          setRow(20)
          const parts = sumCols.slice(-3).map((c) => `${c.label}: ${formatCell(s.totals![c.key], 'money')}`)
          write(r, C0, lastCol, `Grand total  —  ${parts.join('   |   ')}`, { bold: true, size: 10, color: { argb: X.accent } })
          r++
        }
        r++
      }
    }

    // Footer
    r++
    for (let c = C0; c <= lastCol; c++) ws.getCell(r, c).border = { top: { style: 'thin', color: { argb: 'FFCFDBE3' } } }
    setRow(18)
    const split = C0 + Math.max(1, gridCols - 2)
    write(r, C0, split - 1, footerText, { size: 8, color: { argb: X.muted } })
    write(r, split, lastCol, `PAGE ${String(pageIndex + 1).padStart(2, '0')} / ${String(pages.length).padStart(2, '0')}`, { size: 8, color: { argb: X.muted } }, { align: 'right' })
    ws.pageSetup.printArea = `A1:${ws.getColumn(lastCol + 1).letter}${r}`
  })

  // Editable data sheet — the register as an Excel table with SUM totals
  const tables = report.sections.filter((s): s is TableSection => s.type === 'table')
  const data = tables.find((t) => t.primary) ?? tables.find((t) => t.register) ?? tables[0]
  if (data) {
    const editableName = report.editableName ?? EDITABLE_NAMES[report.key] ?? 'Editable data'
    const ws = wb.addWorksheet(editableName.slice(0, 31), {
      properties: { tabColor: { argb: 'FF96C8D7' } },
      views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    })
    const cols = data.columns.filter((c) => !c.key.startsWith('_'))
    cols.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.format === 'money' ? 19 : c.format === 'date' ? 16 : c.format === 'status' ? 14 : isNumericFormat(c.format) ? 14
        : Math.max(18, Math.min(40, Math.round((c.width ?? 1.6) * 14)))
    })
    const font = (extra: Partial<ExcelJS.Font> = {}) => ({ name: FONT, size: 11, color: { argb: 'FF041219' }, ...extra })
    ws.getRow(1).height = 24
    ws.getCell('A1').value = editableName
    ws.getCell('A1').font = font({ bold: true, size: 17 })
    ws.getCell('A2').value = 'The report tabs are a formatted copy of the PDF as generated. They do not update when these data cells change — the TOTAL row below does.'
    ws.getCell('A3').value = `Source: ${report.orgName}  ·  ${report.scopeLabel}  ·  ${report.periodLabel}  ·  Amounts in ${report.currency}  ·  ${data.rows.length.toLocaleString('en-US')} rows  ·  Generated ${fmtDateShort(report.generatedAt)}`
    for (const a of ['A2', 'A3']) ws.getCell(a).font = font({ color: { argb: X.muted } })
    ws.getRow(5).height = 30

    if (data.rows.length > 0) {
      const tableName = `${report.key.replace(/[^A-Za-z0-9]/g, '')}Data`.replace(/^\d/, 'T$&')
      ws.addTable({
        name: tableName,
        ref: 'A5',
        headerRow: true,
        totalsRow: false,
        style: { theme: 'TableStyleMedium2', showRowStripes: true },
        columns: cols.map((c) => ({ name: c.label, filterButton: true })),
        rows: data.rows.map((row) => cols.map((c) => excelValue(row[c.key], c.format))),
      })
      ws.getRow(5).eachCell((cell) => {
        cell.fill = solid('FF041219')
        cell.font = font({ bold: true, color: { argb: 'FFF4F7F8' } })
        cell.alignment = { vertical: 'middle' }
      })
      cols.forEach((c, i) => {
        const fmt = numFmtFor(c.format)
        for (let rr = 6; rr < 6 + data.rows.length; rr++) {
          const cell = ws.getCell(rr, i + 1)
          cell.font = font()
          if (fmt) cell.numFmt = fmt
        }
      })
      // TOTAL row (one blank row below the table, like the sample) with live SUMs
      const first = 6
      const last = 5 + data.rows.length
      const tr = last + 2
      ws.getRow(tr).height = 24
      cols.forEach((c, i) => {
        const cell = ws.getCell(tr, i + 1)
        cell.fill = solid('FFDCEAF0')
        cell.font = font({ bold: true })
        if (i === 0) cell.value = 'TOTAL'
        else if (c.format === 'money' || c.format === 'integer') {
          const L = ws.getColumn(i + 1).letter
          const result = round2(data.rows.reduce((s, row) => s + (Number(row[c.key]) || 0), 0))
          cell.value = { formula: `SUM(${L}${first}:${L}${last})`, result }
          cell.numFmt = numFmtFor(c.format) ?? '#,##0.00'
        }
      })
    } else {
      ws.getCell('A5').value = data.emptyMessage ?? 'No data for the selected filters'
      ws.getCell('A5').font = font({ italic: true, color: { argb: X.faint } })
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// Same content and order as the PDF: header, KPIs, each section, then the
// register page by page (PAGE TOTAL rows) and the grand total. Amounts are
// plain numbers so the file re-opens cleanly in Excel.

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csvCell(v: unknown, f?: CellFormat): string {
  if (v === null || v === undefined || v === '') return ''
  if (typeof v === 'number') return f === 'money' ? round2(v).toFixed(2) : f === 'percent' ? `${v.toFixed(1)}%` : String(v)
  if (f === 'date' || f === 'datetime' || f === 'status') return formatCell(v, f)
  return String(v)
}

function renderCsv(res: Response, report: ProReport, fileBase: string) {
  const lines: string[] = []
  const line = (...cells: unknown[]) => lines.push(cells.map(csvEscape).join(','))
  const table = (cols: ReportColumn[], rows: ReportRow[], totals?: ReportRow) => {
    line(...cols.map((c) => c.label))
    for (const r of rows) line(...cols.map((c) => csvCell(r[c.key], c.format)))
    if (totals) line(...cols.map((c) => csvCell(totals[c.key], c.format)))
  }

  const pages = planPages(report)
  pages.forEach((page, i) => {
    if (i > 0) line()
    line(report.eyebrow.toUpperCase(), `${report.orgName} / ${report.scopeLabel}`, `PAGE ${String(i + 1).padStart(2, '0')} / ${String(pages.length).padStart(2, '0')}`)
    line(page.title)
    if (page.subtitle) line(page.subtitle)
    if (page.kpis?.length) {
      line()
      for (const k of page.kpis) line(k.label, typeof k.value === 'number' ? csvCell(k.value, k.format ?? 'money') : k.value, k.hint ?? '')
    }
    for (const { section: s, withHeading } of page.blocks) {
      line()
      if (s.type === 'table') {
        if (withHeading) { line(s.title); if (s.subtitle) line(s.subtitle) }
        if (s.rows.length === 0) line(s.emptyMessage ?? 'No data for the selected filters')
        else table(s.columns, s.rows, s.totals)
      } else if (s.type === 'stats') {
        line(s.title)
        line(...s.items.map((it) => `${it.label}: ${typeof it.value === 'number' ? it.value.toLocaleString('en-US') : it.value}`))
        if (s.note) line(s.note)
      } else {
        line(s.title.toUpperCase())
        line(s.text)
      }
    }
    if (page.register) {
      const { section: s, rows, pageTotal } = page.register
      line()
      if (rows.length === 0) line(s.emptyMessage ?? 'No data for the selected filters')
      else table(s.columns, rows, pageTotal ?? s.totals)
      const sumCols = s.columns.filter((c) => c.format === 'money')
      if (rows.length > 0 && s.totals && sumCols.length > 0) {
        line(`Grand total — ${sumCols.slice(-3).map((c) => `${c.label}: ${formatCell(s.totals![c.key], 'money')}`).join(' | ')}`)
      }
    }
  })
  line()
  line(`${report.orgName} | ${report.periodLabel} | Amounts in ${report.currency} | Generated ${fmtDateShort(report.generatedAt)}`)

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`)
  res.send('﻿' + lines.join('\r\n'))
}
