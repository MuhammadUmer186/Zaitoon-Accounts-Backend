import { Response } from 'express'
import ExcelJS from 'exceljs'
import { restaurantPresentation } from './restaurantPresentation'
import PDFDocument from 'pdfkit'
import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'
import {
  currentFormat, formatMoney, formatNumber, formatInteger, formatPercent, formatDate, formatDateTime,
  isoDate, isoDateTime, excelLocalDateTime, excelDateFormat, excelMoneyFormat, MONTHS_LONG,
} from './reportFormat'

const DEFAULT_LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'foodsync-logo-horizontal.png')

// The org's uploaded logo when there is one, else the FoodSync logo. The
// width/height ratio is read from the PNG header so any logo shape fits.
function reportLogo(report: ProReport): { path: string; ratio: number } | null {
  for (const candidate of [report.logoPath, DEFAULT_LOGO_PATH]) {
    if (!candidate) continue
    try {
      const head = Buffer.alloc(24)
      const fd = fs.openSync(candidate, 'r')
      fs.readSync(fd, head, 0, 24, 0)
      fs.closeSync(fd)
      if (head.readUInt32BE(12) !== 0x49484452) continue // not a PNG (IHDR)
      const w = head.readUInt32BE(16)
      const h = head.readUInt32BE(20)
      if (w && h) return { path: candidate, ratio: w / h }
    } catch {
      // missing/unreadable file — try the next candidate
    }
  }
  return null
}

// "Professional report" model shared by every catalog report. A report is
// described once (headline KPIs + ordered sections) and rendered four ways
// that read the same: the JSON the Reports page draws, a PDF, an Excel
// workbook and a CSV file. All numbers and dates go through reportFormat.ts,
// i.e. the organization's regional settings.
//
// kind "statement" (financial statements) prints portrait, shows negative
// amounts in brackets, and ends with a sign-off block.

export type CellFormat = 'text' | 'money' | 'number' | 'integer' | 'date' | 'datetime' | 'status' | 'percent' | 'code'

export interface ReportColumn {
  key: string
  label: string
  format?: CellFormat
  width?: number // relative weight in the PDF / character width hint in Excel
  statusLabels?: Record<string, string> // e.g. { approved: 'Unpaid' } for bills
  sum?: false // a running balance: never added up in page totals / SUM formulas
}

// heading: group caption · indent: line item · subtotal: group total (rule
// above) · total: statement total (rule above, double rule below) · spacer
export type RowStyle = 'heading' | 'subtotal' | 'indent' | 'total' | 'spacer'
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
  newPage?: boolean // start on a fresh page in the PDF
  register?: boolean // long transaction list: own sheet in Excel, page totals in the PDF
  primary?: boolean
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

export interface ReportEntity {
  legalName: string
  taxNumber?: string
  address?: string
}

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
  kind?: 'statement' | 'report'
  orientation?: 'portrait' | 'landscape'
  entity?: ReportEntity
  signatures?: string[] // sign-off lines under a statement
  preparedBy?: string
  logoPath?: string // uploaded org logo (PNG); falls back to the FoodSync logo
  editableName?: string // kept for older callers; the register sheet is the editable data now
}

// ── Formatting ──────────────────────────────────────────────────────────────

export const round2 = (n: number) => { const factor = 10 ** currentFormat().decimals; return Math.round((n + Number.EPSILON) * factor) / factor }
const roundTo = (n: number, digits: number) => { const f = 10 ** digits; return Math.round((n + Number.EPSILON) * f) / f }

export const fmtMoney = (n: number): string => formatMoney(n)
export const fmtDateShort = (d: Date | string): string => formatDate(d)

export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return `${MONTHS_LONG[m - 1]} ${y}`
}

export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : 0)

export interface CellOptions { accounting?: boolean; statusLabels?: Record<string, string> }

export function formatCell(value: unknown, format: CellFormat = 'text', opts: CellOptions = {}): string {
  if (value === null || value === undefined || value === '') return ''
  switch (format) {
    case 'money': return typeof value === 'number' ? formatMoney(value, opts.accounting) : String(value)
    case 'number': return typeof value === 'number' ? formatNumber(value) : String(value)
    case 'integer': return typeof value === 'number' ? formatInteger(value) : String(value)
    case 'percent': return typeof value === 'number' ? formatPercent(value) : String(value)
    case 'date': return value instanceof Date || typeof value === 'string' ? formatDate(value) : String(value)
    case 'datetime': return value instanceof Date || typeof value === 'string' ? formatDateTime(value) : String(value)
    case 'status': return humanizeStatus(String(value), opts.statusLabels)
    default: return String(value)
  }
}

const STATUS_LABELS: Record<string, string> = {
  approved: 'Approved', partial: 'Partial', paid: 'Paid', void: 'Void', draft: 'Draft', submitted: 'Submitted',
  over: 'Over', short: 'Short', balanced: 'Balanced', excess: 'Excess', bank_transfer: 'Bank Transfer', posted: 'Posted',
}

export function humanizeStatus(s: string, overrides?: Record<string, string>): string {
  return overrides?.[s] ?? STATUS_LABELS[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

const isNumericFormat = (f?: CellFormat) => f === 'money' || f === 'number' || f === 'integer' || f === 'percent'

// ── Scope / period helpers ──────────────────────────────────────────────────

export async function reportScope(prisma: PrismaClient, organizationId: string, branchId?: string) {
  const [org, branch] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, tradeName: true, currency: true, logoPath: true, multiBranch: true, vatNumber: true, address: true, city: true },
    }),
    branchId ? prisma.branch.findFirst({ where: { id: branchId, organizationId }, select: { name: true } }) : null,
  ])
  return {
    orgName: org?.tradeName || org?.name || 'Organization',
    currency: org?.currency ?? currentFormat().currency,
    logoPath: org?.logoPath ?? undefined,
    scopeLabel: org?.multiBranch === false ? org.tradeName || org.name : branch?.name ?? 'All branches',
    entity: org ? {
      legalName: org.name,
      taxNumber: org.vatNumber || undefined,
      address: [org.address, org.city].filter(Boolean).join(', ') || undefined,
    } : undefined,
  }
}

