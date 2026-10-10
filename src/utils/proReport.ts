import { Response } from 'express'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'
import { PrismaClient } from '@prisma/client'

// Shared report model for every report on the Reports page. A report is
// described once (summary figures + ordered sections) and rendered four ways
// in one Xero-style layout: the JSON the Reports page draws, a PDF, an Excel
// workbook and CSV. The layout follows Xero's reports: centred title block
// (report name, organisation, period), plain column headings over a rule,
// bold section headings, "Total …" lines with a rule above, and the final
// figure of a statement double-underlined. No colour fills or cards.

export type CellFormat = 'text' | 'money' | 'number' | 'integer' | 'date' | 'datetime' | 'status' | 'percent' | 'code'

export interface ReportColumn {
  key: string
  label: string
  format?: CellFormat
  width?: number // relative weight in the PDF
}

// heading  — bold group heading ("Trading Income"), no figures
// indent   — an account / detail line inside a group
// subtotal — bold "Total …" line with a rule above
// grand    — the statement's final figure: rule above, double rule below
export type RowStyle = 'heading' | 'subtotal' | 'indent' | 'grand'
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
  totals?: ReportRow // drawn as the grand total line
  newPage?: boolean // legacy; sections flow continuously like Xero's
  register?: boolean // long transaction list: searchable/paged on screen
  primary?: boolean // the table CSV-only consumers care about most
  hideTitle?: boolean // statements whose single table needs no heading
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
  title?: string // report name in the title block; defaults to eyebrow
  eyebrow: string
  headline: string
  summaryLine: string
  orgName: string
  scopeLabel: string // branch name or "All branches"
  periodLabel: string
  dateLine?: string // "For the period 1 September 2026 to 30 September 2026" / "As at 30 September 2026"
  currency: string
  generatedAt: string
  kpis: ReportKpi[] // shown as the "Summary" block; leave empty for statements
  sections: ReportSection[]
  orientation?: 'portrait' | 'landscape' // PDF; chosen from the widest table when omitted
  editableName?: string
}

// ── Formatting ──────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function fmtMoney(n: number): string {
  const v = Math.abs(n) < 0.005 ? 0 : n
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const toDate = (d: Date | string) => (typeof d === 'string' ? new Date(d) : d)

