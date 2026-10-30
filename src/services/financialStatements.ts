import { roundMoney as regionalRoundMoney } from '../utils/money'
import { prisma } from '../config'
import { fiscalYearStartFor } from '../utils/fiscalYear'

// Account balances and their IFRS presentation (IAS 1 / IAS 7) for the
// financial statements. Everything comes from posted journal lines, so the
// statements always agree with the trial balance and the general ledger.

const DAY = 86_400_000
const round2 = (n: number) => regionalRoundMoney(n)

export interface StatementAccount {
  id: string
  code: string
  name: string
  accountClass: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
  reportingGroup: string | null
  normalBalance: 'DEBIT' | 'CREDIT'
  ancestors: string[] // parent names, nearest first
}

export interface Range { from?: Date; to?: Date } // inclusive calendar dates

// debit − credit per account for posted entries in a date range
export async function netByAccount(organizationId: string, range: Range, branchId?: string): Promise<Map<string, { debit: number; credit: number }>> {
  const entryDate: Record<string, Date> = {}
  if (range.from) entryDate.gte = range.from
  // through the end of the last day: some entries (reversals) carry a time
  if (range.to) entryDate.lt = new Date(range.to.getTime() + DAY)
  const rows = await prisma.journalLine.groupBy({
    by: ['accountId'],
    where: { journalEntry: { organizationId, status: 'posted', ...(branchId && { branchId }), ...(Object.keys(entryDate).length && { entryDate }) } },
    _sum: { debitAmount: true, creditAmount: true },
  })
  return new Map(rows.map((r) => [r.accountId, { debit: Number(r._sum.debitAmount ?? 0), credit: Number(r._sum.creditAmount ?? 0) }]))
}

export async function statementAccounts(organizationId: string): Promise<StatementAccount[]> {
  const all = await prisma.account.findMany({
    where: { organizationId },
    select: { id: true, code: true, name: true, accountClass: true, reportingGroup: true, normalBalance: true, parentId: true, status: true },
    orderBy: { code: 'asc' },
  })
  const byId = new Map(all.map((a) => [a.id, a]))
  return all.map((a) => {
    const ancestors: string[] = []
    let p = a.parentId ? byId.get(a.parentId) : undefined
    for (let guard = 0; p && guard < 10; guard++) { ancestors.push(p.name); p = p.parentId ? byId.get(p.parentId) : undefined }
    return { id: a.id, code: a.code, name: a.name, accountClass: a.accountClass as StatementAccount['accountClass'], reportingGroup: a.reportingGroup, normalBalance: a.normalBalance as 'DEBIT' | 'CREDIT', ancestors }
  })
}

// Balance in the account's normal direction (assets/expenses debit-positive,
// liabilities/equity/revenue credit-positive)
export const normal = (a: StatementAccount, s?: { debit: number; credit: number }) =>
  s ? (a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit) : 0

// ── Classification ──────────────────────────────────────────────────────────
// By reporting group first, then by the parent account's name, so a custom
// chart works as long as it follows the usual structure.

const has = (a: StatementAccount, re: RegExp) => re.test(a.reportingGroup ?? '') || a.ancestors.some((n) => re.test(n)) || re.test(a.name)

export const isCash = (a: StatementAccount) => a.accountClass === 'ASSET' && /^(cash|bank|cash and cash equivalents)$/i.test(a.reportingGroup ?? '')
export const isAccumulatedDepreciation = (a: StatementAccount) => a.accountClass === 'ASSET' && /accumulated (depreciation|amortisation|amortization)/i.test(`${a.reportingGroup ?? ''} ${a.name}`)
export const isNonCurrentAsset = (a: StatementAccount) => a.accountClass === 'ASSET' && !isCash(a)
  && (isAccumulatedDepreciation(a) || has(a, /fixed asset|non-current|property|plant and equipment|intangible|long-term investment|right-of-use/i))
export const isNonCurrentLiability = (a: StatementAccount) => a.accountClass === 'LIABILITY'
  && !/current liabilit/i.test(a.reportingGroup ?? '') && !a.ancestors.some((n) => /^current liabilit/i.test(n))
  && has(a, /^loans?$|long-term|non-current|lease liabilit|loans payable/i)