// Period label from the filter if given, otherwise from the data's own range
export function periodLabelFor(fromDate?: string, toDate?: string, dates: Date[] = []): string {
  if (fromDate || toDate) {
    const f = fromDate ? formatDate(fromDate) : 'Start'
    const t = toDate ? formatDate(toDate) : 'Today'
    return `${f} – ${t}`
  }
  if (dates.length === 0) return 'All time'
  const ms = dates.map((d) => d.getTime())
  return `${formatDate(new Date(Math.min(...ms)))} – ${formatDate(new Date(Math.max(...ms)))}`
}

export const plural = (n: number, word: string, pluralWord = `${word}s`) => `${formatInteger(n)} ${n === 1 ? word : pluralWord}`

const isStatement = (r: ProReport) => r.kind === 'statement'
const orientationOf = (r: ProReport) => r.orientation ?? (isStatement(r) ? 'portrait' : 'landscape')
const DEFAULT_SIGNATURES = ['Prepared by', 'Reviewed by', 'Approved by']

function entityLine(r: ProReport): string {
  const e = r.entity
  if (!e) return ''
  const ctx = currentFormat()
  return [e.legalName, e.taxNumber ? `${ctx.taxLabel} registration no. ${e.taxNumber}` : '', e.address ?? ''].filter(Boolean).join('  ·  ')
}

function footerLine(r: ProReport): string {
  return `${r.orgName}  |  ${r.periodLabel}  |  Amounts in ${r.currency}  |  Generated ${formatDateTime(r.generatedAt)}${r.preparedBy ? ` by ${r.preparedBy}` : ''}`
}