export function fmtDateShort(d: Date | string): string {
  const date = toDate(d)
  if (isNaN(date.getTime())) return String(d)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

export function fmtDateLong(d: Date | string): string {
  const date = toDate(d)
  if (isNaN(date.getTime())) return String(d)
  return `${date.getUTCDate()} ${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}`
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
const kpiText = (k: ReportKpi) => (typeof k.value === 'number' ? formatCell(k.value, k.format ?? 'money') : k.value)
const statText = (v: number | string) => (typeof v === 'number' ? v.toLocaleString('en-US') : v)
const reportTitle = (r: ProReport) => r.title ?? r.eyebrow
const branchLine = (r: ProReport) => (r.scopeLabel && r.scopeLabel !== 'All branches' ? `Branch: ${r.scopeLabel}` : '')

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

// Xero's period line under the report title
export function dateLineFor(fromDate?: string, toDate?: string, dates: Date[] = []): string {
  if (fromDate) return `For the period ${fmtDateLong(fromDate)} to ${fmtDateLong(toDate || new Date())}`
  if (toDate) return `For the period ending ${fmtDateLong(toDate)}`
  if (dates.length === 0) return 'For all dates'
  const ms = dates.map((d) => d.getTime())
  return `For the period ${fmtDateLong(new Date(Math.min(...ms)))} to ${fmtDateLong(new Date(Math.max(...ms)))}`
}

export const asAtLine = (d: Date | string = new Date()) => `As at ${fmtDateLong(d)}`

// Short column heading for a statement's amount column: "Sep 2026",
// "1 Jan – 30 Sep 2026", or "Amount"
export function periodColumnLabel(fromDate?: string, toDate?: string): string {
  if (!fromDate && !toDate) return 'Amount'
  const f = fromDate ? new Date(fromDate) : null
  const t = toDate ? new Date(toDate) : new Date()
  if (!f) return `To ${fmtDateShort(t)}`
  const monthEnd = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  if (f.getUTCDate() === 1 && f.getUTCFullYear() === t.getUTCFullYear() && f.getUTCMonth() === t.getUTCMonth() && t.getUTCDate() === monthEnd) {
    return `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`
  }
  const sameYear = f.getUTCFullYear() === t.getUTCFullYear()
  return `${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]}${sameYear ? '' : ` ${f.getUTCFullYear()}`} – ${fmtDateShort(t)}`
}

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : pluralWord}`

// ── Dispatcher ──────────────────────────────────────────────────────────────

export async function sendProReport(res: Response, format: string | undefined, report: ProReport, legacy: Record<string, unknown> = {}): Promise<void> {
  const fileBase = `${report.key}-${new Date().toISOString().slice(0, 10)}`
  if (format === 'pdf') return renderPdf(res, report, fileBase)
  if (format === 'excel') return renderExcel(res, report, fileBase)
  if (format === 'csv') return renderCsv(res, report, fileBase)
  res.json({ ...legacy, report: { ...report, title: reportTitle(report), dateLine: report.dateLine ?? `For the period ${report.periodLabel}` } })
}

const tablesOf = (r: ProReport) => r.sections.filter((s): s is TableSection => s.type === 'table')
// The title block names the report; a section title that just repeats it is dropped
const showSectionTitle = (r: ProReport, s: TableSection) =>
  !s.hideTitle && !(r.sections.length === 1 && r.kpis.length === 0)

// ── PDF ─────────────────────────────────────────────────────────────────────

const P = { ink: '#1a1a1a', text: '#222222', muted: '#6b6b6b', rule: '#1a1a1a', hair: '#e2e2e2' }

// The built-in Helvetica font is WinAnsi-encoded: swap characters it can't
// draw for close equivalents instead of letting them render as junk.
const pdfSafe = (t: string) => t.replace(/−/g, '-').replace(/≠/g, '<>').replace(/[←-⇿]/g, '>').replace(/…/g, '...').replace(/÷/g, '/')

const ROW_H = 16
const HEADING_H = 21
const HEAD_H = 19

const defaultWeight = (c: ReportColumn) => c.width ?? (c.format === 'money' ? 1.25 : c.format === 'date' ? 1.05 : c.format === 'datetime' ? 1.35
  : c.format === 'status' ? 0.9 : c.format === 'integer' || c.format === 'number' || c.format === 'percent' ? 0.8 : c.format === 'code' ? 1.2 : 1.9)

function renderPdf(res: Response, report: ProReport, fileBase: string) {
  const widest = Math.max(0, ...tablesOf(report).map((t) => t.columns.length))
  const landscape = (report.orientation ?? (widest > 6 ? 'landscape' : 'portrait')) === 'landscape'
  const W = landscape ? 841.89 : 595.28
  const H = landscape ? 595.28 : 841.89
  const M = 40
  const CW = W - M * 2
  const BOTTOM = H - 46
  const title = reportTitle(report)

  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`)
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: M, bufferPages: true, info: { Title: title, Author: report.orgName } })
  doc.pipe(res)

  let y = M
  const newPage = () => { doc.addPage(); y = M }
  const ensure = (needed: number) => { if (y + needed > BOTTOM) newPage() }

  // Single-line cell: truncated with "..." to fit, numbers right-aligned
  const cell = (text: string, x: number, cy: number, width: number, right: boolean) => {
    let t = pdfSafe(text)
    if (doc.widthOfString(t) > width) {
      while (t.length > 1 && doc.widthOfString(`${t}...`) > width) t = t.slice(0, -1)
      t = `${t.trimEnd()}...`
    }
    doc.text(t, right ? x + width - doc.widthOfString(t) : x, cy, { lineBreak: false })
  }
  const hline = (x1: number, x2: number, ly: number, width: number, color: string) =>
    doc.moveTo(x1, ly).lineTo(x2, ly).lineWidth(width).strokeColor(color).stroke()

  // Title block (first page only), centred like Xero
  const centred = (text: string, font: string, size: number, color: string, gap: number) => {
    doc.font(font).fontSize(size).fillColor(color).text(pdfSafe(text), M, y, { width: CW, align: 'center', lineBreak: false })
    y += gap
  }
  centred(title, 'Helvetica-Bold', 16, P.ink, 22)
  centred(report.orgName, 'Helvetica', 10.5, P.text, 15)
  centred(report.dateLine ?? `For the period ${report.periodLabel}`, 'Helvetica', 10, P.text, 14)
  if (branchLine(report)) centred(branchLine(report), 'Helvetica', 9, P.muted, 13)
  y += 14

  const sectionTitle = (t: string, sub?: string) => {
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(P.ink).text(pdfSafe(t), M, y, { lineBreak: false })
    y += 15
    if (sub) {
      doc.font('Helvetica').fontSize(8).fillColor(P.muted).text(pdfSafe(sub), M, y, { width: CW, lineBreak: false })
      y += 12
    }
    y += 3
  }

  // Label / value list — the report summary and status counts
  const keyValues = (heading: string | undefined, items: { label: string; value: string; hint?: string }[]) => {
    if (items.length === 0) return
    ensure(30 + Math.min(items.length, 4) * ROW_H)
    if (heading) sectionTitle(heading)
    const valueW = Math.min(170, CW * 0.3)
    const labelW = CW * 0.38
    hline(M, M + CW, y, 0.8, P.rule)
    for (const it of items) {
      ensure(ROW_H)
      doc.font('Helvetica').fontSize(8.6).fillColor(P.text)
      cell(it.label, M + 2, y + 4.5, labelW - 6, false)
      if (it.hint) { doc.fontSize(8).fillColor(P.muted); cell(it.hint, M + labelW, y + 4.8, CW - labelW - valueW - 8, false) }
      doc.font('Helvetica-Bold').fontSize(8.6).fillColor(P.ink)
      cell(it.value, M + CW - valueW, y + 4.5, valueW - 2, true)
      y += ROW_H
      hline(M, M + CW, y, 0.4, P.hair)
    }
    y += 20
  }

  const colWidths = (cols: ReportColumn[]) => {
    const weights = cols.map(defaultWeight)
    const total = weights.reduce((s, w) => s + w, 0)
    return weights.map((w) => (w / total) * CW)
  }

  const drawHeader = (cols: ReportColumn[], widths: number[]) => {
    let x = M
    doc.font('Helvetica-Bold').fontSize(8).fillColor(P.ink)
    cols.forEach((c, i) => { cell(c.label, x + 4, y + 6, widths[i] - 8, isNumericFormat(c.format)); x += widths[i] })
    y += HEAD_H
    hline(M, M + CW, y, 0.8, P.rule)
  }

  const drawRow = (cols: ReportColumn[], widths: number[], row: ReportRow, style: RowStyle | undefined) => {
    const h = style === 'heading' ? HEADING_H : ROW_H
    const bold = style === 'heading' || style === 'subtotal' || style === 'grand'
    if (style === 'subtotal' || style === 'grand') hline(M, M + CW, y, 0.7, P.rule)
    const textY = style === 'heading' ? y + 9 : y + 4.5
    const labelCol = cols.findIndex((c) => !isNumericFormat(c.format) && c.format !== 'code' && c.format !== 'date')
    let x = M
    cols.forEach((c, i) => {
      const text = formatCell(row[c.key], c.format)
      const indent = style === 'indent' && i === Math.max(0, labelCol) ? 10 : 0
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(style === 'heading' ? 8.8 : 8.4).fillColor(bold ? P.ink : P.text)
      cell(text, x + 4 + indent, textY, widths[i] - 8 - indent, isNumericFormat(c.format))
      x += widths[i]
    })
    y += h
    if (style === 'grand') {
      hline(M, M + CW, y, 0.7, P.rule)
      hline(M, M + CW, y + 2, 0.7, P.rule)
      y += 4
    } else if (!style || style === 'indent') {
      hline(M, M + CW, y, 0.35, P.hair)
    } else if (style === 'subtotal') {
      y += 4
    }
  }

  const drawTable = (s: TableSection) => {
    const widths = colWidths(s.columns)
    ensure(40 + HEAD_H + ROW_H * Math.min(3, Math.max(1, s.rows.length)))
    if (showSectionTitle(report, s)) sectionTitle(s.title, s.subtitle)
    if (s.rows.length === 0) {
      doc.font('Helvetica').fontSize(8.6).fillColor(P.muted).text(pdfSafe(s.emptyMessage ?? 'No data for the selected filters'), M, y + 2)
      y += 26
      return
    }
    drawHeader(s.columns, widths)
    const rows: { row: ReportRow; style?: RowStyle }[] = [
      ...s.rows.map((row) => ({ row, style: row._style })),
      ...(s.totals ? [{ row: s.totals, style: 'grand' as const }] : []),
    ]
    rows.forEach(({ row, style }) => {
      const h = (style === 'heading' ? HEADING_H : ROW_H) + (style === 'grand' ? 4 : 0)
      if (y + h > BOTTOM) { newPage(); drawHeader(s.columns, widths) }
      drawRow(s.columns, widths, row, style)
    })
    y += 22
  }

  const drawNote = (s: NoteSection) => {
    const text = pdfSafe(s.text)
    const height = doc.font('Helvetica').fontSize(8.4).heightOfString(text, { width: CW })
    ensure(height + 26)
    if (s.title) {
      doc.font('Helvetica-Bold').fontSize(8.8).fillColor(P.ink).text(pdfSafe(s.title), M, y, { lineBreak: false })
      y += 13
    }
    doc.font('Helvetica').fontSize(8.4).fillColor(s.tone === 'warning' ? '#8a4b00' : P.muted).text(text, M, y, { width: CW })
    y = doc.y + 14
  }

  keyValues(report.sections.length ? 'Summary' : undefined, report.kpis.map((k) => ({ label: k.label, value: kpiText(k), hint: k.hint })))
  for (const s of report.sections) {
    if (s.type === 'table') drawTable(s)
    else if (s.type === 'stats') {
      keyValues(s.title, s.items.map((it) => ({ label: it.label, value: statText(it.value) })))
      if (s.note) drawNote({ type: 'note', id: `${s.id}-note`, title: '', text: s.note })
    } else drawNote(s)
  }

  // Footer on every page: report | organisation  ...  Page x of y
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const fy = H - 30
    doc.font('Helvetica').fontSize(7.5).fillColor(P.muted)
      .text(pdfSafe(`${title}  |  ${report.orgName}  |  Generated ${fmtDateShort(report.generatedAt)}`), M, fy, { width: CW * 0.75, lineBreak: false, height: 10 })
    doc.text(`Page ${i + 1} of ${range.count}`, M, fy, { width: CW, align: 'right', lineBreak: false, height: 10 })
  }
  doc.end()
}