export const COST_OF_SALES = /^(cost of sales|wastage|direct costs?)$/i
export type PnlGroup = 'revenue' | 'discounts' | 'other_income' | 'cost_of_sales' | 'operating' | 'finance' | 'income_tax'
export function pnlGroup(a: StatementAccount): PnlGroup {
  const g = a.reportingGroup ?? ''
  if (a.accountClass === 'REVENUE') return /other income/i.test(g) ? 'other_income' : /discount|return/i.test(g) ? 'discounts' : 'revenue'
  if (COST_OF_SALES.test(g) || a.ancestors.some((n) => /^cost of sales$/i.test(n))) return 'cost_of_sales'
  if (/finance cost|interest/i.test(`${g} ${a.name}`)) return 'finance'
  if (/income tax|taxation/i.test(`${g} ${a.name}`)) return 'income_tax'
  return 'operating'
}

export const isRetainedEarnings = (a: StatementAccount) => a.accountClass === 'EQUITY' && /retained earnings|current year earnings/i.test(`${a.reportingGroup ?? ''} ${a.name}`)

// ── Period maths ────────────────────────────────────────────────────────────

export const dayBefore = (d: Date) => new Date(d.getTime() - DAY)

// The equally long period that ends the day before `from`
export function priorPeriod(from: Date, to: Date): { from: Date; to: Date } {
  const length = Math.round((to.getTime() - from.getTime()) / DAY)
  const prevTo = dayBefore(from)
  return { from: new Date(prevTo.getTime() - length * DAY), to: prevTo }
}

// Profit (revenue − expenses) for a range
export function profitOf(accounts: StatementAccount[], sums: Map<string, { debit: number; credit: number }>): number {
  let p = 0
  for (const a of accounts) {
    const s = sums.get(a.id)
    if (!s) continue
    if (a.accountClass === 'REVENUE') p += s.credit - s.debit
    else if (a.accountClass === 'EXPENSE') p -= s.debit - s.credit
  }
  return round2(p)
}

// Position at a date: balance-sheet balances, plus profit split into the
// current fiscal year (shown as profit for the year) and earlier years
// (rolled into retained earnings — there is no year-end closing entry).
export async function positionAt(organizationId: string, asOf: Date, fiscalYearStart: string, accounts: StatementAccount[], branchId?: string) {
  const fyStart = fiscalYearStartFor(asOf, fiscalYearStart)
  const [cumulative, thisYear] = await Promise.all([
    netByAccount(organizationId, { to: asOf }, branchId),
    netByAccount(organizationId, { from: fyStart, to: asOf }, branchId),
  ])
  const profitThisYear = profitOf(accounts, thisYear)
  const profitEarlier = round2(profitOf(accounts, cumulative) - profitThisYear)
  return { fyStart, cumulative, profitThisYear, profitEarlier }
}

// ── Statement of financial position ─────────────────────────────────────────

export interface PositionLine { code: string; name: string; amount: number }
export interface Position {
  nonCurrentAssets: PositionLine[]
  currentAssets: PositionLine[]
  equity: PositionLine[]
  nonCurrentLiabilities: PositionLine[]
  currentLiabilities: PositionLine[]
  totals: { nonCurrentAssets: number; currentAssets: number; assets: number; equity: number; nonCurrentLiabilities: number; currentLiabilities: number; liabilities: number; equityAndLiabilities: number }
  profitThisYear: number
  fyStart: Date
}

export async function financialPosition(organizationId: string, asOf: Date, fiscalYearStart: string, accounts: StatementAccount[], branchId?: string): Promise<Position> {
  const { fyStart, cumulative, profitThisYear, profitEarlier } = await positionAt(organizationId, asOf, fiscalYearStart, accounts, branchId)
  const out: Omit<Position, 'totals' | 'profitThisYear' | 'fyStart'> = { nonCurrentAssets: [], currentAssets: [], equity: [], nonCurrentLiabilities: [], currentLiabilities: [] }
  let retained = profitEarlier
  for (const a of accounts) {
    const bal = round2(normal(a, cumulative.get(a.id)))
    if (Math.abs(bal) < 0.005 && !isRetainedEarnings(a)) continue
    const line = { code: a.code, name: a.name, amount: bal }
    if (a.accountClass === 'ASSET') {
      // an overdrawn bank account is a liability, not a negative asset
      if (isCash(a) && bal < 0) out.currentLiabilities.push({ code: a.code, name: `Bank overdraft — ${a.name}`, amount: -bal })
      else (isNonCurrentAsset(a) ? out.nonCurrentAssets : out.currentAssets).push(line)
    } else if (a.accountClass === 'LIABILITY') {
      (isNonCurrentLiability(a) ? out.nonCurrentLiabilities : out.currentLiabilities).push(line)
    } else if (a.accountClass === 'EQUITY') {
      if (isRetainedEarnings(a)) retained += bal
      else out.equity.push(line)
    }
  }
  out.equity.push({ code: '', name: 'Retained earnings', amount: round2(retained) })
  out.equity.push({ code: '', name: 'Profit for the year to date', amount: profitThisYear })
  const t = (l: PositionLine[]) => round2(l.reduce((s, x) => s + x.amount, 0))
  const totals = {
    nonCurrentAssets: t(out.nonCurrentAssets), currentAssets: t(out.currentAssets),
    equity: t(out.equity), nonCurrentLiabilities: t(out.nonCurrentLiabilities), currentLiabilities: t(out.currentLiabilities),
    assets: 0, liabilities: 0, equityAndLiabilities: 0,
  }
  totals.assets = round2(totals.nonCurrentAssets + totals.currentAssets)
  totals.liabilities = round2(totals.nonCurrentLiabilities + totals.currentLiabilities)
  totals.equityAndLiabilities = round2(totals.equity + totals.liabilities)
  return { ...out, totals, profitThisYear, fyStart }
}

