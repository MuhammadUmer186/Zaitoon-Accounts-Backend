import { AsyncLocalStorage } from 'node:async_hooks'
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config'
import { currencyDecimals, DateFormat, DATE_FORMATS, isValidLocale } from './regions'
import { isValidTimezone } from './menu'

// One formatting context per request, taken from the organization's regional
// settings (Settings → Regional). Every report renderer — screen JSON, PDF,
// Excel and CSV — formats through these helpers, so an amount, a date or a
// time reads the same wherever the report is opened.

export interface FormatContext {
  locale: string
  currency: string
  decimals: number
  dateFormat: DateFormat
  timezone: string
  taxLabel: string
  preparedBy?: string
}

export const DEFAULT_FORMAT: FormatContext = {
  locale: 'en-PK', currency: 'PKR', decimals: 2, dateFormat: 'DD MMM YYYY', timezone: 'Asia/Karachi', taxLabel: 'Sales Tax',
}

const store = new AsyncLocalStorage<FormatContext>()

export const currentFormat = (): FormatContext => store.getStore() ?? DEFAULT_FORMAT
export const runWithFormat = <T>(ctx: FormatContext, fn: () => T): T => store.run(ctx, fn)

export async function formatContextFor(organizationId: string, userId?: string): Promise<FormatContext> {
  const [org, user] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { currency: true, locale: true, dateFormat: true, timezone: true, taxLabel: true } }),
    userId ? prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } }) : null,
  ])
  const currency = org?.currency || DEFAULT_FORMAT.currency
  return {
    locale: org?.locale && isValidLocale(org.locale) ? org.locale : DEFAULT_FORMAT.locale,
    currency,
    decimals: currencyDecimals(currency),
    dateFormat: (DATE_FORMATS as readonly string[]).includes(org?.dateFormat ?? '') ? (org!.dateFormat as DateFormat) : DEFAULT_FORMAT.dateFormat,
    timezone: org?.timezone && isValidTimezone(org.timezone) ? org.timezone : DEFAULT_FORMAT.timezone,
    taxLabel: org?.taxLabel?.trim() || DEFAULT_FORMAT.taxLabel,
    preparedBy: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email : undefined,
  }
}

// Router middleware: every report request runs inside its org's context
export async function withReportFormat(req: Request, _res: Response, next: NextFunction) {
  try {
    const ctx = await formatContextFor(req.user.organizationId, req.user.id)
    store.run(ctx, () => next())
  } catch (err) {
    next(err)
  }
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const nf = new Map<string, Intl.NumberFormat>()
function numberFormat(locale: string, min: number, max: number) {
  const key = `${locale}|${min}|${max}`
  let f = nf.get(key)
  if (!f) { f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true }); nf.set(key, f) }
  return f
}

// Negative amounts read "-1,234.00", or "(1,234.00)" in accounting style
// (financial statements). A plain hyphen keeps PDF fonts happy.
export function formatMoney(n: number, accounting = false, ctx = currentFormat()): string {
  const v = Math.abs(n) < 0.5 * 10 ** -ctx.decimals ? 0 : n
  if (accounting && v === 0) return '–' // accounting style shows a nil amount as a dash
  const text = numberFormat(ctx.locale, ctx.decimals, ctx.decimals).format(Math.abs(v))
  if (v >= 0) return text
  return accounting ? `(${text})` : `-${text}`
}

export const formatNumber = (n: number, maxDigits = 3, ctx = currentFormat()) => numberFormat(ctx.locale, 0, maxDigits).format(n).replace('−', '-')
export const formatInteger = (n: number, ctx = currentFormat()) => numberFormat(ctx.locale, 0, 0).format(Math.round(n)).replace('−', '-')
export const formatPercent = (n: number, ctx = currentFormat()) => `${numberFormat(ctx.locale, 1, 1).format(n).replace('−', '-')}%`

// ── Dates ───────────────────────────────────────────────────────────────────
// Calendar dates (sale date, expense date, as-of date) are stored as midnight
// UTC of that date and are shown as-is. Moments (audit log, generated at) are
// shown in the organization's time zone.

const pad = (n: number) => String(n).padStart(2, '0')

export interface DateParts { y: number; m: number; d: number; hh: number; mm: number }

export function zonedParts(date: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour') % 24, mm: get('minute') }
}