// ── Excel ───────────────────────────────────────────────────────────────────
// One worksheet laid out like the PDF: title block, summary, then each table
// with real numbers (number formats, not text) so the export can be worked on.

const FONT = 'Arial'
const BLACK = 'FF1A1A1A'
const MUTED = 'FF6B6B6B'
const numFmtFor = (f?: CellFormat) =>
  f === 'money' ? '#,##0.00;-#,##0.00' : f === 'integer' ? '#,##0' : f === 'number' ? '#,##0.###' : f === 'percent' ? '0.0"%"'
    : f === 'date' ? 'd mmm yyyy' : f === 'datetime' ? 'd mmm yyyy hh:mm' : undefined

function excelValue(v: unknown, f?: CellFormat): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null
  if ((f === 'date' || f === 'datetime') && typeof v === 'string') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? v : d
  }
  if (f === 'status' && typeof v === 'string') return humanizeStatus(v)
  if (typeof v === 'number' && f === 'money') return round2(v)
  if (f === 'code' && typeof v === 'number') return String(v)
  return v as ExcelJS.CellValue
}

async function renderExcel(res: Response, report: ProReport, fileBase: string) {
  const title = reportTitle(report)
  const wb = new ExcelJS.Workbook()
  wb.creator = report.orgName
  wb.created = new Date()
  wb.title = title

  const tables = tablesOf(report)
  const widest = Math.max(0, ...tables.map((t) => t.columns.length))
  const lastCol = Math.max(3, widest)
  const ws = wb.addWorksheet(title.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Report', {
    views: [{ showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation: widest > 6 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      horizontalCentered: true, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L${title} | ${report.orgName}&RPage &P of &N` },
  })

  // Column widths sized to the content of every table that uses the column
  const widths: number[] = Array.from({ length: lastCol }, (_, i) => (i === 0 ? 30 : 14))
  for (const t of tables) {
    t.columns.forEach((c, i) => {
      const longest = Math.max(c.label.length, ...[...t.rows, ...(t.totals ? [t.totals] : [])].slice(0, 2000).map((r) => formatCell(r[c.key], c.format).length))
      widths[i] = Math.max(widths[i], Math.min(55, longest + 3))
    })
  }
  if (report.kpis.length) widths[0] = Math.max(widths[0], Math.min(40, Math.max(...report.kpis.map((k) => k.label.length)) + 3))
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w })

  let r = 1
  const font = (extra: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 10, color: { argb: BLACK }, ...extra })
  const merged = (text: string, f: Partial<ExcelJS.Font>, height: number) => {
    ws.mergeCells(r, 1, r, lastCol)
    const c = ws.getCell(r, 1)
    c.value = text
    c.font = font(f)
    c.alignment = { horizontal: 'center', vertical: 'middle' }
    ws.getRow(r).height = height
    r++
  }

  merged(title, { bold: true, size: 15 }, 24)
  merged(report.orgName, { size: 11 }, 17)
  merged(report.dateLine ?? `For the period ${report.periodLabel}`, { size: 10 }, 16)
  if (branchLine(report)) merged(branchLine(report), { size: 9, color: { argb: MUTED } }, 15)
  r++

  const sectionTitle = (t: string, sub?: string) => {
    ws.getCell(r, 1).value = t
    ws.getCell(r, 1).font = font({ bold: true, size: 11 })
    ws.getRow(r).height = 18
    r++
    if (sub) {
      ws.getCell(r, 1).value = sub
      ws.getCell(r, 1).font = font({ size: 9, color: { argb: MUTED } })
      r++
    }
  }

  const keyValues = (heading: string | undefined, items: { label: string; value: ExcelJS.CellValue; numFmt?: string; hint?: string }[]) => {
    if (items.length === 0) return
    if (heading) sectionTitle(heading)
    for (let c = 1; c <= lastCol; c++) ws.getCell(r - 1, c).border = { bottom: { style: 'thin', color: { argb: BLACK } } }
    for (const it of items) {
      ws.getCell(r, 1).value = it.label
      ws.getCell(r, 1).font = font()
      if (it.hint && lastCol > 2) {
        ws.mergeCells(r, 2, r, lastCol - 1)
        ws.getCell(r, 2).value = it.hint
        ws.getCell(r, 2).font = font({ size: 9, color: { argb: MUTED } })
      }
      const v = ws.getCell(r, lastCol)
      v.value = it.value
      v.font = font({ bold: true })
      v.alignment = { horizontal: 'right' }
      if (it.numFmt) v.numFmt = it.numFmt
      for (let c = 1; c <= lastCol; c++) ws.getCell(r, c).border = { bottom: { style: 'hair', color: { argb: 'FFD0D0D0' } } }
      r++
    }
    r++
  }

  const drawTable = (s: TableSection) => {
    if (showSectionTitle(report, s)) sectionTitle(s.title, s.subtitle)
    if (s.rows.length === 0) {
      ws.getCell(r, 1).value = s.emptyMessage ?? 'No data for the selected filters'
      ws.getCell(r, 1).font = font({ italic: true, color: { argb: MUTED } })
      r += 2
      return
    }
    const labelCol = s.columns.findIndex((c) => !isNumericFormat(c.format) && c.format !== 'code' && c.format !== 'date')
    s.columns.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1)
      cell.value = c.label
      cell.font = font({ bold: true })
      cell.alignment = { horizontal: isNumericFormat(c.format) ? 'right' : 'left', vertical: 'middle' }
      cell.border = { bottom: { style: 'thin', color: { argb: BLACK } } }
    })
    ws.getRow(r).height = 18
    r++
    const rows: { row: ReportRow; style?: RowStyle }[] = [
      ...s.rows.map((row) => ({ row, style: row._style })),
      ...(s.totals ? [{ row: s.totals, style: 'grand' as const }] : []),
    ]
    for (const { row, style } of rows) {
      const bold = style === 'heading' || style === 'subtotal' || style === 'grand'
      if (style === 'heading') ws.getRow(r).height = 20
      s.columns.forEach((c, i) => {
        const cell = ws.getCell(r, i + 1)
        cell.value = excelValue(row[c.key], c.format)
        cell.font = font({ bold })
        const fmt = numFmtFor(c.format)
        if (fmt) cell.numFmt = fmt
        cell.alignment = {
          horizontal: isNumericFormat(c.format) ? 'right' : 'left',
          vertical: style === 'heading' ? 'bottom' : 'middle',
          indent: style === 'indent' && i === Math.max(0, labelCol) ? 1 : 0,
        }
        if (style === 'subtotal') cell.border = { top: { style: 'thin', color: { argb: BLACK } } }
        else if (style === 'grand') cell.border = { top: { style: 'thin', color: { argb: BLACK } }, bottom: { style: 'double', color: { argb: BLACK } } }
        else if (style !== 'heading') cell.border = { bottom: { style: 'hair', color: { argb: 'FFD0D0D0' } } }
      })
      r++
    }
    r++
  }

  keyValues(report.sections.length ? 'Summary' : undefined, report.kpis.map((k) => {
    const numeric = typeof k.value === 'number' && (k.format ?? 'money') !== 'text'
    return { label: k.label, hint: k.hint, value: numeric ? (k.format ?? 'money') === 'money' ? round2(k.value as number) : (k.value as number) : kpiText(k), numFmt: numeric ? numFmtFor(k.format ?? 'money') : undefined }
  }))
  for (const s of report.sections) {
    if (s.type === 'table') drawTable(s)
    else if (s.type === 'stats') {
      keyValues(s.title, s.items.map((it) => ({ label: it.label, value: it.value, numFmt: typeof it.value === 'number' ? '#,##0' : undefined })))
      if (s.note) { ws.getCell(r, 1).value = s.note; ws.getCell(r, 1).font = font({ size: 9, color: { argb: MUTED } }); r += 2 }
    } else {
      ws.getCell(r, 1).value = s.title
      ws.getCell(r, 1).font = font({ bold: true })
      r++
      ws.mergeCells(r, 1, r, lastCol)
      const c = ws.getCell(r, 1)
      c.value = s.text
      c.font = font({ size: 9, color: { argb: MUTED } })
      c.alignment = { wrapText: true, vertical: 'top' }
      ws.getRow(r).height = Math.min(90, 13 * Math.ceil(s.text.length / 110) + 4)
      r += 2
    }
  }

  ws.getCell(r, 1).value = `Generated ${fmtDateShort(report.generatedAt)}  ·  Amounts in ${report.currency}`
  ws.getCell(r, 1).font = font({ size: 8, color: { argb: MUTED } })
  ws.pageSetup.printArea = `A1:${ws.getColumn(lastCol).letter}${r}`

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// Same order as the PDF; amounts are plain numbers so the file re-opens
// cleanly in Excel.

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

  line(reportTitle(report))
  line(report.orgName)
  line(report.dateLine ?? `For the period ${report.periodLabel}`)
  if (branchLine(report)) line(branchLine(report))

  if (report.kpis.length) {
    line()
    line('Summary')
    for (const k of report.kpis) line(k.label, typeof k.value === 'number' ? csvCell(k.value, k.format ?? 'money') : k.value)
  }
  for (const s of report.sections) {
    line()
    if (s.type === 'table') {
      if (showSectionTitle(report, s)) line(s.title)
      if (s.rows.length === 0) { line(s.emptyMessage ?? 'No data for the selected filters'); continue }
      line(...s.columns.map((c) => c.label))
      for (const r of s.rows) line(...s.columns.map((c) => csvCell(r[c.key], c.format)))
      if (s.totals) line(...s.columns.map((c) => csvCell(s.totals![c.key], c.format)))
    } else if (s.type === 'stats') {
      line(s.title)
      for (const it of s.items) line(it.label, typeof it.value === 'number' ? String(it.value) : it.value)
      if (s.note) line(s.note)
    } else {
      line(s.title)
      line(s.text)
    }
  }
  line()
  line(`Generated ${fmtDateShort(report.generatedAt)}`, `Amounts in ${report.currency}`)

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`)
  res.send('﻿' + lines.join('\r\n'))
}