// Sums of the money columns of some rows, labelled in the first column
function sumRow(cols: ReportColumn[], rows: ReportRow[], label: string): ReportRow {
  const out: ReportRow = { [cols[0].key]: label }
  for (const c of cols) if (c.format === 'money' && c.sum !== false) out[c.key] = round2(rows.reduce((acc, r) => acc + (Number(r[c.key]) || 0), 0))
  return out
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export async function sendProReport(res: Response, format: string | undefined, report: ProReport, legacy: Record<string, unknown> = {}): Promise<void> {
  if (res.locals.singleBranch) report = restaurantPresentation(report, res.locals.restaurantName) as ProReport
  const ctx = currentFormat()
  report = { ...report, preparedBy: report.preparedBy ?? ctx.preparedBy, currency: ctx.currency }
  const fileBase = `${report.key}-${isoDate(new Date())}`
  if (format === 'pdf') return renderPdf(res, report, fileBase)
  if (format === 'excel') return renderExcel(res, report, fileBase)
  if (format === 'csv') return renderCsv(res, report, fileBase)
  const { preparedBy: _p, ...fmt } = ctx
  res.json({ ...legacy, report: { ...report, format: { ...fmt, kind: report.kind ?? 'report' } } })
}

// ── PDF ─────────────────────────────────────────────────────────────────────

// FoodSync brand colours — deep green and gold from the logo. The Reports
// screen uses the same values (ProReportView.tsx).
const C = {
  ink: '#1f1f1f',
  text: '#222a27',
  muted: '#55635e',
  faint: '#87938e',
  accent: '#065442',
  amber: '#e6b14a', // KPI figure on the dark card (logo gold)
  card: '#eef5f2',
  zebra: '#f6faf8',
  totals: '#d9ebe4',
  rule: '#cfe0d9',
  positive: '#15803d',
  negative: '#b91c1c',
  warning: '#b45309',
}

const STATUS_COLORS: Record<string, string> = {
  paid: C.positive, approved: C.accent, posted: C.accent, partial: C.warning, void: C.negative,
  draft: C.faint, submitted: C.accent, over: C.positive, excess: C.positive, short: C.negative, balanced: C.positive,
}

// The built-in Helvetica font is WinAnsi-encoded: swap characters it can't
// draw for close equivalents instead of letting them render as junk.
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')
const pdfSafe = (t: string) => t
  .replace(/−/g, '-').replace(/≠/g, '<>').replace(/[←-⇿]/g, '>').replace(/÷/g, '/')
  .replace(/[\s\S]/g, (ch) => (ch.charCodeAt(0) <= 0xff || WINANSI_EXTRA.has(ch) ? ch : '?'))

const ROW_H = 20
const HEAD_H = 24

function renderPdf(res: Response, report: ProReport, fileBase: string) {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.pdf"`)

  const portrait = orientationOf(report) === 'portrait'
  const PAGE = portrait ? { w: 595.28, h: 841.89, m: 42 } : { w: 841.89, h: 595.28, m: 40 }
  const CONTENT_W = PAGE.w - PAGE.m * 2
  const BOTTOM = PAGE.h - 58 // footer zone starts here
  const accounting = isStatement(report)
  const cellText = (v: unknown, c?: ReportColumn) => formatCell(v, c?.format, { accounting, statusLabels: c?.statusLabels })

  const doc = new PDFDocument({ size: 'A4', layout: portrait ? 'portrait' : 'landscape', margin: PAGE.m, bufferPages: true, info: { Title: `${report.eyebrow} — ${report.orgName}`, Author: report.orgName, Creator: 'FoodSync' } })
  doc.pipe(res)

  let y = 0
  let firstPage = true

  const startPage = (title: string, subtitle?: string) => {
    if (!firstPage) doc.addPage()
    const isFirst = firstPage
    firstPage = false
    doc.rect(0, 0, PAGE.w, 9).fill(C.ink)
    doc.rect(0, 9, PAGE.w, 2.5).fill(C.accent)
    const logoH = portrait ? 38 : 46
    const logo = reportLogo(report)
    const logoW = logo ? Math.min(logoH * logo.ratio, portrait ? 150 : 200) : 0
    if (logo) doc.image(logo.path, PAGE.w - PAGE.m - logoW, 18, { fit: [logoW, logoH], align: 'right', valign: 'center' })
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.accent)
      .text(pdfSafe(report.eyebrow.toUpperCase()), PAGE.m, 30, { lineBreak: false, characterSpacing: 0.4 })
    doc.font('Helvetica').fontSize(8).fillColor(C.muted)
      .text(pdfSafe(`${report.orgName.toUpperCase()}  /  ${report.scopeLabel.toUpperCase()}`), PAGE.m, 30, { width: CONTENT_W - logoW - 14, align: 'right', lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(portrait ? 20 : 24).fillColor(C.ink).text(pdfSafe(title), PAGE.m, 46, { width: CONTENT_W - logoW - 14, lineBreak: false })
    y = portrait ? 74 : 80
    if (subtitle) {
      doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(pdfSafe(subtitle), PAGE.m, y, { width: CONTENT_W, lineBreak: false })
      y += 14
    }
    const entity = isFirst ? entityLine(report) : ''
    if (entity) {
      doc.font('Helvetica').fontSize(8).fillColor(C.faint).text(pdfSafe(entity), PAGE.m, y, { width: CONTENT_W, lineBreak: false, ellipsis: true })
      y += 12
    }
    y += 12
  }

  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) startPage(report.headline, 'continued')
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
    const gap = portrait ? 8 : 14
    const perRow = kpis.length
    const w = (CONTENT_W - gap * (perRow - 1)) / perRow
    const h = portrait ? 62 : 82
    kpis.forEach((k, i) => {
      const col = i % perRow
      const x = PAGE.m + col * (w + gap)
      const dark = k.tone === 'dark'
      doc.roundedRect(x, y, w, h, 6).fill(dark ? C.ink : C.card)
      const pad = portrait ? 10 : 14
      doc.font('Helvetica-Bold').fontSize(portrait ? 7 : 8).fillColor(dark ? '#8fd0b9' : C.muted)
        .text(pdfSafe(k.label.toUpperCase()), x + pad, y + 11, { width: w - pad * 2, height: 10, characterSpacing: 0.3, ellipsis: true })
      const valueColor = dark ? C.amber
        : k.tone === 'positive' ? C.positive : k.tone === 'negative' ? C.negative : k.tone === 'warning' ? C.warning : C.ink
      const valueText = typeof k.value === 'number' ? formatCell(k.value, k.format ?? 'money', { accounting }) : k.value
      // shrink long figures until they fit the card
      let size = portrait ? 14 : valueText.length > 14 ? 17 : 21
      doc.font('Helvetica-Bold')
      while (size > 9 && doc.fontSize(size).widthOfString(pdfSafe(valueText)) > w - pad * 2) size -= 0.5
      doc.fontSize(size).fillColor(valueColor).text(pdfSafe(valueText), x + pad, y + (portrait ? 25 : 30), { width: w - pad * 2, lineBreak: false, ellipsis: true })
      if (k.hint) {
        doc.font('Helvetica').fontSize(portrait ? 7 : 8).fillColor(dark ? '#dcede6' : C.muted)
          .text(pdfSafe(k.hint), x + pad, y + (portrait ? 44 : 60), { width: w - pad * 2, height: portrait ? 9 : 10, ellipsis: true })
      }
    })
    y += h + 22
  }

  const colWidths = (cols: ReportColumn[]) => {
    const weights = cols.map((c) => c.width ?? (c.format === 'money' ? 1.25 : c.format === 'date' ? 1.05 : c.format === 'datetime' ? 1.35 : c.format === 'status' ? 0.9
      : c.format === 'integer' || c.format === 'number' || c.format === 'percent' ? 0.8 : c.format === 'code' ? 1.1 : 1.9))
    const total = weights.reduce((s, w) => s + w, 0)
    return weights.map((w) => (w / total) * CONTENT_W)
  }

  // One single-line cell: truncated with "..." to the column width, numbers
  // right-aligned by measuring, so text never wraps into the next row.
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

  // statements set a little tighter, like printed accounts
  const BODY_H = accounting ? 17.5 : ROW_H
  const rowHeight = (row: ReportRow, kind: 'row' | 'total') => (kind === 'total' || row._style === 'total' ? BODY_H + 4 : row._style === 'spacer' ? 6 : BODY_H)

  const drawRow = (cols: ReportColumn[], widths: number[], row: ReportRow, index: number, kind: 'row' | 'total' = 'row') => {
    const style = row._style
    const h = rowHeight(row, kind)
    if (style === 'spacer') { y += h; return }
    if (kind === 'total') {
      doc.rect(PAGE.m, y, CONTENT_W, h).fill(C.totals)
      doc.moveTo(PAGE.m, y).lineTo(PAGE.m + CONTENT_W, y).lineWidth(0.8).strokeColor(C.ink).stroke()
    } else if (style === 'heading') {
      doc.rect(PAGE.m, y, CONTENT_W, h).fill(C.card)
    } else if (index % 2 === 1 && !accounting) {
      doc.rect(PAGE.m, y, CONTENT_W, h).fill(C.zebra)
    }
    // statement rules sit over the amount columns only
    const numStart = cols.findIndex((c) => isNumericFormat(c.format))
    const ruleX = numStart > 0 ? PAGE.m + widths.slice(0, numStart).reduce((s, w) => s + w, 0) : PAGE.m
    if (style === 'subtotal') {
      doc.moveTo(ruleX, y).lineTo(PAGE.m + CONTENT_W, y).lineWidth(0.6).strokeColor(C.muted).stroke()
    }
    if (style === 'total') {
      doc.moveTo(ruleX, y).lineTo(PAGE.m + CONTENT_W, y).lineWidth(0.8).strokeColor(C.ink).stroke()
      doc.moveTo(ruleX, y + h - 2).lineTo(PAGE.m + CONTENT_W, y + h - 2).lineWidth(0.6).strokeColor(C.ink).stroke()
      doc.moveTo(ruleX, y + h).lineTo(PAGE.m + CONTENT_W, y + h).lineWidth(0.6).strokeColor(C.ink).stroke()
    }
    const bold = kind === 'total' || style === 'heading' || style === 'subtotal' || style === 'total'
    const indentCol = cols.findIndex((c) => c.format !== 'code')
    const texts = cols.map((c) => cellText(row[c.key], c))
    let x = PAGE.m
    cols.forEach((c, i) => {
      const raw = row[c.key]
      const text = texts[i]
      let span = widths[i]
      if (text && !isNumericFormat(c.format)) for (let j = i + 1; j < cols.length && !texts[j]; j++) span += widths[j]
      let color = C.text
      if (c.format === 'status' && typeof raw === 'string') color = STATUS_COLORS[raw] ?? C.accent
      else if (c.format === 'code') color = C.ink
      else if (c.format === 'money' && typeof raw === 'number' && raw < -0.005 && !accounting) color = C.negative
      const indent = i === indentCol && style === 'indent' ? 14 : 0
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.3).fillColor(color)
      if (text) cell(text, x + 7 + indent, y + (h - 8.3) / 2 + 0.5, span - 14 - indent, isNumericFormat(c.format))
      x += widths[i]
    })
    y += h
  }

  // A table that flows across pages, repeating its header. A register adds
  // a "Page total" row at the foot of every page it spans; the totals row
  // (grand total) closes the table.
  const drawTable = (s: TableSection) => {
    const widths = colWidths(s.columns)
    const minRows = Math.min(3, Math.max(1, s.rows.length))
    if (s.newPage && y > 150) startPage(report.headline, 'continued')
    ensure(40 + HEAD_H + ROW_H * minRows)
    sectionHeading(s.title, s.subtitle)
    if (s.rows.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(C.faint).text(pdfSafe(s.emptyMessage ?? 'No data for the selected filters'), PAGE.m, y + 4)
      y += 30
      return
    }
    const pageTotals = !!s.register && s.columns.some((c) => c.format === 'money' && c.sum !== false)
    const reserve = pageTotals ? ROW_H + 4 : 0
    drawHeader(s.columns, widths)
    let onPage: ReportRow[] = []
    let spanned = false
    s.rows.forEach((r, i) => {
      if (y + rowHeight(r, 'row') + reserve > BOTTOM) {
        if (pageTotals) drawRow(s.columns, widths, sumRow(s.columns, onPage, 'Page total'), 0, 'total')
        spanned = true
        onPage = []
        startPage(s.title, `${s.subtitle ? `${s.subtitle}  |  ` : ''}continued`)
        drawHeader(s.columns, widths)
      }
      drawRow(s.columns, widths, r, i)
      onPage.push(r)
    })
    const closing = (pageTotals && spanned ? 1 : 0) + (s.totals ? 1 : 0)
    if (closing && y + closing * (ROW_H + 4) > BOTTOM) {
      startPage(s.title, 'continued')
      drawHeader(s.columns, widths)
    }
    if (pageTotals && spanned) drawRow(s.columns, widths, sumRow(s.columns, onPage, 'Page total'), 0, 'total')
    if (s.totals) drawRow(s.columns, widths, spanned ? { ...s.totals, [s.columns[0].key]: 'GRAND TOTAL' } : s.totals, 0, 'total')
    y += 22
  }

  const drawStats = (s: StatsSection) => {
    ensure(70)
    sectionHeading(s.title)
    doc.fontSize(10)
    s.items.forEach((it, i) => {
      const last = i === s.items.length - 1
      const value = typeof it.value === 'number' ? formatInteger(it.value) : it.value
      const color = it.tone === 'positive' ? C.positive : it.tone === 'negative' ? C.negative : it.tone === 'warning' ? C.warning : C.ink
      doc.font('Helvetica').fillColor(C.text)
      if (i === 0) doc.text(pdfSafe(`${it.label}: `), PAGE.m, y, { continued: true, lineBreak: false })
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
    const width = portrait ? CONTENT_W : CONTENT_W * 0.75
    const height = doc.font('Helvetica').fontSize(8.5).heightOfString(pdfSafe(s.text), { width })
    ensure(height + 30)
    doc.font('Helvetica-Bold').fontSize(8).fillColor(s.tone === 'warning' ? C.warning : C.accent)
      .text(pdfSafe(s.title.toUpperCase()), PAGE.m, y, { lineBreak: false, characterSpacing: 0.3 })
    y += 13
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(pdfSafe(s.text), PAGE.m, y, { width })
    y = doc.y + 18
  }

  // Sign-off lines under a financial statement
  const drawSignatures = (labels: string[]) => {
    ensure(52)
    y += 18
    const gap = 24
    const w = (CONTENT_W - gap * (labels.length - 1)) / labels.length
    labels.forEach((label, i) => {
      const x = PAGE.m + i * (w + gap)
      doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).strokeColor(C.muted).stroke()
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.text).text(pdfSafe(label), x, y + 6, { width: w, lineBreak: false })
      doc.font('Helvetica').fontSize(7.5).fillColor(C.faint).text('Name, signature and date', x, y + 17, { width: w, lineBreak: false })
    })
    y += 30
  }

  startPage(report.headline, report.summaryLine)
  drawKpis(report.kpis)
  for (const s of report.sections) {
    if (s.type === 'table') drawTable(s)
    else if (s.type === 'stats') drawStats(s)
    else drawNote(s)
  }
  if (isStatement(report)) drawSignatures(report.signatures ?? DEFAULT_SIGNATURES)

  // Footer on every page
  const range = doc.bufferedPageRange()
  const footer = pdfSafe(footerLine(report))
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    const fy = PAGE.h - 40
    doc.moveTo(PAGE.m, fy).lineTo(PAGE.w - PAGE.m, fy).lineWidth(0.5).strokeColor(C.rule).stroke()
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted)
      .text(footer, PAGE.m, fy + 9, { width: CONTENT_W - 70, lineBreak: false, height: 10, ellipsis: true })
    doc.text(`Page ${i + 1} of ${range.count}`, PAGE.m, fy + 9, { width: CONTENT_W, align: 'right', lineBreak: false, height: 10 })
  }
  doc.end()
}