const utcParts = (date: Date): DateParts => ({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), hh: date.getUTCHours(), mm: date.getUTCMinutes() })

function writeDate(p: DateParts, fmt: DateFormat, locale: string): string {
  switch (fmt) {
    case 'DD/MM/YYYY': return `${pad(p.d)}/${pad(p.m)}/${p.y}`
    case 'MM/DD/YYYY': return `${pad(p.m)}/${pad(p.d)}/${p.y}`
    case 'YYYY-MM-DD': return `${p.y}-${pad(p.m)}-${pad(p.d)}`
    case 'DD.MM.YYYY': return `${pad(p.d)}.${pad(p.m)}.${p.y}`
    default: return `${pad(p.d)} ${new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)))} ${p.y}`
  }
}

const toDate = (v: Date | string): Date | null => {
  const d = v instanceof Date ? v : new Date(v)
  return isNaN(d.getTime()) ? null : d
}

export function formatDate(v: Date | string, ctx = currentFormat()): string {
  const d = toDate(v)
  return d ? writeDate(utcParts(d), ctx.dateFormat, ctx.locale) : String(v)
}

export function formatDateTime(v: Date | string, ctx = currentFormat()): string {
  const d = toDate(v)
  if (!d) return String(v)
  const p = zonedParts(d, ctx.timezone)
  return `${writeDate(p, ctx.dateFormat, ctx.locale)} ${pad(p.hh)}:${pad(p.mm)}`
}

// "August 2026" for a YYYY-MM key
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ISO forms for CSV (machine-readable, unambiguous)
export const isoDate = (v: Date | string) => { const d = toDate(v); return d ? d.toISOString().slice(0, 10) : String(v) }
export function isoDateTime(v: Date | string, ctx = currentFormat()) {
  const d = toDate(v)
  if (!d) return String(v)
  const p = zonedParts(d, ctx.timezone)
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)}`
}

// A moment as an Excel date showing the organization's wall-clock time
// (Excel dates carry no time zone)
export function excelLocalDateTime(v: Date | string, ctx = currentFormat()): Date | null {
  const d = toDate(v)
  if (!d) return null
  const p = zonedParts(d, ctx.timezone)
  return new Date(Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm))
}

export function excelDateFormat(ctx = currentFormat(), withTime = false): string {
  const base = { 'DD MMM YYYY': 'dd mmm yyyy', 'DD/MM/YYYY': 'dd/mm/yyyy', 'MM/DD/YYYY': 'mm/dd/yyyy', 'YYYY-MM-DD': 'yyyy-mm-dd', 'DD.MM.YYYY': 'dd.mm.yyyy' }[ctx.dateFormat]
  return withTime ? `${base} hh:mm` : base
}

export function excelMoneyFormat(accounting: boolean, ctx = currentFormat()): string {
  const n = ctx.decimals > 0 ? `#,##0.${'0'.repeat(ctx.decimals)}` : '#,##0'
  return accounting ? `${n}_);(${n});"-"_)` : `${n};-${n}`
}

// Today's calendar date in the organization's time zone, as midnight UTC
export function todayInZone(ctx = currentFormat()): Date {
  const p = zonedParts(new Date(), ctx.timezone)
  return new Date(Date.UTC(p.y, p.m - 1, p.d))
}

// "Sales Tax", "VAT", "GST" … for labels: tax('collected') -> "Sales Tax collected"
export const tax = (rest = '') => `${currentFormat().taxLabel}${rest ? ` ${rest}` : ''}`

// The instant a calendar day (YYYY-MM-DD) starts in the organization's zone
export function zonedDayStart(ymd: string, ctx = currentFormat()): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const offsetAt = (t: number) => { const p = zonedParts(new Date(t), ctx.timezone); return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm) - t }
  let start = guess - offsetAt(guess)
  start = guess - offsetAt(start) // second pass settles a DST change
  return new Date(start)
}

// Filter for timestamps (createdAt, closedAt …) covering whole local days
export function momentRange(fromDate?: string, toDate?: string, ctx = currentFormat()): { gte?: Date; lt?: Date } | undefined {
  const ok = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v)
  if (!ok(fromDate) && !ok(toDate)) return undefined
  const next = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
  return {
    ...(ok(fromDate) && { gte: zonedDayStart(fromDate!, ctx) }),
    ...(ok(toDate) && { lt: zonedDayStart(next(toDate!), ctx) }),
  }
}