// ── Cash flows (indirect method) ────────────────────────────────────────────

export interface CashFlowLine { code: string; name: string; amount: number }
export interface CashFlows {
  profit: number
  adjustments: CashFlowLine[]
  workingCapital: CashFlowLine[]
  investing: CashFlowLine[]
  financing: CashFlowLine[]
  operatingTotal: number
  investingTotal: number
  financingTotal: number
  netChange: number
  openingCash: number
  closingCash: number
}

// Every balance-sheet movement in the period is placed in exactly one
// activity, so opening cash + net change always equals closing cash.
export async function cashFlows(organizationId: string, from: Date, to: Date, accounts: StatementAccount[], branchId?: string): Promise<CashFlows> {
  const [opening, movement] = await Promise.all([
    netByAccount(organizationId, { to: dayBefore(from) }, branchId),
    netByAccount(organizationId, { from, to }, branchId),
  ])
  const profit = profitOf(accounts, movement)
  const out: CashFlows = { profit, adjustments: [], workingCapital: [], investing: [], financing: [], operatingTotal: 0, investingTotal: 0, financingTotal: 0, netChange: 0, openingCash: 0, closingCash: 0 }
  for (const a of accounts) {
    if (!['ASSET', 'LIABILITY', 'EQUITY'].includes(a.accountClass)) continue
    const o = opening.get(a.id), m = movement.get(a.id)
    const openDr = o ? o.debit - o.credit : 0
    const moveDr = m ? m.debit - m.credit : 0
    if (isCash(a)) { out.openingCash += openDr; out.closingCash += openDr + moveDr; continue }
    if (Math.abs(moveDr) < 0.005) continue
    const effect = round2(-moveDr) // a debit increase in a non-cash account used cash
    if (a.accountClass === 'ASSET') {
      if (isAccumulatedDepreciation(a)) out.adjustments.push({ code: a.code, name: `Depreciation and amortisation (${a.name})`, amount: effect })
      else if (isNonCurrentAsset(a)) out.investing.push({ code: a.code, name: `${effect < 0 ? 'Purchase' : 'Disposal'} of ${a.name}`, amount: effect })
      else out.workingCapital.push({ code: a.code, name: `${effect < 0 ? 'Increase' : 'Decrease'} in ${a.name}`, amount: effect })
    } else if (a.accountClass === 'LIABILITY') {
      if (isNonCurrentLiability(a)) out.financing.push({ code: a.code, name: `${effect > 0 ? 'Proceeds from' : 'Repayment of'} ${a.name}`, amount: effect })
      else out.workingCapital.push({ code: a.code, name: `${effect > 0 ? 'Increase' : 'Decrease'} in ${a.name}`, amount: effect })
    } else {
      out.financing.push({ code: a.code, name: /drawing|dividend|distribution/i.test(a.name) ? `${a.name} paid` : `${effect >= 0 ? 'Capital introduced' : 'Capital withdrawn'} — ${a.name}`, amount: effect })
    }
  }
  const t = (l: CashFlowLine[]) => round2(l.reduce((s, x) => s + x.amount, 0))
  out.operatingTotal = round2(profit + t(out.adjustments) + t(out.workingCapital))
  out.investingTotal = t(out.investing)
  out.financingTotal = t(out.financing)
  out.netChange = round2(out.operatingTotal + out.investingTotal + out.financingTotal)
  out.openingCash = round2(out.openingCash)
  out.closingCash = round2(out.closingCash)
  return out
}