// ── Excel ───────────────────────────────────────────────────────────────────
// Sheet "Report" carries what the PDF shows before the registers — header,
// KPI cards, summary tables or the full statement — in the same colours and
// order. Every register gets its own sheet: one continuous table with a
// frozen header, filters, real dates and numbers, and live SUM totals.

const X = {
  ink: 'FF1F1F1F', text: 'FF222A27', muted: 'FF55635E', faint: 'FF87938E', accent: 'FF065442', amber: 'FFE6B14A',
  card: 'FFEEF5F2', zebra: 'FFF6FAF8', totals: 'FFD9EBE4', white: 'FFFFFFFF', kpiLabelDark: 'FF8FD0B9', kpiHintDark: 'FFDCEDE6',
  positive: 'FF15803D', negative: 'FFB91C1C', warning: 'FFB45309', rule: 'FFCFE0D9',
}
const XSTATUS: Record<string, string> = {
  paid: X.positive, approved: X.accent, posted: X.accent, partial: X.warning, void: X.negative, draft: X.faint, submitted: X.accent,
  short: X.negative, over: X.positive, excess: X.positive, balanced: X.positive,
}
const FONT = 'Arial'
const solid = (argb: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })

async function renderExcel(res: Response, report: ProReport, fileBase: string) {
  const ctx = currentFormat()
  const accounting = isStatement(report)
  const orientation = orientationOf(report)
  const moneyFmt = excelMoneyFormat(accounting)
  const numFmtFor = (f?: CellFormat) =>
    f === 'money' ? moneyFmt : f === 'integer' ? '#,##0' : f === 'number' ? '#,##0.###' : f === 'percent' ? '0.0"%"'
      : f === 'date' ? excelDateFormat() : f === 'datetime' ? excelDateFormat(ctx, true) : undefined
  const valueFor = (v: unknown, c?: ReportColumn): ExcelJS.CellValue => {
    if (v === null || v === undefined || v === '') return null
    const f = c?.format
    if (f === 'date' && (typeof v === 'string' || v instanceof Date)) { const d = new Date(v); return isNaN(d.getTime()) ? String(v) : d }
    if (f === 'datetime' && (typeof v === 'string' || v instanceof Date)) return excelLocalDateTime(v) ?? String(v)
    if (f === 'status' && typeof v === 'string') return humanizeStatus(v, c?.statusLabels)
    if (typeof v === 'number' && f === 'money') return roundTo(v, ctx.decimals)
    return v as ExcelJS.CellValue
  }

  const wb = new ExcelJS.Workbook()
  wb.creator = report.preparedBy ?? report.orgName
  wb.company = report.entity?.legalName ?? report.orgName
  wb.created = new Date()
  wb.title = `${report.eyebrow} — ${report.orgName}`
  const logo = reportLogo(report)
  const logoId = logo ? wb.addImage({ filename: logo.path, extension: 'png' }) : undefined
  const footer = footerLine(report).replace(/&/g, '&&')
  const usedNames = new Set<string>()
  const sheetName = (want: string) => {
    let name = want.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet'
    for (let i = 2; usedNames.has(name.toLowerCase()); i++) name = `${want.slice(0, 27)} ${i}`
    usedNames.add(name.toLowerCase())
    return name
  }
  const newSheet = (name: string, frozenRows = 0) => wb.addWorksheet(sheetName(name), {
    properties: { tabColor: { argb: X.accent } },
    views: [frozenRows ? { state: 'frozen', ySplit: frozenRows, showGridLines: false } : { showGridLines: false }],
    pageSetup: {
      paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.25, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L&8${footer}&R&8Page &P of &N` },
  })

  const colWeights = (cols: ReportColumn[]) => cols.map((c) => c.width ?? (c.format === 'money' ? 1.25 : c.format === 'date' ? 1.05 : c.format === 'datetime' ? 1.35 : c.format === 'status' ? 0.9
    : c.format === 'integer' || c.format === 'number' || c.format === 'percent' ? 0.8 : c.format === 'code' ? 1.1 : 1.9))

  // Shared writer over a sheet whose column A is a margin
  const C0 = 2
  const writer = (ws: ExcelJS.Worksheet, gridCols: number) => {
    const lastCol = C0 + gridCols - 1
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
    const header = (title: string, subtitle: string | undefined, withEntity: boolean) => {
      setRow(6)
      for (let c = 1; c <= lastCol + 1; c++) ws.getCell(r, c).fill = solid(X.ink)
      r += 2
      setRow(18)
      const half = C0 + Math.max(1, Math.floor(gridCols / 2))
      write(r, C0, half - 1, report.eyebrow.toUpperCase(), { bold: true, size: 9, color: { argb: X.accent } })
      write(r, half, logoId !== undefined && gridCols > 2 ? lastCol - 1 : lastCol, `${report.orgName.toUpperCase()}  /  ${report.scopeLabel.toUpperCase()}`, { size: 8, color: { argb: X.muted } }, { align: 'right' })
      if (logoId !== undefined) ws.addImage(logoId, { tl: { col: lastCol - 1 + 0.1, row: 1.2 }, ext: { width: Math.round(Math.min(56 * logo!.ratio, 200)), height: 56 } })
      r++
      setRow(34)
      write(r, C0, lastCol, title, { bold: true, size: 20, color: { argb: X.ink } })
      r++
      if (subtitle) { setRow(18); write(r, C0, lastCol, subtitle, { size: 9.5, color: { argb: X.muted } }); r++ }
      const entity = withEntity ? entityLine(report) : ''
      if (entity) { setRow(16); write(r, C0, lastCol, entity, { size: 8.5, color: { argb: X.faint } }); r++ }
      r++
    }
    const kpis = (list: ReportKpi[]) => {
      if (list.length === 0) return
      const perRow = orientation === 'portrait' ? Math.min(2, list.length) : list.length
      for (let start = 0; start < list.length; start += perRow) {
        const chunk = list.slice(start, start + perRow)
        const base = Math.floor(gridCols / chunk.length)
        let extra = gridCols - base * chunk.length
        let c = C0
        const [rl, rv, rh] = [r, r + 1, r + 2]
        ws.getRow(rl).height = 22; ws.getRow(rv).height = 32; ws.getRow(rh).height = 20
        for (const k of chunk) {
          const span = base + (extra-- > 0 ? 1 : 0)
          const c2 = c + span - 1
          const dark = k.tone === 'dark'
          const fill = dark ? X.ink : X.card
          const valueColor = dark ? X.amber : k.tone === 'positive' ? X.positive : k.tone === 'negative' ? X.negative : k.tone === 'warning' ? X.warning : X.ink
          const numeric = typeof k.value === 'number'
          const fmt = k.format ?? 'money'
          write(rl, c, c2, k.label.toUpperCase(), { bold: true, size: 8, color: { argb: dark ? X.kpiLabelDark : X.muted } }, { fill })
          write(rv, c, c2, numeric && fmt !== 'text' ? (fmt === 'money' ? roundTo(k.value as number, ctx.decimals) : (k.value as number)) : String(k.value), { bold: true, size: 18, color: { argb: valueColor } },
            { fill, numFmt: numeric ? numFmtFor(fmt) : undefined, align: 'left' })
          write(rh, c, c2, k.hint ?? '', { size: 8.5, color: { argb: dark ? X.kpiHintDark : X.muted } }, { fill })
          for (const row of [rl, rv, rh]) {
            ws.getCell(row, c).border = { left: { style: 'thick', color: { argb: X.white } } }
            ws.getCell(row, c2).border = { ...(c === c2 ? ws.getCell(row, c).border : {}), right: { style: 'thick', color: { argb: X.white } } }
          }
          c = c2 + 1
        }
        r = rh + 2
      }
    }
    const sectionHeading = (title: string, subtitle?: string) => {
      setRow(24); write(r, C0, lastCol, title, { bold: true, size: 13, color: { argb: X.ink } }); r++
      if (subtitle) { setRow(16); write(r, C0, lastCol, subtitle, { size: 9, color: { argb: X.muted } }); r++ }
    }
    const tableHeader = (cols: ReportColumn[]) => {
      setRow(24)
      cols.forEach((col, i) => write(r, C0 + i, C0 + i, col.label, { bold: true, size: 9, color: { argb: X.white } }, { fill: X.ink, align: isNumericFormat(col.format) ? 'right' : 'left', wrap: true }))
      const headerRow = r
      r++
      return headerRow
    }
    const tableRow = (cols: ReportColumn[], row: ReportRow, i: number, kind: 'row' | 'total' = 'row', formulas?: Record<string, string>) => {
      const style = row._style
      if (style === 'spacer') { setRow(8); r++; return }
      const fill = kind === 'total' ? X.totals : style === 'heading' ? X.card : i % 2 === 1 && !accounting ? X.zebra : undefined
      const bold = kind === 'total' || style === 'heading' || style === 'subtotal' || style === 'total'
      const indentCol = cols.findIndex((c) => c.format !== 'code')
      setRow(kind === 'total' || style === 'total' ? 22 : 19)
      cols.forEach((col, ci) => {
        const raw = row[col.key]
        const numeric = isNumericFormat(col.format)
        const color = col.format === 'status' && typeof raw === 'string' ? XSTATUS[raw] ?? X.accent
          : typeof raw === 'number' && raw < -0.005 && col.format === 'money' && !accounting ? X.negative : X.text
        const formula = formulas?.[col.key]
        const value: ExcelJS.CellValue = formula ? { formula, result: valueFor(raw, col) as number } : valueFor(raw, col)
        write(r, C0 + ci, C0 + ci, value, { bold, size: 9, color: { argb: color } }, { fill, align: numeric ? 'right' : 'left', numFmt: numFmtFor(col.format) })
        const cell = ws.getCell(r, C0 + ci)
        if (ci === indentCol && style === 'indent') cell.alignment = { ...cell.alignment, indent: 3 }
        if (kind === 'total') cell.border = { top: { style: 'thin', color: { argb: X.ink } } }
        else if (style === 'subtotal' && numeric) cell.border = { top: { style: 'thin', color: { argb: X.muted } } }
        else if (style === 'total' && numeric) cell.border = { top: { style: 'thin', color: { argb: X.ink } }, bottom: { style: 'double', color: { argb: X.ink } } }
      })
      r++
    }
    const note = (s: NoteSection) => {
      setRow(16)
      write(r, C0, lastCol, s.title.toUpperCase(), { bold: true, size: 8.5, color: { argb: s.tone === 'warning' ? X.warning : X.accent } })
      r++
      setRow(Math.min(90, 14 * Math.ceil(s.text.length / (gridCols * 14)) + 6))
      write(r, C0, lastCol, s.text, { size: 9, color: { argb: X.muted } }, { wrap: true })
      ws.getCell(r, C0).alignment = { vertical: 'top', wrapText: true, indent: 1 }
      r += 2
    }
    const stats = (s: StatsSection) => {
      sectionHeading(s.title)
      setRow(20)
      const rich: ExcelJS.RichText[] = []
      s.items.forEach((it, i) => {
        const color = it.tone === 'positive' ? X.positive : it.tone === 'negative' ? X.negative : it.tone === 'warning' ? X.warning : X.ink
        rich.push({ text: `${it.label}: `, font: { name: FONT, size: 10.5, color: { argb: X.text } } })
        rich.push({ text: typeof it.value === 'number' ? formatInteger(it.value) : String(it.value), font: { name: FONT, size: 10.5, bold: true, color: { argb: color } } })
        if (i < s.items.length - 1) rich.push({ text: '     |     ', font: { name: FONT, size: 10.5, color: { argb: X.faint } } })
      })
      write(r, C0, lastCol, { richText: rich }, {})
      r++
      if (s.note) { setRow(18); write(r, C0, lastCol, s.note, { size: 9, color: { argb: X.muted } }); r++ }
      r++
    }
    const signatures = (labels: string[]) => {
      r += 2
      const per = Math.max(1, Math.floor(gridCols / labels.length))
      labels.forEach((label, i) => {
        const c1 = C0 + i * per
        const c2 = i === labels.length - 1 ? lastCol : c1 + per - 1
        for (let c = c1; c <= c2; c++) ws.getCell(r, c).border = { top: { style: 'thin', color: { argb: X.muted } } }
        write(r, c1, c2, label, { bold: true, size: 9, color: { argb: X.text } })
        write(r + 1, c1, c2, 'Name, signature and date', { size: 8, color: { argb: X.faint } })
      })
      r += 3
    }
    const footerRow = () => {
      r++
      for (let c = C0; c <= lastCol; c++) ws.getCell(r, c).border = { top: { style: 'thin', color: { argb: X.rule } } }
      setRow(18)
      write(r, C0, lastCol, footerLine(report), { size: 8, color: { argb: X.muted } })
      ws.pageSetup.printArea = `A1:${ws.getColumn(lastCol + 1).letter}${r}`
    }
    return { get r() { return r }, set r(v) { r = v }, lastCol, header, kpis, sectionHeading, tableHeader, tableRow, note, stats, signatures, footerRow, write, setRow }
  }

  const sizeColumns = (ws: ExcelJS.Worksheet, cols: ReportColumn[], gridCols: number, totalWidth: number) => {
    ws.getColumn(1).width = 2.5
    const weights = colWeights(cols)
    while (weights.length < gridCols) weights.push(1.2)
    const wsum = weights.reduce((s, w) => s + w, 0)
    weights.forEach((w, i) => { ws.getColumn(C0 + i).width = Math.max(10, Math.round((w / wsum) * totalWidth)) })
  }

  // Sheet 1: everything except registers
  const summaryTables = report.sections.filter((s): s is TableSection => s.type === 'table' && !s.register)
  const widest = summaryTables.reduce<TableSection | undefined>((w, t) => (!w || t.columns.length > w.columns.length ? t : w), undefined)
  const gridCols = Math.max(orientation === 'portrait' ? 4 : 6, widest?.columns.length ?? 0)
  const main = newSheet(isStatement(report) ? report.eyebrow : 'Report')
  sizeColumns(main, widest?.columns ?? [], gridCols, orientation === 'portrait' ? 105 : 150)
  const m = writer(main, gridCols)
  m.header(report.headline, report.summaryLine, true)
  m.kpis(report.kpis)
  for (const s of report.sections) {
    if (s.type === 'table' && s.register) continue
    if (s.type === 'table') {
      m.sectionHeading(s.title, s.subtitle)
      if (s.rows.length === 0) {
        m.write(m.r, C0, m.lastCol, s.emptyMessage ?? 'No data for the selected filters', { size: 9.5, italic: true, color: { argb: X.faint } })
        m.r += 2
        continue
      }
      m.tableHeader(s.columns)
      s.rows.forEach((row, i) => m.tableRow(s.columns, row, i))
      if (s.totals) m.tableRow(s.columns, s.totals, 0, 'total')
      m.r++
    } else if (s.type === 'stats') m.stats(s)
    else m.note(s)
  }
  const registers = report.sections.filter((s): s is TableSection => s.type === 'table' && !!s.register)
  if (registers.length) {
    m.setRow(18)
    m.write(m.r, C0, m.lastCol, `Detail: ${registers.map((s) => `"${s.title}" sheet`).join(', ')}`, { size: 9, italic: true, color: { argb: X.muted } })
    m.r++
  }
  if (isStatement(report)) m.signatures(report.signatures ?? DEFAULT_SIGNATURES)
  m.footerRow()

  // One sheet per register
  for (const s of registers) {
    const cols = s.columns
    const ws = newSheet(s.title)
    sizeColumns(ws, cols, cols.length, Math.max(110, cols.length * 16))
    const w = writer(ws, cols.length)
    w.header(s.title, `${s.subtitle ? `${s.subtitle}  |  ` : ''}${report.periodLabel}  |  ${plural(s.rows.length, 'row')}`, false)
    if (s.rows.length === 0) {
      w.write(w.r, C0, w.lastCol, s.emptyMessage ?? 'No data for the selected filters', { size: 9.5, italic: true, color: { argb: X.faint } })
      w.r += 2
      w.footerRow()
      continue
    }
    const headerRow = w.tableHeader(cols)
    ws.views = [{ state: 'frozen', ySplit: headerRow, showGridLines: false }]
    ws.autoFilter = { from: { row: headerRow, column: C0 }, to: { row: headerRow, column: C0 + cols.length - 1 } }
    ws.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`
    const first = headerRow + 1
    s.rows.forEach((row, i) => w.tableRow(cols, row, i))
    const last = w.r - 1
    // totals stay live: they recalculate when rows are edited
    const formulas: Record<string, string> = {}
    cols.forEach((c, i) => {
      if ((c.format === 'money' && c.sum !== false) || (c.format === 'integer' && s.totals?.[c.key] !== undefined)) {
        const L = ws.getColumn(C0 + i).letter
        formulas[c.key] = `SUBTOTAL(109,${L}${first}:${L}${last})`
      }
    })
    const totals = s.totals ?? sumRow(cols, s.rows, 'TOTAL')
    w.tableRow(cols, totals, 0, 'total', formulas)
    w.footerRow()
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// Machine-readable: a short metadata block, then every section as a plain
// table separated by a blank line. Numbers have no thousands separators,
// dates are ISO (YYYY-MM-DD, times in the organization's zone), percentages
// are plain numbers, and registers are never split into pages.

function csvEscape(value: unknown): string {
  let s = value == null ? '' : String(value)
  // text a spreadsheet would run as a formula is neutralised (CSV injection)
  if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function renderCsv(res: Response, report: ProReport, fileBase: string) {
  const ctx = currentFormat()
  const value = (v: unknown, c?: ReportColumn): string => {
    if (v === null || v === undefined || v === '') return ''
    const f = c?.format
    if (typeof v === 'number') {
      if (f === 'money') return roundTo(v, ctx.decimals).toFixed(ctx.decimals)
      if (f === 'percent') return roundTo(v, 2).toString()
      if (f === 'integer') return String(Math.round(v))
      return String(v)
    }
    if (f === 'date' && (typeof v === 'string' || v instanceof Date)) return isoDate(v)
    if (f === 'datetime' && (typeof v === 'string' || v instanceof Date)) return isoDateTime(v)
    if (f === 'status') return humanizeStatus(String(v), c?.statusLabels)
    return String(v)
  }
  const label = (c: ReportColumn) => (c.format === 'percent' && !c.label.includes('%') ? `${c.label} (%)` : c.format === 'money' ? `${c.label} (${report.currency})` : c.label)

  const lines: string[] = []
  const line = (...cells: unknown[]) => lines.push(cells.map(csvEscape).join(','))
  line('Report', `${report.eyebrow} — ${report.headline}`)
  line('Organization', report.entity?.legalName ?? report.orgName)
  if (report.entity?.taxNumber) line(`${ctx.taxLabel} registration no.`, report.entity.taxNumber)
  line('Scope', report.scopeLabel)
  line('Period', report.periodLabel)
  line('Currency', report.currency)
  line('Generated', isoDateTime(report.generatedAt))
  if (report.preparedBy) line('Prepared by', report.preparedBy)

  if (report.kpis.length) {
    line()
    line('Summary')
    line('Metric', 'Value', 'Note')
    for (const k of report.kpis) line(k.label, typeof k.value === 'number' ? value(k.value, { key: 'v', label: '', format: k.format ?? 'money' }) : k.value, k.hint ?? '')
  }
  for (const s of report.sections) {
    line()
    if (s.type === 'table') {
      line(s.title)
      if (s.rows.length === 0) { line(s.emptyMessage ?? 'No data for the selected filters'); continue }
      line(...s.columns.map(label))
      for (const r of s.rows) if (r._style !== 'spacer') line(...s.columns.map((c) => value(r[c.key], c)))
      if (s.totals) line(...s.columns.map((c) => value(s.totals![c.key], c)))
    } else if (s.type === 'stats') {
      line(s.title)
      line('Item', 'Count')
      for (const it of s.items) line(it.label, it.value)
      if (s.note) line(s.note)
    } else {
      line(s.title)
      line(s.text)
    }
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${fileBase}.csv"`)
  res.send('﻿' + lines.join('\r\n'))
}
