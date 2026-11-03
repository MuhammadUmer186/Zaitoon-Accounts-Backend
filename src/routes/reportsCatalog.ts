import { moneyTolerance as regionalMoneyTolerance } from '../utils/money'
import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { withReportingScope } from '../middleware/reportScope'
import { withReportFormat, momentRange, formatPercent, formatDate, formatMoney, formatNumber, tax, todayInZone } from '../utils/reportFormat'
import {
  StatementAccount, PnlGroup, PositionLine, CashFlowLine, statementAccounts, netByAccount, pnlGroup, priorPeriod, dayBefore,
  financialPosition, cashFlows,
} from '../services/financialStatements'
import { requireModule, requirePermission } from '../middleware/authorize'
import { fiscalYearStartFor } from '../utils/fiscalYear'
import {
  ProReport, ReportRow, ReportSection, ReportColumn, sendProReport, reportScope, periodLabelFor,
  monthKey, monthLabel, pct, plural, round2, fmtMoney,
} from '../utils/proReport'

// Mounted at the same /reports prefix as reports.ts — the report catalog
// shown on the Reports page (daily-sales, branch-sales, branch-profit,
// cash-closing, expenses, purchases, supplier-payable, inventory-stock,
// wastage, audit-log, profit-loss, trial-balance, balance-sheet,
// vat-summary). general-ledger and dashboard/dashboard-v2 live in reports.ts.
//
// Every report here is a ProReport (utils/proReport.ts): headline KPIs plus
// summary tables, status counts, notes and a transaction register. The JSON
// response is { report, ...legacy fields }; ?format=pdf|excel|csv renders
// the same report as a designed PDF, a formatted workbook, or CSV.

const router = Router()
router.use(authenticate)
router.use(withReportingScope)
router.use(withReportFormat)
router.use(requireModule('reports'))

// Calendar-date fields (sale date, expense date, entry date): inclusive of
// the whole last day
function dateRangeFilter(fromDate?: string, toDate?: string) {
  if (!fromDate && !toDate) return undefined
  return {
    ...(fromDate && { gte: new Date(fromDate) }),
    ...(toDate && { lt: new Date(new Date(toDate).getTime() + 86_400_000) }),
  }
}

const asOfLabel = (toDate?: string) => (toDate ? toDate : new Date().toISOString().slice(0, 10))

// an approved bill that has not been paid yet
const BILL_STATUS = { approved: 'Unpaid' }

const sum = <T>(rows: T[], pick: (r: T) => number) => round2(rows.reduce((s, r) => s + (pick(r) || 0), 0))

async function baseReport(req: Request, key: string, eyebrow: string, headline: string, dates: Date[] = []) {
  const { branchId, fromDate, toDate } = req.query as Record<string, string>
  const scope = await reportScope(prisma, req.user.organizationId, branchId || undefined)
  return {
    key,
    eyebrow,
    headline,
    ...scope,
    periodLabel: periodLabelFor(fromDate, toDate, dates),
    generatedAt: new Date().toISOString(),
  }
}

// Groups rows by month (oldest first) and sums the given fields.
function monthlyRows<T>(items: T[], dateOf: (t: T) => Date, fields: Record<string, (t: T) => number>) {
  const map = new Map<string, Record<string, number>>()
  for (const it of items) {
    const k = monthKey(dateOf(it))
    const acc = map.get(k) ?? Object.fromEntries([['count', 0], ...Object.keys(fields).map((f) => [f, 0])])
    acc.count += 1
    for (const [f, pick] of Object.entries(fields)) acc[f] += pick(it) || 0
    map.set(k, acc)
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => {
    const row: ReportRow = { month: monthLabel(k) }
    for (const [f, n] of Object.entries(v)) row[f] = f === 'count' ? n : round2(n)
    return row
  })
}

function totalsOf(rows: ReportRow[], label: string, keys: string[], firstKey: string): ReportRow {
  const t: ReportRow = { [firstKey]: label }
  for (const k of keys) t[k] = round2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0))
  return t
}

// ── Daily Sales ─────────────────────────────────────────────────────────────

router.get('/daily-sales', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const saleDate = dateRangeFilter(fromDate, toDate)

  const sales = await prisma.dailySale.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(saleDate && { saleDate }) },
    include: { branch: { select: { name: true } } },
    orderBy: { saleDate: 'desc' },
  })

  const net = sum(sales, (s) => s.netAmount)
  const vat = sum(sales, (s) => s.vatAmount)
  const gross = sum(sales, (s) => s.totalAmount)
  const days = new Set(sales.map((s) => s.saleDate.toISOString().slice(0, 10))).size
  const branchCount = new Set(sales.map((s) => s.branchId)).size

  const mix = [
    { method: 'Cash', amount: sum(sales, (s) => s.cashAmount) },
    { method: 'Card', amount: sum(sales, (s) => s.cardAmount) },
    { method: 'Delivery apps', amount: sum(sales, (s) => s.deliveryAmount) },
    { method: 'Bank transfer', amount: sum(sales, (s) => s.bankTransferAmount) },
    { method: 'Other', amount: sum(sales, (s) => s.otherAmount) },
  ]
  const mixTotal = sum(mix, (m) => m.amount)
  const mixRows: ReportRow[] = mix.filter((m) => m.amount > 0).map((m) => ({ ...m, share: pct(m.amount, mixTotal) }))

  const monthly = monthlyRows(sales, (s) => s.saleDate, {
    cash: (s) => s.cashAmount, card: (s) => s.cardAmount, delivery: (s) => s.deliveryAmount,
    other: (s) => s.bankTransferAmount + s.otherAmount, vat: (s) => s.vatAmount, net: (s) => s.netAmount,
  })

  const byBranch = new Map<string, { branch: string; count: number; net: number; vat: number }>()
  for (const s of sales) {
    const b = byBranch.get(s.branchId) ?? { branch: s.branch.name, count: 0, net: 0, vat: 0 }
    b.count++; b.net += s.netAmount; b.vat += s.vatAmount
    byBranch.set(s.branchId, b)
  }
  const branchRows: ReportRow[] = [...byBranch.values()].sort((a, b) => b.net - a.net)
    .map((b) => ({ branch: b.branch, count: b.count, net: round2(b.net), vat: round2(b.vat), share: pct(b.net, net) }))

  const register: ReportRow[] = sales.map((s) => ({
    saleNo: s.saleNo, date: s.saleDate.toISOString(), branch: s.branch.name,
    cash: s.cashAmount, card: s.cardAmount, delivery: s.deliveryAmount, other: round2(s.bankTransferAmount + s.otherAmount),
    vat: s.vatAmount, net: s.netAmount, status: s.status,
  }))
  const moneyKeys = ['cash', 'card', 'delivery', 'other', 'vat', 'net']

  const sections: ReportSection[] = [
    {
      type: 'table', id: 'monthly', title: 'Monthly sales summary',
      columns: [
        { key: 'month', label: 'Month' }, { key: 'count', label: 'Sales', format: 'integer' },
        { key: 'cash', label: 'Cash', format: 'money' }, { key: 'card', label: 'Card', format: 'money' },
        { key: 'delivery', label: 'Delivery', format: 'money' }, { key: 'other', label: 'Transfer / Other', format: 'money' },
        { key: 'vat', label: tax(), format: 'money' }, { key: 'net', label: 'Net sales', format: 'money' },
      ],
      rows: monthly,
      totals: totalsOf(monthly, 'TOTAL', ['count', ...moneyKeys], 'month'),
    },
    {
      type: 'table', id: 'mix', title: 'Payment mix',
      columns: [{ key: 'method', label: 'Payment method' }, { key: 'amount', label: 'Amount', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' }],
      rows: mixRows,
      totals: { method: 'TOTAL', amount: mixTotal, share: mixTotal > 0 ? 100 : 0 },
    },
    ...(byBranch.size > 1 ? [{
      type: 'table' as const, id: 'branches', title: 'Branch summary', subtitle: 'Ranked by net sales',
      columns: [
        { key: 'branch', label: 'Branch' }, { key: 'count', label: 'Sales', format: 'integer' as const },
        { key: 'vat', label: tax(), format: 'money' as const }, { key: 'net', label: 'Net sales', format: 'money' as const },
        { key: 'share', label: 'Share', format: 'percent' as const },
      ],
      rows: branchRows,
      totals: { branch: 'TOTAL', count: sales.length, vat, net, share: net > 0 ? 100 : 0 },
    }] : []),
    {
      type: 'table', id: 'register', title: 'Sales register', subtitle: 'Latest date first', register: true, primary: true,
      columns: [
        { key: 'saleNo', label: 'Sale no.', format: 'code' }, { key: 'date', label: 'Date', format: 'date' },
        ...(branchCount > 1 || !branchId ? [{ key: 'branch', label: 'Branch' } as ReportColumn] : []),
        { key: 'cash', label: 'Cash', format: 'money' }, { key: 'card', label: 'Card', format: 'money' },
        { key: 'delivery', label: 'Delivery', format: 'money' }, { key: 'other', label: 'Transfer / Other', format: 'money' },
        { key: 'vat', label: tax(), format: 'money' }, { key: 'net', label: 'Net sales', format: 'money' },
        { key: 'status', label: 'Status', format: 'status', statusLabels: { approved: 'Posted' } },
      ],
      rows: register,
      totals: totalsOf(register, 'TOTAL', moneyKeys, 'saleNo'),
    },
  ]

  const report: ProReport = {
    ...(await baseReport(req, 'daily-sales', 'Sales Report', 'Sales at a glance', sales.map((s) => s.saleDate))),
    summaryLine: '',
    kpis: [
      { label: 'Net sales', value: net, hint: `Incl. ${tax()} · ${plural(sales.length, 'sale')} over ${plural(days, 'day')}` },
      { label: tax('collected'), value: vat, hint: `${formatPercent(pct(vat, gross))} of gross sales` },
      { label: 'Average per day', value: days > 0 ? round2(net / days) : 0, hint: 'Net sales ÷ trading days' },
      { label: 'Gross sales', value: gross, hint: `Including ${tax()}`, tone: 'dark' },
    ],
    sections,
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(sales.length, 'sale')}  |  ${plural(days, 'trading day')}  |  ${plural(branchCount, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: register })
})

// ── Branch Sales Comparison ─────────────────────────────────────────────────

router.get('/branch-sales', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const saleDate = dateRangeFilter(fromDate, toDate)

  const branches = await prisma.branch.findMany({
    where: { organizationId: orgId, isActive: true, ...(branchId && { id: branchId }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const rows = await Promise.all(
    branches.map(async (b) => {
      const agg = await prisma.dailySale.aggregate({
        where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(saleDate && { saleDate }) },
        _sum: { netAmount: true, vatAmount: true, totalAmount: true },
        _count: true,
      })
      const totalSales = agg._sum.netAmount ?? 0
      return {
        branch: b.name,
        saleCount: agg._count,
        totalSales: round2(totalSales),
        totalVat: round2(agg._sum.vatAmount ?? 0),
        grossSales: round2(agg._sum.totalAmount ?? 0),
        avgSaleValue: agg._count > 0 ? round2(totalSales / agg._count) : 0,
      }
    })
  )
  rows.sort((a, b) => b.totalSales - a.totalSales)
  const total = sum(rows, (r) => r.totalSales)
  const ranked: ReportRow[] = rows.map((r, i) => ({ rank: i + 1, ...r, share: pct(r.totalSales, total) }))
  const top = rows[0]

  const report: ProReport = {
    ...(await baseReport(req, 'branch-sales', 'Branch Sales Comparison', 'Branch performance')),
    summaryLine: '',
    kpis: [
      { label: 'Total net sales', value: total, hint: `Across ${plural(rows.length, 'branch', 'branches')}` },
      { label: 'Sales count', value: sum(rows, (r) => r.saleCount), format: 'integer', hint: 'Recorded daily sales' },
      { label: 'Average per branch', value: rows.length ? round2(total / rows.length) : 0, hint: 'Net sales ÷ branches' },
      { label: 'Top branch', value: top && top.totalSales > 0 ? top.branch : '—', format: 'text', hint: top && top.totalSales > 0 ? `${fmtMoney(top.totalSales)} · ${formatPercent(pct(top.totalSales, total))} share` : 'No sales in period', tone: 'dark' },
    ],
    sections: [{
      type: 'table', id: 'branches', title: 'Branch ranking', subtitle: 'Ranked by net sales, highest first', primary: true,
      columns: [
        { key: 'rank', label: '#', format: 'integer', width: 0.4 }, { key: 'branch', label: 'Branch' },
        { key: 'saleCount', label: 'Sales', format: 'integer' }, { key: 'avgSaleValue', label: 'Avg sale', format: 'money' },
        { key: 'totalVat', label: tax(), format: 'money' }, { key: 'grossSales', label: 'Gross sales', format: 'money' },
        { key: 'totalSales', label: 'Net sales', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' },
      ],
      rows: ranked,
      totals: { branch: 'TOTAL', saleCount: sum(rows, (r) => r.saleCount), totalVat: sum(rows, (r) => r.totalVat), grossSales: sum(rows, (r) => r.grossSales), totalSales: total, share: total > 0 ? 100 : 0 },
    }],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(rows.length, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: rows })
})

// ── Branch Profit ───────────────────────────────────────────────────────────

router.get('/branch-profit', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const saleDate = dateRangeFilter(fromDate, toDate)
  const expenseDate = dateRangeFilter(fromDate, toDate)

  const branches = await prisma.branch.findMany({
    where: { organizationId: orgId, isActive: true, ...(branchId && { id: branchId }) },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  const rows = await Promise.all(
    branches.map(async (b) => {
      const [salesAgg, expAgg, billsAgg] = await Promise.all([
        prisma.dailySale.aggregate({
          where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(saleDate && { saleDate }) },
          _sum: { netAmount: true },
        }),
        prisma.expense.aggregate({
          where: { source: { not: 'purchasing' }, organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(expenseDate && { expenseDate }) },
          _sum: { totalAmount: true },
        }),
        // Supplier purchases count as expenses here too
        prisma.bill.aggregate({
          where: { organizationId: orgId, branchId: b.id, status: { not: 'void' }, ...(expenseDate && { billDate: expenseDate }) },
          _sum: { totalAmount: true },
        }),
      ])
      const totalSales = round2(salesAgg._sum.netAmount ?? 0)
      const operatingExpenses = round2(expAgg._sum.totalAmount ?? 0)
      const purchases = round2(billsAgg._sum.totalAmount ?? 0)
      const totalExpenses = round2(operatingExpenses + purchases)
      const profit = round2(totalSales - totalExpenses)
      return {
        branch: b.name,
        totalSales,
        purchases,
        operatingExpenses,
        totalExpenses,
        profit,
        profitMarginPct: totalSales > 0 ? Math.round((profit / totalSales) * 1000) / 10 : 0,
      }
    })
  )
  rows.sort((a, b) => b.profit - a.profit)
  const totSales = sum(rows, (r) => r.totalSales)
  const totExp = sum(rows, (r) => r.totalExpenses)
  const totProfit = round2(totSales - totExp)
  const lossMaking = rows.filter((r) => r.profit < 0).length

  const report: ProReport = {
    ...(await baseReport(req, 'branch-profit', 'Branch Profit Report', 'Profit by branch')),
    summaryLine: '',
    kpis: [
      { label: 'Net sales', value: totSales, hint: `${plural(rows.length, 'branch', 'branches')}` },
      { label: 'Total spend', value: totExp, hint: 'Purchases + operating expenses' },
      { label: 'Margin', value: totSales > 0 ? round2((totProfit / totSales) * 100) : 0, format: 'percent', hint: 'Profit ÷ net sales', tone: totProfit >= 0 ? 'positive' : 'negative' },
      { label: 'Profit', value: totProfit, hint: lossMaking ? `${plural(lossMaking, 'branch', 'branches')} at a loss` : 'All branches profitable', tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'branches', title: 'Branch profitability', subtitle: 'Ranked by profit, highest first', primary: true,
        columns: [
          { key: 'branch', label: 'Branch' }, { key: 'totalSales', label: 'Net sales', format: 'money' },
          { key: 'purchases', label: 'Purchases', format: 'money' }, { key: 'operatingExpenses', label: 'Operating exp.', format: 'money' },
          { key: 'totalExpenses', label: 'Total spend', format: 'money' }, { key: 'profit', label: 'Profit', format: 'money' },
          { key: 'profitMarginPct', label: 'Margin', format: 'percent' },
        ],
        rows,
        totals: { branch: 'TOTAL', totalSales: totSales, purchases: sum(rows, (r) => r.purchases), operatingExpenses: sum(rows, (r) => r.operatingExpenses), totalExpenses: totExp, profit: totProfit, profitMarginPct: totSales > 0 ? round2((totProfit / totSales) * 100) : 0 },
      },
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: 'Operational view: net sales from approved daily sales, minus supplier purchases (bills, including tax) and operating expenses. Payments made against purchases are not counted again. For the accounting view use the Profit & Loss statement, which is built from posted journal entries.' },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(rows.length, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: rows })
})

// ── Cash Closing ────────────────────────────────────────────────────────────

router.get('/cash-closing', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const closingDate = dateRangeFilter(fromDate, toDate)

  const closings = await prisma.cashClosing.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), ...(closingDate && { closingDate }) },
    include: { branch: { select: { name: true } } },
    orderBy: { closingDate: 'desc' },
  })

  const expected = sum(closings, (c) => c.expectedCash)
  const counted = sum(closings, (c) => c.actualCashCounted)
  const diff = sum(closings, (c) => c.difference)
  const over = closings.filter((c) => c.difference > 0.005)
  const short = closings.filter((c) => c.difference < -0.005)
  const balanced = closings.length - over.length - short.length

  const register: ReportRow[] = closings.map((c) => ({
    closingNo: c.closingNo, date: c.closingDate.toISOString(), branch: c.branch.name,
    openingCash: c.openingCash, cashSales: c.cashSales, cashOut: round2(c.cashExpensesPaid + c.cashDeposited + c.otherCashOut - c.otherCashIn),
    expectedCash: c.expectedCash, actualCashCounted: c.actualCashCounted, difference: c.difference,
    status: c.status,
  }))

  const report: ProReport = {
    ...(await baseReport(req, 'cash-closing', 'Cash Closing Report', 'Cash reconciliation', closings.map((c) => c.closingDate))),
    summaryLine: '',
    kpis: [
      { label: 'Expected cash', value: expected, hint: plural(closings.length, 'closing') },
      { label: 'Cash counted', value: counted, hint: `${formatPercent(pct(counted, expected))} of expected` },
      { label: 'Shortages', value: sum(short, (c) => c.difference), hint: plural(short.length, 'short day'), tone: short.length ? 'negative' : 'default' },
      { label: 'Net difference', value: diff, hint: diff > 0.005 ? 'Cash over' : diff < -0.005 ? 'Cash short' : 'Fully balanced', tone: 'dark' },
    ],
    sections: [
      {
        type: 'stats', id: 'outcome', title: 'Closing outcome',
        items: [
          { label: 'Balanced', value: balanced, tone: 'positive' },
          { label: 'Over', value: over.length, tone: over.length ? 'warning' : 'default' },
          { label: 'Short', value: short.length, tone: short.length ? 'negative' : 'default' },
          { label: 'Pending approval', value: closings.filter((c) => c.status === 'submitted').length },
        ],
        note: 'Over/short is counted cash minus expected cash for each closing.',
      },
      {
        type: 'table', id: 'register', title: 'Cash closing register', subtitle: 'Latest date first', register: true, primary: true,
        columns: [
          { key: 'closingNo', label: 'Closing no.', format: 'code' }, { key: 'date', label: 'Date', format: 'date' },
          { key: 'branch', label: 'Branch' }, { key: 'openingCash', label: 'Opening', format: 'money' },
          { key: 'cashSales', label: 'Cash sales', format: 'money' }, { key: 'cashOut', label: 'Net cash out', format: 'money' },
          { key: 'expectedCash', label: 'Expected', format: 'money' }, { key: 'actualCashCounted', label: 'Counted', format: 'money' },
          { key: 'difference', label: 'Difference', format: 'money' }, { key: 'status', label: 'Status', format: 'status' },
        ],
        rows: register,
        totals: totalsOf(register, 'TOTAL', ['cashSales', 'cashOut', 'expectedCash', 'actualCashCounted', 'difference'], 'closingNo'),
      },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(closings.length, 'closing')}  |  ${plural(new Set(closings.map((c) => c.branchId)).size, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: register })
})

// ── Expenses ────────────────────────────────────────────────────────────────

router.get('/expenses', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const expenseDate = dateRangeFilter(fromDate, toDate)

  const expenses = await prisma.expense.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(expenseDate && { expenseDate }) },
    include: { branch: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: { expenseDate: 'desc' },
  })

  // Maintenance (picked as the "vendor" on New Entry) is reported apart from other operating expenses
  const manual = expenses.filter((e) => e.source !== 'purchasing' && e.source !== 'maintenance')
  const maintenance = expenses.filter((e) => e.source === 'maintenance')
  const purchasePayments = expenses.filter((e) => e.source === 'purchasing')
  const total = sum(expenses, (e) => e.totalAmount)
  const vat = sum(expenses, (e) => e.vatAmount)
  const pending = expenses.filter((e) => e.status === 'draft' || e.status === 'submitted')

  const monthly = monthlyRows(expenses, (e) => e.expenseDate, {
    operating: (e) => (e.source === 'purchasing' || e.source === 'maintenance' ? 0 : e.totalAmount),
    maintenance: (e) => (e.source === 'maintenance' ? e.totalAmount : 0),
    purchasePayments: (e) => (e.source === 'purchasing' ? e.totalAmount : 0),
    vat: (e) => e.vatAmount,
    total: (e) => e.totalAmount,
  })

  const byCat = new Map<string, { category: string; count: number; amount: number; vat: number; total: number }>()
  for (const e of expenses) {
    const c = byCat.get(e.categoryId) ?? { category: e.category.name, count: 0, amount: 0, vat: 0, total: 0 }
    c.count++; c.amount += e.amount; c.vat += e.vatAmount; c.total += e.totalAmount
    byCat.set(e.categoryId, c)
  }
  const catRows: ReportRow[] = [...byCat.values()].sort((a, b) => b.total - a.total)
    .map((c) => ({ category: c.category, count: c.count, amount: round2(c.amount), vat: round2(c.vat), total: round2(c.total), share: pct(c.total, total) }))
  const topCat = catRows[0]

  const register: ReportRow[] = expenses.map((e) => ({
    expenseNo: e.expenseNo, date: e.expenseDate.toISOString(), branch: e.branch.name, category: e.category.name,
    description: e.description, type: e.source === 'purchasing' ? 'Purchase payment' : e.source === 'maintenance' ? 'Maintenance' : 'Operating expense',
    paymentMethod: e.paymentMethod.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    amount: e.amount, vat: e.vatAmount, totalAmount: e.totalAmount, status: e.status,
  }))

  const report: ProReport = {
    ...(await baseReport(req, 'expenses', 'Expense Report', 'Expenses at a glance', expenses.map((e) => e.expenseDate))),
    summaryLine: '',
    kpis: [
      { label: 'Total expenses', value: total, hint: `Includes ${tax()} · ${plural(expenses.length, 'entry', 'entries')}` },
      { label: 'Other operating expenses', value: sum(manual, (e) => e.totalAmount), hint: `${formatPercent(pct(sum(manual, (e) => e.totalAmount), total))} · manual entries` },
      { label: 'Maintenance', value: sum(maintenance, (e) => e.totalAmount), hint: `${formatPercent(pct(sum(maintenance, (e) => e.totalAmount), total))} · ${plural(maintenance.length, 'entry', 'entries')}` },
      { label: 'Purchase payments', value: sum(purchasePayments, (e) => e.totalAmount), hint: `${plural(purchasePayments.length, 'payment')} against purchases` },
      { label: 'Top category', value: topCat ? String(topCat.category) : '—', format: 'text', hint: topCat ? `${fmtMoney(Number(topCat.total))} · ${formatPercent(Number(topCat.share))} of total` : 'No expenses in period', tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'monthly', title: 'Monthly expense summary',
        columns: [
          { key: 'month', label: 'Month' }, { key: 'count', label: 'Entries', format: 'integer' },
          { key: 'operating', label: 'Other operating', format: 'money' }, { key: 'maintenance', label: 'Maintenance', format: 'money' }, { key: 'purchasePayments', label: 'Purchase payments', format: 'money' },
          { key: 'vat', label: tax(), format: 'money' }, { key: 'total', label: 'Total', format: 'money' },
        ],
        rows: monthly,
        totals: totalsOf(monthly, 'TOTAL', ['count', 'operating', 'maintenance', 'purchasePayments', 'vat', 'total'], 'month'),
      },
      {
        type: 'stats', id: 'status', title: 'Approval status',
        items: [
          { label: 'Approved', value: expenses.filter((e) => e.status === 'approved').length, tone: 'positive' },
          { label: 'Submitted', value: expenses.filter((e) => e.status === 'submitted').length, tone: 'warning' },
          { label: 'Draft', value: expenses.filter((e) => e.status === 'draft').length },
        ],
        note: pending.length ? `${plural(pending.length, 'entry', 'entries')} (${fmtMoney(sum(pending, (e) => e.totalAmount))}) not yet approved — not posted to accounting.` : 'Every entry in this period is approved and posted.',
      },
      {
        type: 'table', id: 'categories', title: 'Category summary', subtitle: 'Ranked by total, highest first', newPage: true,
        columns: [
          { key: 'category', label: 'Category' }, { key: 'count', label: 'Entries', format: 'integer' },
          { key: 'amount', label: 'Net amount', format: 'money' }, { key: 'vat', label: tax(), format: 'money' },
          { key: 'total', label: 'Total', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' },
        ],
        rows: catRows,
        totals: { category: 'TOTAL', count: expenses.length, amount: sum(expenses, (e) => e.amount), vat, total, share: total > 0 ? 100 : 0 },
      },
      {
        type: 'table', id: 'register', title: 'Expense register', subtitle: 'Latest date first', register: true, primary: true,
        columns: [
          { key: 'expenseNo', label: 'Expense no.', format: 'code' }, { key: 'date', label: 'Date', format: 'date' },
          { key: 'category', label: 'Category', width: 1.3 }, { key: 'description', label: 'Description', width: 2.2 },
          { key: 'type', label: 'Type', width: 1.1 }, { key: 'paymentMethod', label: 'Method', width: 1 },
          { key: 'amount', label: 'Net', format: 'money' }, { key: 'vat', label: tax(), format: 'money' },
          { key: 'totalAmount', label: 'Total', format: 'money' }, { key: 'status', label: 'Status', format: 'status' },
        ],
        rows: register,
        totals: totalsOf(register, 'TOTAL', ['amount', 'vat', 'totalAmount'], 'expenseNo'),
      },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(expenses.length, 'entry', 'entries')}  |  ${plural(byCat.size, 'category', 'categories')}  |  ${plural(new Set(expenses.map((e) => e.branchId)).size, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: register })
})

// ── Purchases ───────────────────────────────────────────────────────────────

// Every supplier bill in the period (Purchasing entries, Purchase Order
// receipts, and manually created bills alike).
router.get('/purchases', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const billDate = dateRangeFilter(fromDate, toDate)

  const bills = await prisma.bill.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(billDate && { billDate }) },
    include: { supplier: { select: { name: true } }, branch: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: [{ billDate: 'desc' }, { billNo: 'desc' }],
  })

  const total = sum(bills, (b) => b.totalAmount)
  const paid = sum(bills, (b) => b.paidAmount)
  const balance = sum(bills, (b) => b.balanceDue)
  const supplierCount = new Set(bills.map((b) => b.supplierId)).size
  const branchCount = new Set(bills.map((b) => b.branchId)).size

  const monthly = monthlyRows(bills, (b) => b.billDate, {
    subtotal: (b) => b.subtotal, vat: (b) => b.vatAmount, total: (b) => b.totalAmount, paid: (b) => b.paidAmount, balance: (b) => b.balanceDue,
  })

  const bySupplier = new Map<string, { supplier: string; bills: number; total: number; paid: number; balance: number }>()
  for (const b of bills) {
    const s = bySupplier.get(b.supplierId) ?? { supplier: b.supplier.name, bills: 0, total: 0, paid: 0, balance: 0 }
    s.bills++; s.total += b.totalAmount; s.paid += b.paidAmount; s.balance += b.balanceDue
    bySupplier.set(b.supplierId, s)
  }
  const supplierRows: ReportRow[] = [...bySupplier.values()]
    .sort((a, b) => b.balance - a.balance || b.total - a.total)
    .map((s) => ({ supplier: s.supplier, bills: s.bills, total: round2(s.total), paid: round2(s.paid), balance: round2(s.balance) }))

  const byCategory = new Map<string, { category: string; bills: number; total: number; balance: number }>()
  for (const b of bills) {
    const key = b.categoryId ?? '__none'
    const c = byCategory.get(key) ?? { category: b.category?.name ?? 'Uncategorised', bills: 0, total: 0, balance: 0 }
    c.bills++; c.total += b.totalAmount; c.balance += b.balanceDue
    byCategory.set(key, c)
  }
  const categoryRows: ReportRow[] = [...byCategory.values()].sort((a, b) => b.total - a.total)
    .map((c) => ({ category: c.category, bills: c.bills, total: round2(c.total), balance: round2(c.balance), share: pct(c.total, total) }))

  const paidCount = bills.filter((b) => b.status === 'paid').length
  const partialCount = bills.filter((b) => b.status === 'partial').length
  const unpaidCount = bills.filter((b) => b.status === 'approved').length
  const draftCount = bills.filter((b) => b.status === 'draft').length

  // Reconciliation: every bill should satisfy subtotal + tax − discount = total
  // and total − paid = balance (to the cent).
  const mismatched = bills.filter((b) =>
    Math.abs(b.subtotal + b.vatAmount - b.discountAmount - b.totalAmount) > regionalMoneyTolerance() ||
    Math.abs(b.totalAmount - b.paidAmount - b.balanceDue) > regionalMoneyTolerance())
  const paidWithResidue = bills.filter((b) => b.status === 'paid' && Math.abs(b.balanceDue) >= 0.005)
  const reconText = [
    mismatched.length === 0
      ? `All ${plural(bills.length, 'purchase')} reconcile: subtotal + ${tax()} = total, and total − paid = balance.`
      : `${plural(mismatched.length, 'purchase')} do not reconcile (subtotal + ${tax()} ≠ total, or total − paid ≠ balance): ${mismatched.slice(0, 8).map((b) => b.billNo).join(', ')}${mismatched.length > 8 ? '…' : ''}.`,
    paidWithResidue.length ? `Marked paid with a residual balance: ${paidWithResidue.slice(0, 6).map((b) => `${b.billNo} (${fmtMoney(b.balanceDue)})`).join(', ')}.` : '',
    draftCount ? `${plural(draftCount, 'draft bill')} included — drafts are not yet posted to accounting.` : '',
  ].filter(Boolean).join(' ')

  const register: ReportRow[] = bills.map((b) => ({
    purchaseNo: b.billNo, date: b.billDate.toISOString(), supplier: b.supplier.name, branch: b.branch.name,
    category: b.category?.name ?? '—', subtotal: b.subtotal, vat: b.vatAmount, totalAmount: b.totalAmount,
    paidAmount: b.paidAmount, balanceDue: b.balanceDue, status: b.status,
  }))
  const showBranch = branchCount > 1

  const report: ProReport = {
    ...(await baseReport(req, 'purchases', 'Purchase Report', 'Purchases at a glance', bills.map((b) => b.billDate))),
    summaryLine: '',
    kpis: [
      { label: 'Total purchases', value: total, hint: `Includes ${tax()} · ${plural(bills.length, 'purchase')}` },
      { label: 'Amount paid', value: paid, hint: `${formatPercent(pct(paid, total))} of total purchase value` },
      { label: 'Balance due', value: balance, hint: `${formatPercent(pct(balance, total))} of total purchase value`, tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'monthly', title: 'Monthly purchase summary',
        columns: [
          { key: 'month', label: 'Month' }, { key: 'count', label: 'Purchases', format: 'integer' },
          { key: 'subtotal', label: 'Subtotal', format: 'money' }, { key: 'vat', label: tax(), format: 'money' },
          { key: 'total', label: 'Total amount', format: 'money' }, { key: 'paid', label: 'Paid amount', format: 'money' },
          { key: 'balance', label: 'Balance due', format: 'money' },
        ],
        rows: monthly,
        totals: totalsOf(monthly, 'TOTAL', ['count', 'subtotal', 'vat', 'total', 'paid', 'balance'], 'month'),
      },
      {
        type: 'stats', id: 'status', title: 'Payment status',
        items: [
          { label: 'Paid', value: paidCount, tone: 'positive' },
          { label: 'Partially paid', value: partialCount, tone: 'warning' },
          { label: 'Unpaid', value: unpaidCount, tone: unpaidCount ? 'negative' : 'default' },
          ...(draftCount ? [{ label: 'Draft', value: draftCount }] : []),
        ],
        note: unpaidCount ? `Unpaid purchases have no payments recorded yet (${fmtMoney(sum(bills.filter((b) => b.status === 'approved'), (b) => b.balanceDue))} outstanding).` : undefined,
      },
      { type: 'note', id: 'recon', title: 'Reconciliation note', text: reconText, tone: mismatched.length ? 'warning' : 'default' },
      {
        type: 'table', id: 'suppliers', title: 'Supplier summary', newPage: true,
        subtitle: `All ${plural(supplierCount, 'supplier')}  |  Ranked by balance due, highest first  |  Amounts include ${tax()}`,
        columns: [
          { key: 'supplier', label: 'Supplier', width: 3 }, { key: 'bills', label: 'Bills', format: 'integer' },
          { key: 'total', label: 'Total amount', format: 'money' }, { key: 'paid', label: 'Paid amount', format: 'money' },
          { key: 'balance', label: 'Balance due', format: 'money' },
        ],
        rows: supplierRows,
        totals: { supplier: 'TOTAL', bills: bills.length, total, paid, balance },
      },
      ...(byCategory.size > 1 || (byCategory.size === 1 && !byCategory.has('__none')) ? [{
        type: 'table' as const, id: 'categories', title: 'Category summary', subtitle: 'Ranked by total, highest first',
        columns: [
          { key: 'category', label: 'Category', width: 3 }, { key: 'bills', label: 'Bills', format: 'integer' as const },
          { key: 'total', label: 'Total amount', format: 'money' as const }, { key: 'balance', label: 'Balance due', format: 'money' as const },
          { key: 'share', label: 'Share', format: 'percent' as const },
        ],
        rows: categoryRows,
        totals: { category: 'TOTAL', bills: bills.length, total, balance, share: total > 0 ? 100 : 0 },
      }] : []),
      {
        type: 'table', id: 'register', title: 'Purchase register', register: true, primary: true,
        subtitle: '', // set below once the scope label is known
        columns: [
          { key: 'purchaseNo', label: 'Purchase no.', format: 'code' }, { key: 'date', label: 'Date', format: 'date' },
          { key: 'supplier', label: 'Supplier', width: 2.2 },
          ...(showBranch ? [{ key: 'branch', label: 'Branch', width: 1.3 } as ReportColumn] : []),
          { key: 'subtotal', label: 'Subtotal', format: 'money' }, { key: 'vat', label: tax(), format: 'money', width: 1 },
          { key: 'totalAmount', label: 'Total amount', format: 'money' }, { key: 'paidAmount', label: 'Paid amount', format: 'money' },
          { key: 'balanceDue', label: 'Balance due', format: 'money' }, { key: 'status', label: 'Status', format: 'status', statusLabels: BILL_STATUS },
        ],
        rows: register,
        totals: totalsOf(register, 'TOTAL', ['subtotal', 'vat', 'totalAmount', 'paidAmount', 'balanceDue'], 'purchaseNo'),
      },
    ],
  }
  report.editableName = 'Editable purchases'
  report.summaryLine = `Transaction period: ${report.periodLabel}  |  ${plural(bills.length, 'purchase')}  |  ${plural(supplierCount, 'supplier')}  |  ${plural(branchCount, 'branch', 'branches')}`
  const reg = report.sections.find((s) => s.id === 'register')
  if (reg && reg.type === 'table') reg.subtitle = `${showBranch ? 'All branches' : `Branch: ${bills[0]?.branch.name ?? report.scopeLabel}`}  |  Latest date first`
  await sendProReport(res, format, report, { data: register })
})

// ── Supplier Payable ────────────────────────────────────────────────────────

const AGING = ['Current', '1–30 days', '31–60 days', '61–90 days', '90+ days'] as const
const agingBucket = (days: number) => (days === 0 ? AGING[0] : days <= 30 ? AGING[1] : days <= 60 ? AGING[2] : days <= 90 ? AGING[3] : AGING[4])

router.get('/supplier-payable', async (req: Request, res: Response) => {
  const { branchId, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const now = new Date()

  const bills = await prisma.bill.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { notIn: ['paid', 'void', 'draft'] }, balanceDue: { gt: 0.005 } },
    include: { supplier: { select: { name: true } }, branch: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
  })

  const rows = bills.map((b) => {
    const daysOverdue = Math.max(0, Math.floor((now.getTime() - b.dueDate.getTime()) / 86_400_000))
    return {
      billNo: b.billNo, supplier: b.supplier.name, supplierId: b.supplierId, branch: b.branch.name,
      billDate: b.billDate.toISOString(), dueDate: b.dueDate.toISOString(),
      totalAmount: b.totalAmount, paidAmount: b.paidAmount, balanceDue: b.balanceDue,
      daysOverdue, agingBucket: agingBucket(daysOverdue), status: b.status,
    }
  })

  const outstanding = sum(rows, (r) => r.balanceDue)
  const overdue = rows.filter((r) => r.daysOverdue > 0)
  const overdueAmt = sum(overdue, (r) => r.balanceDue)
  const over90 = sum(rows.filter((r) => r.daysOverdue > 90), (r) => r.balanceDue)

  const agingRows: ReportRow[] = AGING.map((bucket) => {
    const inBucket = rows.filter((r) => r.agingBucket === bucket)
    const amount = sum(inBucket, (r) => r.balanceDue)
    return { bucket, bills: inBucket.length, amount, share: pct(amount, outstanding) }
  })

  const bySupplier = new Map<string, Record<string, number | string>>()
  for (const r of rows) {
    const s = bySupplier.get(r.supplierId) ?? { supplier: r.supplier, bills: 0, b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, balance: 0 }
    s.bills = Number(s.bills) + 1
    const idx = AGING.indexOf(r.agingBucket)
    s[`b${idx}`] = round2(Number(s[`b${idx}`]) + r.balanceDue)
    s.balance = round2(Number(s.balance) + r.balanceDue)
    bySupplier.set(r.supplierId, s)
  }
  const supplierRows = [...bySupplier.values()].sort((a, b) => Number(b.balance) - Number(a.balance)) as ReportRow[]

  const register: ReportRow[] = rows.map(({ supplierId: _s, ...r }) => r)

  const report: ProReport = {
    ...(await baseReport(req, 'supplier-payable', 'Supplier Payable Report', 'What we owe suppliers')),
    summaryLine: '',
    kpis: [
      { label: 'Total outstanding', value: outstanding, hint: `${plural(rows.length, 'open bill')} · ${plural(bySupplier.size, 'supplier')}` },
      { label: 'Not yet due', value: round2(outstanding - overdueAmt), hint: `${formatPercent(pct(outstanding - overdueAmt, outstanding))} of outstanding`, tone: 'positive' },
      { label: 'Over 90 days', value: over90, hint: `${formatPercent(pct(over90, outstanding))} of outstanding`, tone: over90 > 0 ? 'negative' : 'default' },
      { label: 'Overdue', value: overdueAmt, hint: `${plural(overdue.length, 'bill')} past due date`, tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'aging', title: 'Aging analysis', subtitle: 'Days past due date, as of today',
        columns: [{ key: 'bucket', label: 'Age' }, { key: 'bills', label: 'Bills', format: 'integer' }, { key: 'amount', label: 'Balance due', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' }],
        rows: agingRows,
        totals: { bucket: 'TOTAL', bills: rows.length, amount: outstanding, share: outstanding > 0 ? 100 : 0 },
      },
      {
        type: 'table', id: 'suppliers', title: 'Supplier aging', subtitle: 'Ranked by balance due, highest first', newPage: true,
        columns: [
          { key: 'supplier', label: 'Supplier', width: 2.6 }, { key: 'bills', label: 'Bills', format: 'integer' },
          { key: 'b0', label: 'Current', format: 'money' }, { key: 'b1', label: '1–30', format: 'money' }, { key: 'b2', label: '31–60', format: 'money' },
          { key: 'b3', label: '61–90', format: 'money' }, { key: 'b4', label: '90+', format: 'money' }, { key: 'balance', label: 'Balance due', format: 'money' },
        ],
        rows: supplierRows,
        totals: totalsOf(supplierRows, 'TOTAL', ['bills', 'b0', 'b1', 'b2', 'b3', 'b4', 'balance'], 'supplier'),
      },
      {
        type: 'table', id: 'register', title: 'Open bills register', subtitle: 'Oldest due date first', register: true, primary: true,
        columns: [
          { key: 'billNo', label: 'Bill no.', format: 'code' }, { key: 'supplier', label: 'Supplier', width: 2.2 },
          { key: 'billDate', label: 'Bill date', format: 'date' }, { key: 'dueDate', label: 'Due date', format: 'date' },
          { key: 'totalAmount', label: 'Total', format: 'money' }, { key: 'paidAmount', label: 'Paid', format: 'money' },
          { key: 'balanceDue', label: 'Balance due', format: 'money' }, { key: 'daysOverdue', label: 'Days overdue', format: 'integer', width: 1.05 },
          { key: 'agingBucket', label: 'Age' },
        ],
        rows: register,
        totals: totalsOf(register, 'TOTAL', ['totalAmount', 'paidAmount', 'balanceDue'], 'billNo'),
      },
    ],
  }
  report.periodLabel = `As of ${asOfLabel()}`
  report.summaryLine = `As of today  |  ${plural(rows.length, 'open bill')}  |  ${plural(bySupplier.size, 'supplier')}`
  await sendProReport(res, format, report, { data: register })
})

// ── Inventory Stock ─────────────────────────────────────────────────────────

router.get('/inventory-stock', async (req: Request, res: Response) => {
  const { branchId, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const [stocks, org] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...(branchId && { branchId }), item: { isActive: true } },
      include: { item: { include: { itemCategory: { select: { name: true } } } }, branch: { select: { name: true } } },
      orderBy: [{ branch: { name: 'asc' } }, { item: { name: 'asc' } }],
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
  ])
  const globalThreshold = org?.lowStockThreshold ?? null
  const threshold = (s: { reorderPoint: number }) => globalThreshold ?? s.reorderPoint

  const rows = stocks.map((s) => ({
    itemCode: s.item.code, item: s.item.name, category: s.item.itemCategory?.name ?? s.item.category ?? '—', branch: s.branch.name,
    unit: s.item.unit, quantityOnHand: round2(s.quantityOnHand), reorderLevel: threshold(s), averageCost: s.averageCost, totalValue: round2(s.totalValue),
    status: s.quantityOnHand <= 0 ? 'Out of stock' : s.quantityOnHand < threshold(s) ? 'Low' : 'OK',
  }))
  const value = sum(rows, (r) => r.totalValue)
  const low = rows.filter((r) => r.status === 'Low')
  const out = rows.filter((r) => r.status === 'Out of stock')

  const byBranch = new Map<string, { branch: string; items: number; low: number; value: number }>()
  for (const r of rows) {
    const b = byBranch.get(r.branch) ?? { branch: r.branch, items: 0, low: 0, value: 0 }
    if (r.quantityOnHand > 0) b.items++
    if (r.status !== 'OK') b.low++
    b.value += r.totalValue
    byBranch.set(r.branch, b)
  }
  const branchRows: ReportRow[] = [...byBranch.values()].sort((a, b) => b.value - a.value).map((b) => ({ ...b, value: round2(b.value), share: pct(b.value, value) }))

  const inStock = rows.filter((r) => r.quantityOnHand > 0).sort((a, b) => b.totalValue - a.totalValue)
  const columns: ReportColumn[] = [
    { key: 'itemCode', label: 'Code', format: 'code', width: 0.9 }, { key: 'item', label: 'Item', width: 2 },
    { key: 'category', label: 'Category', width: 1.2 }, { key: 'branch', label: 'Branch', width: 1.3 },
    { key: 'quantityOnHand', label: 'On hand', format: 'number' }, { key: 'unit', label: 'Unit', width: 0.6 },
    { key: 'averageCost', label: 'Avg cost', format: 'money' }, { key: 'totalValue', label: 'Value', format: 'money' },
    { key: 'status', label: 'Status', width: 0.9 },
  ]

  const report: ProReport = {
    ...(await baseReport(req, 'inventory-stock', 'Inventory Stock Report', 'Stock on hand')),
    summaryLine: '',
    kpis: [
      { label: 'Stock value', value: value, hint: 'At weighted-average cost' },
      { label: 'Items in stock', value: inStock.length, format: 'integer', hint: `Across ${plural(byBranch.size, 'branch', 'branches')}` },
      { label: 'Low stock', value: low.length, format: 'integer', hint: 'Below reorder level', tone: low.length ? 'warning' : 'default' },
      { label: 'Out of stock', value: out.length, format: 'integer', hint: 'Catalogue items at zero', tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'branches', title: 'Stock value by branch',
        columns: [{ key: 'branch', label: 'Branch', width: 2 }, { key: 'items', label: 'Items in stock', format: 'integer' }, { key: 'low', label: 'Low / out', format: 'integer' }, { key: 'value', label: 'Stock value', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' }],
        rows: branchRows,
        totals: { branch: 'TOTAL', items: inStock.length, low: low.length + out.length, value, share: value > 0 ? 100 : 0 },
      },
      {
        type: 'table', id: 'low', title: 'Needs reordering', subtitle: 'Low and out-of-stock items',
        columns: [
          { key: 'itemCode', label: 'Code', format: 'code' }, { key: 'item', label: 'Item', width: 2 }, { key: 'branch', label: 'Branch', width: 1.3 },
          { key: 'quantityOnHand', label: 'On hand', format: 'number' }, { key: 'reorderLevel', label: 'Reorder level', format: 'number' },
          { key: 'unit', label: 'Unit', width: 0.6 }, { key: 'status', label: 'Status', width: 0.9 },
        ],
        rows: [...low, ...out].map((r) => ({ ...r })),
        emptyMessage: 'Nothing below its reorder level',
      },
      {
        type: 'table', id: 'register', title: 'Stock register', subtitle: 'Items in stock, highest value first', register: true, primary: true,
        columns,
        rows: inStock,
        totals: { itemCode: 'TOTAL', totalValue: value },
      },
    ],
  }
  report.periodLabel = `As of ${asOfLabel()}`
  report.summaryLine = `As of today  |  ${plural(inStock.length, 'item')} in stock  |  ${plural(byBranch.size, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: rows })
})

// ── Food cost (recipes) ─────────────────────────────────────────────────────
// Dish-level food cost from recipes, for paid POS / QR orders: what each dish
// earned (net of tax and order discounts) against the recipe cost recorded
// when it was paid, plus the theoretical ingredient usage, compared with the
// cost of sales actually booked in the ledger.

router.get('/food-cost', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const closedAt = momentRange(fromDate, toDate)

  const orders = await prisma.customerOrder.findMany({
    where: { organizationId: orgId, status: 'completed', ...(branchId && { branchId }), ...(closedAt && { closedAt }) },
    include: {
      items: {
        where: { status: { not: 'cancelled' } },
        include: { dish: { include: { category: { select: { name: true } }, ingredients: { include: { item: { select: { id: true, code: true, name: true, unit: true } } } } } } },
      },
    },
  })
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { foodCostMethod: true } })

  type DishRow = { dish: string; category: string; qty: number; sales: number; cost: number; hasRecipe: boolean }
  const byDish = new Map<string, DishRow>()
  const usage = new Map<string, { code: string; item: string; unit: string; quantity: number }>()
  let uncostedSales = 0
  for (const o of orders) {
    // share of the order discount, then tax out of the tax-inclusive price
    const discountFactor = o.itemsTotal > 0 ? 1 - (o.discountAmount + o.promotionAmount) / o.itemsTotal : 1
    const taxFactor = o.vatRate > 0 ? 100 / (100 + o.vatRate) : 1
    for (const i of o.items) {
      const net = i.lineTotal * discountFactor * taxFactor
      const row = byDish.get(i.dishId) ?? { dish: i.dishName, category: i.dish.category.name, qty: 0, sales: 0, cost: 0, hasRecipe: i.dish.ingredients.length > 0 }
      row.qty += i.quantity
      row.sales += net
      row.cost += i.unitCost * i.quantity
      byDish.set(i.dishId, row)
      if (!i.dish.ingredients.length) uncostedSales += net
      for (const g of i.dish.ingredients) {
        const u = usage.get(g.itemId) ?? { code: g.item.code, item: g.item.name, unit: g.item.unit, quantity: 0 }
        u.quantity += g.quantity * (1 + g.wastePct / 100) * i.quantity
        usage.set(g.itemId, u)
      }
    }
  }
  const sales = sum([...byDish.values()], (d) => d.sales)
  const cost = sum([...byDish.values()], (d) => d.cost)
  const costPct = pct(cost, sales)

  // Cost of sales actually booked in the ledger for the period
  const entryDate = dateRangeFilter(fromDate, toDate)
  const cogsAccounts = await prisma.accountingMapping.findMany({ where: { organizationId: orgId, key: 'COST_OF_SALES' }, select: { accountId: true } })
  const ledger = cogsAccounts.length ? await prisma.journalLine.aggregate({
    where: {
      accountId: { in: cogsAccounts.map((m) => m.accountId) },
      journalEntry: { organizationId: orgId, status: 'posted', ...(branchId && { branchId }), ...(entryDate && { entryDate }) },
    },
    _sum: { debitAmount: true, creditAmount: true },
  }) : null
  const actual = round2(Number(ledger?._sum.debitAmount ?? 0) - Number(ledger?._sum.creditAmount ?? 0))
  const variance = round2(actual - cost)

  const dishRows: ReportRow[] = [...byDish.values()].sort((a, b) => b.sales - a.sales).map((d) => ({
    dish: d.hasRecipe ? d.dish : `${d.dish} (no recipe)`, category: d.category, qty: d.qty,
    sales: round2(d.sales), cost: round2(d.cost), profit: round2(d.sales - d.cost),
    costPct: d.hasRecipe ? pct(d.cost, d.sales) : 0, perPlate: d.qty ? round2((d.sales - d.cost) / d.qty) : 0,
  }))
  const byCategory = new Map<string, { sales: number; cost: number; qty: number }>()
  for (const d of byDish.values()) {
    const c = byCategory.get(d.category) ?? { sales: 0, cost: 0, qty: 0 }
    c.sales += d.sales; c.cost += d.cost; c.qty += d.qty
    byCategory.set(d.category, c)
  }
  const categoryRows: ReportRow[] = [...byCategory.entries()].sort((a, b) => b[1].sales - a[1].sales)
    .map(([category, c]) => ({ category, qty: c.qty, sales: round2(c.sales), cost: round2(c.cost), profit: round2(c.sales - c.cost), costPct: pct(c.cost, c.sales) }))
  const usageRows: ReportRow[] = [...usage.values()].sort((a, b) => b.quantity - a.quantity)
    .map((u) => ({ code: u.code, item: u.item, quantity: round2(u.quantity), unit: u.unit }))

  const worst = dishRows.filter((d) => !String(d.dish).endsWith('(no recipe)')).sort((a, b) => Number(b.costPct) - Number(a.costPct))[0]
  const report: ProReport = {
    ...(await baseReport(req, 'food-cost', 'Food Cost Report', 'Food cost by dish', orders.map((o) => o.closedAt ?? o.createdAt))),
    summaryLine: `${plural(orders.length, 'paid order')} | ${plural(byDish.size, 'dish', 'dishes')} sold`,
    kpis: [
      { label: 'Net food sales', value: sales, hint: 'Paid orders, excl. tax and discounts' },
      { label: 'Recipe food cost', value: cost, hint: `${formatPercent(costPct)} of net sales`, tone: costPct > 40 ? 'warning' : 'default' },
      { label: 'Gross profit', value: round2(sales - cost), hint: `${formatPercent(pct(sales - cost, sales))} margin`, tone: 'positive' },
      { label: 'Highest food cost %', value: worst ? String(worst.dish) : '—', format: 'text', hint: worst ? `${formatPercent(Number(worst.costPct))} of its net price` : 'No costed dishes sold', tone: 'dark' },
    ],
    sections: [
      {
        type: 'stats', id: 'reconcile', title: 'Recipe cost vs cost of sales booked',
        items: [
          { label: 'Recipe (theoretical) cost', value: fmtMoney(cost) },
          { label: 'Cost of sales in the ledger', value: fmtMoney(actual) },
          { label: 'Difference', value: fmtMoney(variance), tone: Math.abs(variance) < regionalMoneyTolerance() ? 'positive' : variance > 0 ? 'warning' : 'default' },
          { label: 'Sales of dishes without a recipe', value: fmtMoney(round2(uncostedSales)), tone: uncostedSales > 0 ? 'warning' : 'positive' },
        ],
        note: org?.foodCostMethod === 'recipes'
          ? 'Recipe mode: ingredients leave stock as dishes are sold and the cost is booked when each day is finalized. A difference means days not finalized yet, wastage, or stock issued another way.'
          : 'Kitchen-issue mode: the ledger shows stock issued to the kitchen (Stock Out). A ledger cost above the recipe cost points to waste, over-portioning or unrecorded sales.',
      },
      {
        type: 'table', id: 'dishes', title: 'Dishes', subtitle: 'Best sellers first · net sales exclude tax and discounts', primary: true,
        columns: [
          { key: 'dish', label: 'Dish', width: 2.2 }, { key: 'category', label: 'Category', width: 1.2 }, { key: 'qty', label: 'Sold', format: 'integer' },
          { key: 'sales', label: 'Net sales', format: 'money' }, { key: 'cost', label: 'Food cost', format: 'money' }, { key: 'costPct', label: 'Cost %', format: 'percent' },
          { key: 'profit', label: 'Gross profit', format: 'money' }, { key: 'perPlate', label: 'Profit / plate', format: 'money' },
        ],
        rows: dishRows,
        totals: { dish: 'TOTAL', qty: dishRows.reduce((n, r) => n + Number(r.qty), 0), sales, cost, costPct, profit: round2(sales - cost) },
        emptyMessage: 'No paid orders in this period',
      },
      {
        type: 'table', id: 'categories', title: 'By category',
        columns: [
          { key: 'category', label: 'Category', width: 2 }, { key: 'qty', label: 'Sold', format: 'integer' }, { key: 'sales', label: 'Net sales', format: 'money' },
          { key: 'cost', label: 'Food cost', format: 'money' }, { key: 'costPct', label: 'Cost %', format: 'percent' }, { key: 'profit', label: 'Gross profit', format: 'money' },
        ],
        rows: categoryRows,
        totals: { category: 'TOTAL', sales, cost, costPct, profit: round2(sales - cost) },
      },
      {
        type: 'table', id: 'usage', title: 'Ingredient usage (from recipes)', subtitle: 'What the dishes sold should have used, including the waste allowance',
        columns: [
          { key: 'code', label: 'Code', format: 'code', width: 0.9 }, { key: 'item', label: 'Ingredient', width: 2.2 },
          { key: 'quantity', label: 'Quantity', format: 'number' }, { key: 'unit', label: 'Unit', width: 0.6 },
        ],
        rows: usageRows,
        emptyMessage: 'No recipes on the dishes sold',
      },
    ],
  }
  await sendProReport(res, format, report, { data: dishRows })
})

// ── Wastage ─────────────────────────────────────────────────────────────────

router.get('/wastage', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const reportDate = dateRangeFilter(fromDate, toDate)

  const reports = await prisma.wastageReport.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), ...(reportDate && { reportDate }) },
    include: { branch: { select: { name: true } }, items: { include: { item: true } } },
    orderBy: { reportDate: 'desc' },
  })

  const lines = reports.flatMap((r) => r.items.map((wi) => ({
    date: r.reportDate.toISOString(), branch: r.branch.name, itemCode: wi.item.code, item: wi.item.name, unit: wi.item.unit,
    quantity: wi.quantity, unitCost: wi.unitCost, totalValue: wi.totalValue, reason: wi.reason || '—', status: r.status,
  })))
  const value = sum(lines, (l) => l.totalValue)
  const approvedValue = sum(lines.filter((l) => l.status === 'approved'), (l) => l.totalValue)

  const byItem = new Map<string, { item: string; unit: string; lines: number; quantity: number; value: number }>()
  for (const l of lines) {
    const it = byItem.get(l.itemCode) ?? { item: l.item, unit: l.unit, lines: 0, quantity: 0, value: 0 }
    it.lines++; it.quantity += l.quantity; it.value += l.totalValue
    byItem.set(l.itemCode, it)
  }
  const itemRows: ReportRow[] = [...byItem.values()].sort((a, b) => b.value - a.value)
    .map((i) => ({ ...i, quantity: round2(i.quantity), value: round2(i.value), share: pct(i.value, value) }))

  const byReason = new Map<string, number>()
  for (const l of lines) byReason.set(l.reason, (byReason.get(l.reason) ?? 0) + l.totalValue)
  const reasonRows: ReportRow[] = [...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([reason, v]) => ({ reason, value: round2(v), share: pct(v, value) }))

  const report: ProReport = {
    ...(await baseReport(req, 'wastage', 'Wastage Report', 'Inventory losses', reports.map((r) => r.reportDate))),
    summaryLine: '',
    kpis: [
      { label: 'Wastage value', value, hint: `${plural(lines.length, 'line')} in ${plural(reports.length, 'report')}` },
      { label: 'Approved & posted', value: approvedValue, hint: `${formatPercent(pct(approvedValue, value))} of wastage value`, tone: 'positive' },
      { label: 'Pending approval', value: round2(value - approvedValue), hint: plural(reports.filter((r) => r.status !== 'approved').length, 'report'), tone: value - approvedValue > 0.005 ? 'warning' : 'default' },
      { label: 'Top item', value: itemRows[0] ? String(itemRows[0].item) : '—', format: 'text', hint: itemRows[0] ? `${fmtMoney(Number(itemRows[0].value))} · ${formatPercent(Number(itemRows[0].share))} of losses` : 'No wastage in period', tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'items', title: 'Losses by item', subtitle: 'Ranked by value, highest first',
        columns: [{ key: 'item', label: 'Item', width: 2.4 }, { key: 'lines', label: 'Entries', format: 'integer' }, { key: 'quantity', label: 'Quantity', format: 'number' }, { key: 'unit', label: 'Unit', width: 0.6 }, { key: 'value', label: 'Value', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' }],
        rows: itemRows,
        totals: { item: 'TOTAL', lines: lines.length, value, share: value > 0 ? 100 : 0 },
      },
      {
        type: 'table', id: 'reasons', title: 'Losses by reason',
        columns: [{ key: 'reason', label: 'Reason', width: 3 }, { key: 'value', label: 'Value', format: 'money' }, { key: 'share', label: 'Share', format: 'percent' }],
        rows: reasonRows,
        totals: { reason: 'TOTAL', value, share: value > 0 ? 100 : 0 },
      },
      {
        type: 'table', id: 'register', title: 'Wastage register', subtitle: 'Latest date first', register: true, primary: true,
        columns: [
          { key: 'date', label: 'Date', format: 'date' }, { key: 'branch', label: 'Branch', width: 1.3 },
          { key: 'itemCode', label: 'Code', format: 'code', width: 0.9 }, { key: 'item', label: 'Item', width: 1.8 },
          { key: 'quantity', label: 'Qty', format: 'number' }, { key: 'unit', label: 'Unit', width: 0.6 },
          { key: 'unitCost', label: 'Unit cost', format: 'money' }, { key: 'totalValue', label: 'Value', format: 'money' },
          { key: 'reason', label: 'Reason', width: 1.6 }, { key: 'status', label: 'Status', format: 'status' },
        ],
        rows: lines,
        totals: { date: 'TOTAL', totalValue: value },
      },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(reports.length, 'report')}  |  ${plural(byItem.size, 'item')}`
  await sendProReport(res, format, report, { data: lines })
})

// ── Audit Log ───────────────────────────────────────────────────────────────

router.get('/audit-log', requirePermission('can_view_audit_logs'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const createdAt = momentRange(fromDate, toDate)

  const logs = await prisma.auditLog.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), ...(createdAt && { createdAt }) },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  })

  const register: ReportRow[] = logs.map((l) => ({
    date: l.createdAt.toISOString(), user: l.userName || l.userEmail, action: l.action, module: l.module,
    resource: l.resourceRef ?? l.resourceType ?? '—',
  }))
  const byModule = new Map<string, number>()
  const byUser = new Map<string, number>()
  for (const l of logs) {
    byModule.set(l.module, (byModule.get(l.module) ?? 0) + 1)
    const u = l.userName || l.userEmail
    byUser.set(u, (byUser.get(u) ?? 0) + 1)
  }
  const moduleRows: ReportRow[] = [...byModule.entries()].sort((a, b) => b[1] - a[1]).map(([module, events]) => ({ module, events, share: pct(events, logs.length) }))
  const userRows: ReportRow[] = [...byUser.entries()].sort((a, b) => b[1] - a[1]).map(([user, events]) => ({ user, events, share: pct(events, logs.length) }))

  const report: ProReport = {
    ...(await baseReport(req, 'audit-log', 'Audit Log Report', 'User activity', logs.map((l) => l.createdAt))),
    summaryLine: '',
    kpis: [
      { label: 'Events', value: logs.length, format: 'integer', hint: logs.length >= 2000 ? 'Latest 2,000 shown' : 'Recorded actions' },
      { label: 'Active users', value: byUser.size, format: 'integer', hint: 'Users with at least one action' },
      { label: 'Modules touched', value: byModule.size, format: 'integer', hint: 'Distinct modules' },
      { label: 'Most active', value: userRows[0] ? String(userRows[0].user) : '—', format: 'text', hint: userRows[0] ? `${plural(Number(userRows[0].events), 'event')}` : 'No activity', tone: 'dark' },
    ],
    sections: [
      { type: 'table', id: 'modules', title: 'Activity by module', columns: [{ key: 'module', label: 'Module', width: 3 }, { key: 'events', label: 'Events', format: 'integer' }, { key: 'share', label: 'Share', format: 'percent' }], rows: moduleRows, totals: { module: 'TOTAL', events: logs.length, share: logs.length ? 100 : 0 } },
      { type: 'table', id: 'users', title: 'Activity by user', columns: [{ key: 'user', label: 'User', width: 3 }, { key: 'events', label: 'Events', format: 'integer' }, { key: 'share', label: 'Share', format: 'percent' }], rows: userRows, totals: { user: 'TOTAL', events: logs.length, share: logs.length ? 100 : 0 } },
      {
        type: 'table', id: 'register', title: 'Activity register', subtitle: 'Latest first', register: true, primary: true,
        columns: [{ key: 'date', label: 'Date / time', format: 'datetime', width: 1.3 }, { key: 'user', label: 'User', width: 1.6 }, { key: 'action', label: 'Action', width: 1.8 }, { key: 'module', label: 'Module', width: 1.1 }, { key: 'resource', label: 'Reference', width: 1.6 }],
        rows: register,
      },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(logs.length, 'event')}  |  ${plural(byUser.size, 'user')}`
  await sendProReport(res, format, report, { data: register })
})

// ── Financial statements ────────────────────────────────────────────────────
// Presented the IFRS way (IAS 1 / IAS 7): expenses as negatives, comparative
// figures, current / non-current classification, a single "Profit for the
// period" line, sign-off block. Built entirely from posted journal lines so
// they agree with the trial balance and the general ledger to the cent.

const parseDay = (v?: string): Date | undefined => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
  const d = new Date(`${v}T00:00:00.000Z`)
  return isNaN(d.getTime()) ? undefined : d
}
const shortRange = (from: Date, to: Date) => `${formatDate(from)} – ${formatDate(to)}`
const changePct = (cur: number, prev: number | null | undefined) => (prev == null || Math.abs(prev) < 0.005 ? null : round2(((cur - prev) / Math.abs(prev)) * 100))
const signedShare = (amount: number, revenue: number) => (Math.abs(revenue) < 0.005 ? null : round2((Math.abs(amount) / Math.abs(revenue)) * 100))

async function orgFiscalYear(orgId: string) {
  return (await prisma.organization.findUnique({ where: { id: orgId }, select: { fiscalYearStart: true } }))?.fiscalYearStart ?? '01-01'
}

// ── Statement of profit or loss ─────────────────────────────────────────────

interface PnlTotals {
  revenue: number; costOfSales: number; grossProfit: number; otherIncome: number; operating: number
  operatingProfit: number; finance: number; profitBeforeTax: number; incomeTax: number; profit: number
}

// Amounts per account for a period, signed as presented: income positive,
// expenses negative
function pnlAmounts(accounts: StatementAccount[], sums: Map<string, { debit: number; credit: number }>) {
  const lines = new Map<string, { a: StatementAccount; group: PnlGroup; amount: number }>()
  for (const a of accounts) {
    if (a.accountClass !== 'REVENUE' && a.accountClass !== 'EXPENSE') continue
    const s = sums.get(a.id)
    if (!s) continue
    const amount = round2(s.credit - s.debit) // income +, expense −
    if (Math.abs(amount) < 0.005) continue
    lines.set(a.id, { a, group: pnlGroup(a), amount })
  }
  const g = (group: PnlGroup) => round2([...lines.values()].filter((l) => l.group === group).reduce((t, l) => t + l.amount, 0))
  const revenue = round2(g('revenue') + g('discounts'))
  const costOfSales = g('cost_of_sales')
  const grossProfit = round2(revenue + costOfSales)
  const otherIncome = g('other_income')
  const operating = g('operating')
  const operatingProfit = round2(grossProfit + otherIncome + operating)
  const finance = g('finance')
  const profitBeforeTax = round2(operatingProfit + finance)
  const incomeTax = g('income_tax')
  const totals: PnlTotals = { revenue, costOfSales, grossProfit, otherIncome, operating, operatingProfit, finance, profitBeforeTax, incomeTax, profit: round2(profitBeforeTax + incomeTax) }
  return { lines, totals }
}

router.get('/profit-loss', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const from = parseDay(fromDate)
  const to = parseDay(toDate) ?? todayInZone()
  const accounts = await statementAccounts(orgId)
  const prior = from ? priorPeriod(from, to) : null
  const [curSums, prevSums] = await Promise.all([
    netByAccount(orgId, { from, to }, branchId || undefined),
    prior ? netByAccount(orgId, prior, branchId || undefined) : Promise.resolve(null),
  ])
  const cur = pnlAmounts(accounts, curSums)
  const prev = prevSums ? pnlAmounts(accounts, prevSums) : null
  const R = cur.totals.revenue
  const withPrior = !!prev

  const row = (code: string, name: string, amount: number | null, prevAmount: number | null | undefined, style: ReportRow['_style']): ReportRow => ({
    code, name, current: amount, share: amount == null ? null : signedShare(amount, R),
    ...(withPrior && { prior: prevAmount ?? (amount == null ? null : 0), change: amount == null ? null : changePct(amount, prevAmount ?? 0) }),
    _style: style,
  })
  const rows: ReportRow[] = []
  const block = (title: string, groups: PnlGroup[], subtotalLabel?: string, subtotal?: (t: PnlTotals) => number) => {
    const ids = new Set<string>()
    for (const [id, l] of cur.lines) if (groups.includes(l.group)) ids.add(id)
    if (prev) for (const [id, l] of prev.lines) if (groups.includes(l.group)) ids.add(id)
    if (ids.size === 0) return
    rows.push(row('', title, null, null, 'heading'))
    const sorted = [...ids].map((id) => (cur.lines.get(id) ?? prev!.lines.get(id))!.a).sort((x, y) => x.code.localeCompare(y.code))
    for (const a of sorted) rows.push(row(a.code, a.name, cur.lines.get(a.id)?.amount ?? 0, prev ? prev.lines.get(a.id)?.amount ?? 0 : undefined, 'indent'))
    if (subtotalLabel && subtotal) rows.push(row('', subtotalLabel, subtotal(cur.totals), prev ? subtotal(prev.totals) : undefined, 'subtotal'))
  }
  const result = (label: string, pick: (t: PnlTotals) => number, style: ReportRow['_style'] = 'subtotal') => {
    rows.push(row('', label, pick(cur.totals), prev ? pick(prev.totals) : undefined, style))
    rows.push({ _style: 'spacer' })
  }
  block('Revenue', ['revenue', 'discounts'], 'Total revenue', (t) => t.revenue)
  block('Cost of sales', ['cost_of_sales'], 'Total cost of sales', (t) => t.costOfSales)
  result('Gross profit', (t) => t.grossProfit)
  block('Other income', ['other_income'], 'Total other income', (t) => t.otherIncome)
  block('Operating expenses', ['operating'], 'Total operating expenses', (t) => t.operating)
  result('Operating profit', (t) => t.operatingProfit)
  if ([...cur.lines.values(), ...(prev?.lines.values() ?? [])].some((l) => l.group === 'finance')) {
    block('Finance costs', ['finance'], 'Total finance costs', (t) => t.finance)
    result('Profit before tax', (t) => t.profitBeforeTax)
  }
  if ([...cur.lines.values(), ...(prev?.lines.values() ?? [])].some((l) => l.group === 'income_tax')) block('Income tax', ['income_tax'], 'Income tax expense', (t) => t.incomeTax)
  rows.push(row('', 'Profit for the period', cur.totals.profit, prev?.totals.profit, 'total'))

  const periodText = from ? shortRange(from, to) : `Up to ${formatDate(to)}`
  const vsPrior = (c: number, p?: number) => (p == null ? '' : ` · ${changePct(c, p) == null ? 'no prior figure' : `${changePct(c, p)! >= 0 ? '+' : ''}${formatPercent(changePct(c, p)!)} vs prior`}`)
  const columns: ReportColumn[] = [
    { key: 'code', label: 'Code', format: 'code', width: 0.6 }, { key: 'name', label: 'Line item', width: 2.8 },
    { key: 'current', label: withPrior ? 'Current period' : 'Amount', format: 'money' }, { key: 'share', label: '% of revenue', format: 'percent', width: 1 },
    ...(withPrior ? [{ key: 'prior', label: 'Prior period', format: 'money' } as ReportColumn, { key: 'change', label: 'Change', format: 'percent', width: 0.75 } as ReportColumn] : []),
  ]
  const report: ProReport = {
    ...(await baseReport(req, 'profit-loss', 'Statement of Profit or Loss', 'Profit or loss')),
    kind: 'statement',
    periodLabel: periodText,
    summaryLine: `For the period ${periodText}${prior ? `  |  Comparative: ${shortRange(prior.from, prior.to)}` : ''}  |  ${plural(cur.lines.size, 'account')} with activity`,
    kpis: [
      { label: 'Revenue', value: R, hint: `Net of discounts${vsPrior(R, prev?.totals.revenue)}` },
      { label: 'Gross profit', value: cur.totals.grossProfit, hint: `${formatPercent(pct(cur.totals.grossProfit, R))} gross margin${vsPrior(cur.totals.grossProfit, prev?.totals.grossProfit)}`, tone: cur.totals.grossProfit >= 0 ? 'default' : 'negative' },
      { label: 'Operating profit', value: cur.totals.operatingProfit, hint: `${formatPercent(pct(cur.totals.operatingProfit, R))} operating margin`, tone: cur.totals.operatingProfit >= 0 ? 'default' : 'negative' },
      { label: 'Profit for the period', value: cur.totals.profit, hint: `${formatPercent(pct(cur.totals.profit, R))} net margin${vsPrior(cur.totals.profit, prev?.totals.profit)}`, tone: 'dark' },
    ],
    sections: [
      { type: 'table', id: 'statement', title: 'Statement of profit or loss', subtitle: `For the period ${periodText}${prior ? `, with the preceding period of equal length (${shortRange(prior.from, prior.to)})` : ''}`, primary: true, columns, rows },
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: `Prepared from posted journal entries only; drafts and unapproved records are excluded. Expenses are classified by function (cost of sales, operating expenses, finance costs). Revenue is shown net of discounts and of ${tax()}, which is a liability to the tax authority. Amounts in brackets are deductions.` },
    ],
  }
  await sendProReport(res, format, report, { revenue: R, expenses: -(cur.totals.costOfSales + cur.totals.operating), grossProfit: cur.totals.grossProfit, netProfit: cur.totals.profit, totals: cur.totals, prior: prev?.totals ?? null })
})

// ── Statement of financial position ─────────────────────────────────────────

router.get('/balance-sheet', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const asOf = parseDay(toDate) ?? todayInZone()
  const [fy, accounts] = await Promise.all([orgFiscalYear(orgId), statementAccounts(orgId)])
  const cur = await financialPosition(orgId, asOf, fy, accounts, branchId || undefined)
  const priorDate = dayBefore(cur.fyStart)
  const prev = await financialPosition(orgId, priorDate, fy, accounts, branchId || undefined)

  const rows: ReportRow[] = []
  const key = (l: PositionLine) => `${l.code}|${l.name}`
  const group = (title: string, a: PositionLine[], b: PositionLine[], totalLabel: string, ta: number, tb: number) => {
    const keys = [...new Set([...a, ...b].map(key))]
    if (keys.length === 0) return
    rows.push({ code: '', name: title, _style: 'heading' })
    const byA = new Map(a.map((l) => [key(l), l])), byB = new Map(b.map((l) => [key(l), l]))
    for (const k of keys) {
      const l = byA.get(k) ?? byB.get(k)!
      rows.push({ code: l.code, name: l.name, current: byA.get(k)?.amount ?? 0, prior: byB.get(k)?.amount ?? 0, _style: 'indent' })
    }
    rows.push({ code: '', name: totalLabel, current: ta, prior: tb, _style: 'subtotal' })
  }
  rows.push({ code: '', name: 'ASSETS', _style: 'heading' })
  group('Non-current assets', cur.nonCurrentAssets, prev.nonCurrentAssets, 'Total non-current assets', cur.totals.nonCurrentAssets, prev.totals.nonCurrentAssets)
  group('Current assets', cur.currentAssets, prev.currentAssets, 'Total current assets', cur.totals.currentAssets, prev.totals.currentAssets)
  rows.push({ code: '', name: 'TOTAL ASSETS', current: cur.totals.assets, prior: prev.totals.assets, _style: 'total' }, { _style: 'spacer' })
  rows.push({ code: '', name: 'EQUITY AND LIABILITIES', _style: 'heading' })
  group('Equity', cur.equity, prev.equity, 'Total equity', cur.totals.equity, prev.totals.equity)
  group('Non-current liabilities', cur.nonCurrentLiabilities, prev.nonCurrentLiabilities, 'Total non-current liabilities', cur.totals.nonCurrentLiabilities, prev.totals.nonCurrentLiabilities)
  group('Current liabilities', cur.currentLiabilities, prev.currentLiabilities, 'Total current liabilities', cur.totals.currentLiabilities, prev.totals.currentLiabilities)
  rows.push({ code: '', name: 'Total liabilities', current: cur.totals.liabilities, prior: prev.totals.liabilities, _style: 'subtotal' })
  rows.push({ code: '', name: 'TOTAL EQUITY AND LIABILITIES', current: cur.totals.equityAndLiabilities, prior: prev.totals.equityAndLiabilities, _style: 'total' })

  const difference = round2(cur.totals.assets - cur.totals.equityAndLiabilities)
  const balanced = Math.abs(difference) < regionalMoneyTolerance()
  const currentRatio = cur.totals.currentLiabilities > 0 ? round2(cur.totals.currentAssets / cur.totals.currentLiabilities) : null
  const report: ProReport = {
    ...(await baseReport(req, 'balance-sheet', 'Statement of Financial Position', 'Financial position')),
    kind: 'statement',
    periodLabel: `As at ${formatDate(asOf)}`,
    summaryLine: `As at ${formatDate(asOf)}  |  Comparative: as at ${formatDate(priorDate)} (end of the previous financial year)`,
    kpis: [
      { label: 'Total assets', value: cur.totals.assets, hint: `Non-current ${formatMoney(cur.totals.nonCurrentAssets)}` },
      { label: 'Total liabilities', value: cur.totals.liabilities, hint: currentRatio != null ? `Current ratio ${formatNumber(currentRatio, 2)} : 1` : 'No current liabilities' },
      { label: 'Total equity', value: cur.totals.equity, hint: `Incl. ${formatMoney(cur.profitThisYear)} profit this year` },
      { label: 'Balance check', value: balanced ? 'Balanced' : 'Out of balance', format: 'text', hint: balanced ? 'Assets = equity + liabilities' : `Difference ${formatMoney(difference)}`, tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'position', title: 'Statement of financial position', subtitle: `As at ${formatDate(asOf)} and ${formatDate(priorDate)}`, primary: true,
        columns: [{ key: 'code', label: 'Code', format: 'code', width: 0.6 }, { key: 'name', label: 'Line item', width: 3 }, { key: 'current', label: formatDate(asOf), format: 'money' }, { key: 'prior', label: formatDate(priorDate), format: 'money' }],
        rows,
      },
      ...(!balanced ? [{ type: 'note' as const, id: 'difference', title: 'Out of balance', tone: 'warning' as const, text: `Assets differ from equity and liabilities by ${formatMoney(difference)}. Check for unposted or one-sided journal entries.` }] : []),
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: `Balances from posted journal entries up to ${formatDate(asOf)}. Assets and liabilities are split into current and non-current (IAS 1). Profit for the year runs from the start of the financial year (${formatDate(cur.fyStart)}); profit of earlier years is shown in retained earnings. An overdrawn bank account is shown as a current liability.` },
    ],
  }
  await sendProReport(res, format, report, {
    asOf: asOf.toISOString(), totalAssets: cur.totals.assets, totalLiabilities: cur.totals.liabilities, totalEquity: cur.totals.equity,
    netPosition: round2(cur.totals.assets - cur.totals.liabilities), balanced, position: cur, comparative: prev,
  })
})

// ── Statement of cash flows (indirect method) ───────────────────────────────

router.get('/cash-flow', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const to = parseDay(toDate) ?? todayInZone()
  const [fy, accounts] = await Promise.all([orgFiscalYear(orgId), statementAccounts(orgId)])
  const from = parseDay(fromDate) ?? fiscalYearStartFor(to, fy)
  const cf = await cashFlows(orgId, from, to, accounts, branchId || undefined)

  const rows: ReportRow[] = []
  const lines = (l: CashFlowLine[]) => l.forEach((x) => rows.push({ code: x.code, name: x.name, amount: x.amount, _style: 'indent' }))
  rows.push({ code: '', name: 'Cash flows from operating activities', _style: 'heading' })
  rows.push({ code: '', name: 'Profit for the period', amount: cf.profit, _style: 'indent' })
  if (cf.adjustments.length) { rows.push({ code: '', name: 'Adjustments for non-cash items', _style: 'heading' }); lines(cf.adjustments) }
  if (cf.workingCapital.length) { rows.push({ code: '', name: 'Changes in working capital', _style: 'heading' }); lines(cf.workingCapital) }
  rows.push({ code: '', name: 'Net cash from operating activities', amount: cf.operatingTotal, _style: 'subtotal' }, { _style: 'spacer' })
  rows.push({ code: '', name: 'Cash flows from investing activities', _style: 'heading' })
  lines(cf.investing)
  rows.push({ code: '', name: 'Net cash used in investing activities', amount: cf.investingTotal, _style: 'subtotal' }, { _style: 'spacer' })
  rows.push({ code: '', name: 'Cash flows from financing activities', _style: 'heading' })
  lines(cf.financing)
  rows.push({ code: '', name: 'Net cash from financing activities', amount: cf.financingTotal, _style: 'subtotal' }, { _style: 'spacer' })
  rows.push({ code: '', name: 'Net increase / (decrease) in cash and cash equivalents', amount: cf.netChange, _style: 'subtotal' })
  rows.push({ code: '', name: `Cash and cash equivalents at ${formatDate(from)}`, amount: cf.openingCash, _style: 'indent' })
  rows.push({ code: '', name: `Cash and cash equivalents at ${formatDate(to)}`, amount: cf.closingCash, _style: 'total' })

  const reconciled = Math.abs(round2(cf.openingCash + cf.netChange - cf.closingCash)) < regionalMoneyTolerance()
  const periodText = shortRange(from, to)
  const report: ProReport = {
    ...(await baseReport(req, 'cash-flow', 'Statement of Cash Flows', 'Cash flows')),
    kind: 'statement',
    periodLabel: periodText,
    summaryLine: `For the period ${periodText}  |  Indirect method`,
    kpis: [
      { label: 'Operating activities', value: cf.operatingTotal, hint: 'Cash generated by trading', tone: cf.operatingTotal >= 0 ? 'default' : 'negative' },
      { label: 'Investing activities', value: cf.investingTotal, hint: 'Long-term assets' },
      { label: 'Financing activities', value: cf.financingTotal, hint: 'Owners and lenders' },
      { label: 'Closing cash', value: cf.closingCash, hint: `${cf.netChange >= 0 ? 'Up' : 'Down'} ${formatMoney(Math.abs(cf.netChange))} in the period`, tone: 'dark' },
    ],
    sections: [
      { type: 'table', id: 'cash-flows', title: 'Statement of cash flows', subtitle: `For the period ${periodText}`, primary: true, columns: [{ key: 'code', label: 'Code', format: 'code', width: 0.6 }, { key: 'name', label: 'Line item', width: 3.6 }, { key: 'amount', label: 'Amount', format: 'money' }], rows },
      ...(!reconciled ? [{ type: 'note' as const, id: 'difference', title: 'Does not reconcile', tone: 'warning' as const, text: 'Opening cash plus the net change does not equal closing cash. Check for one-sided journal entries.' }] : []),
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: 'Indirect method (IAS 7): profit for the period adjusted for non-cash items and changes in working capital. Cash and cash equivalents are the accounts in the Cash and Bank reporting groups (cash on hand, bank and card clearing). Amounts in brackets are cash outflows.' },
    ],
  }
  await sendProReport(res, format, report, { ...cf, from: from.toISOString(), to: to.toISOString(), reconciled })
})

// ── Trial balance ───────────────────────────────────────────────────────────
// Opening balance, movements in the period and closing balance for every
// account with activity. Profit of earlier financial years is carried in one
// retained-earnings line, so the opening and closing columns each balance.

router.get('/trial-balance', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const from = parseDay(fromDate)
  const to = parseDay(toDate) ?? todayInZone()
  const [fy, accounts] = await Promise.all([orgFiscalYear(orgId), statementAccounts(orgId)])
  const fyStart = fiscalYearStartFor(from ?? to, fy)
  const branch = branchId || undefined
  const [beforeFy, fyToFrom, movement] = await Promise.all([
    from ? netByAccount(orgId, { to: dayBefore(fyStart) }, branch) : Promise.resolve(new Map()),
    from && from > fyStart ? netByAccount(orgId, { from: fyStart, to: dayBefore(from) }, branch) : Promise.resolve(new Map()),
    netByAccount(orgId, { from, to }, branch),
  ])
  const net = (m: Map<string, { debit: number; credit: number }>, id: string) => { const s = m.get(id); return s ? s.debit - s.credit : 0 }
  const classLabel: Record<string, string> = { ASSET: 'Asset', LIABILITY: 'Liability', EQUITY: 'Equity', REVENUE: 'Revenue', EXPENSE: 'Expense' }
  const split = (n: number) => ({ dr: n > 0.005 ? round2(n) : 0, cr: n < -0.005 ? round2(-n) : 0 })
  let priorYearsProfit = 0
  const rows: ReportRow[] = []
  for (const a of accounts) {
    const isPnl = a.accountClass === 'REVENUE' || a.accountClass === 'EXPENSE'
    // P&L accounts open at zero each financial year; earlier years sit in retained earnings
    let opening = net(fyToFrom, a.id) + (isPnl ? 0 : net(beforeFy, a.id))
    if (isPnl) priorYearsProfit += -net(beforeFy, a.id)
    const m = movement.get(a.id) ?? { debit: 0, credit: 0 }
    opening = round2(opening)
    const closing = round2(opening + m.debit - m.credit)
    if (Math.abs(opening) < 0.005 && m.debit < 0.005 && m.credit < 0.005) continue
    const o = split(opening), c = split(closing)
    rows.push({ code: a.code, name: a.name, accountClass: classLabel[a.accountClass], openDr: o.dr, openCr: o.cr, debit: round2(m.debit), credit: round2(m.credit), closeDr: c.dr, closeCr: c.cr })
  }
  priorYearsProfit = round2(priorYearsProfit)
  if (Math.abs(priorYearsProfit) >= 0.005) {
    const s = split(-priorYearsProfit)
    rows.push({ code: '', name: 'Retained earnings — profit of earlier years (not yet closed)', accountClass: 'Equity', openDr: s.dr, openCr: s.cr, debit: 0, credit: 0, closeDr: s.dr, closeCr: s.cr })
  }
  const keys = ['openDr', 'openCr', 'debit', 'credit', 'closeDr', 'closeCr']
  const totals = totalsOf(rows, 'TOTAL', keys, 'code')
  const diffClose = round2(Number(totals.closeDr) - Number(totals.closeCr))
  const diffMove = round2(Number(totals.debit) - Number(totals.credit))
  const balanced = Math.abs(diffClose) < regionalMoneyTolerance() && Math.abs(diffMove) < regionalMoneyTolerance()
  const periodText = from ? shortRange(from, to) : `Up to ${formatDate(to)}`
  const report: ProReport = {
    ...(await baseReport(req, 'trial-balance', 'Trial Balance', 'Trial balance')),
    periodLabel: periodText,
    summaryLine: `For the period ${periodText}  |  Closing balances as at ${formatDate(to)}  |  ${plural(rows.length, 'account')}`,
    kpis: [
      { label: 'Period debits', value: Number(totals.debit), hint: 'Posted in the period' },
      { label: 'Period credits', value: Number(totals.credit), hint: 'Posted in the period' },
      { label: 'Closing balance', value: Number(totals.closeDr), hint: `Debits = credits as at ${formatDate(to)}` },
      { label: 'Status', value: balanced ? 'Balanced' : 'Out of balance', format: 'text', hint: balanced ? 'Books are in balance' : `Difference ${formatMoney(diffClose || diffMove)}`, tone: 'dark' },
    ],
    sections: [{
      type: 'table', id: 'accounts', title: 'Trial balance', subtitle: 'Opening balance, movements in the period and closing balance, by account code', primary: true,
      columns: [
        { key: 'code', label: 'Code', format: 'code', width: 0.6 }, { key: 'name', label: 'Account', width: 2.4 }, { key: 'accountClass', label: 'Type', width: 0.75 },
        { key: 'openDr', label: 'Opening Dr', format: 'money' }, { key: 'openCr', label: 'Opening Cr', format: 'money' },
        { key: 'debit', label: 'Period Dr', format: 'money' }, { key: 'credit', label: 'Period Cr', format: 'money' },
        { key: 'closeDr', label: 'Closing Dr', format: 'money' }, { key: 'closeCr', label: 'Closing Cr', format: 'money' },
      ],
      rows,
      totals,
    }],
  }
  await sendProReport(res, format, report, { accounts: rows, balanced })
})

// ── Sales-tax / VAT / GST return summary ────────────────────────────────────

router.get('/vat-summary', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const from = parseDay(fromDate)
  const to = parseDay(toDate) ?? todayInZone()
  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted', entryDate: { ...(from && { gte: from }), lt: new Date(to.getTime() + 86_400_000) } }
  if (branchId) entryWhere.branchId = branchId

  // From Output / Input tax account activity captured at posting time, so the
  // figures match the general ledger exactly
  const [outputMapping, inputMapping, accounts] = await Promise.all([
    prisma.accountingMapping.findUnique({ where: { organizationId_key: { organizationId: orgId, key: 'OUTPUT_VAT' } } }),
    prisma.accountingMapping.findUnique({ where: { organizationId_key: { organizationId: orgId, key: 'INPUT_VAT' } } }),
    statementAccounts(orgId),
  ])
  const [outputLines, inputLines, sums] = await Promise.all([
    outputMapping ? prisma.journalLine.findMany({ where: { accountId: outputMapping.accountId, journalEntry: entryWhere }, select: { debitAmount: true, creditAmount: true } }) : Promise.resolve([]),
    inputMapping ? prisma.journalLine.findMany({ where: { accountId: inputMapping.accountId, journalEntry: entryWhere }, select: { debitAmount: true, creditAmount: true, journalEntry: { select: { sourceType: true } } } }) : Promise.resolve([]),
    netByAccount(orgId, { from, to }, branchId || undefined),
  ])
  const outputTax = round2(outputLines.reduce((s, l) => s + Number(l.creditAmount) - Number(l.debitAmount), 0))
  let onExpenses = 0, onPurchases = 0, other = 0
  for (const l of inputLines) {
    const n = Number(l.debitAmount) - Number(l.creditAmount)
    if (l.journalEntry.sourceType === 'EXPENSE') onExpenses += n
    else if (l.journalEntry.sourceType === 'BILL') onPurchases += n
    else other += n
  }
  onExpenses = round2(onExpenses); onPurchases = round2(onPurchases); other = round2(other)
  const inputTax = round2(onExpenses + onPurchases + other)
  const net = round2(outputTax - inputTax)
  const taxableSales = round2(accounts.filter((a) => a.accountClass === 'REVENUE' && pnlGroup(a) !== 'other_income').reduce((t, a) => { const s = sums.get(a.id); return t + (s ? s.credit - s.debit : 0) }, 0))
  const T = tax()
  const rows: ReportRow[] = [
    { line: 'Sales and output tax', _style: 'heading' },
    { line: `Taxable sales (excluding ${T})`, base: taxableSales, amount: null, _style: 'indent' },
    { line: `Output ${T} charged on sales`, base: null, amount: outputTax, _style: 'indent' },
    { line: 'Purchases and input tax', _style: 'heading' },
    { line: `Input ${T} on expenses`, base: null, amount: -onExpenses, _style: 'indent' },
    { line: `Input ${T} on supplier purchases`, base: null, amount: -onPurchases, _style: 'indent' },
    ...(Math.abs(other) >= 0.005 ? [{ line: `Input ${T} — other`, base: null, amount: -other, _style: 'indent' as const }] : []),
    { line: `Total input ${T}`, base: null, amount: -inputTax, _style: 'subtotal' },
    { _style: 'spacer' },
    { line: net >= 0 ? `Net ${T} payable to the tax authority` : `Net ${T} refundable / carried forward`, base: null, amount: net, _style: 'total' },
  ]
  const periodText = from ? shortRange(from, to) : `Up to ${formatDate(to)}`
  const report: ProReport = {
    ...(await baseReport(req, 'vat-summary', `${T} Return Summary`, `${T} position`)),
    kind: 'statement',
    periodLabel: periodText,
    summaryLine: `Tax period ${periodText}  |  ${(await reportScope(prisma, orgId, branchId || undefined)).scopeLabel}`,
    kpis: [
      { label: `Output ${T}`, value: outputTax, hint: `Effective rate ${formatPercent(pct(outputTax, taxableSales))} of taxable sales` },
      { label: `Input ${T}`, value: inputTax, hint: 'Paid on expenses and purchases' },
      { label: 'Taxable sales', value: taxableSales, hint: `Excluding ${T}` },
      { label: net >= 0 ? `Net ${T} payable` : `Net ${T} refundable`, value: Math.abs(net), hint: `Output − input ${T}`, tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'computation', title: `${T} computation`, subtitle: `Tax period ${periodText}`, primary: true,
        columns: [{ key: 'line', label: 'Description', width: 3.6 }, { key: 'base', label: 'Taxable value', format: 'money' }, { key: 'amount', label: T, format: 'money' }],
        rows,
      },
      ...(!outputMapping || !inputMapping ? [{ type: 'note' as const, id: 'config', title: 'Configuration warning', tone: 'warning' as const, text: `The ${!outputMapping ? 'output' : 'input'} tax account mapping is not set, so those figures show as zero. Set it under Chart of Accounts → Settings.` }] : []),
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: `Figures come from posted activity on the mapped output and input ${T} accounts, so they agree with the general ledger. Use this summary to prepare the return; the official return form and filing deadlines are set by your tax authority.` },
    ],
  }
  await sendProReport(res, format, report, { fromDate: fromDate || null, toDate: toDate || null, vatCollected: outputTax, vatPaidExpenses: onExpenses, vatPaidBills: onPurchases, vatPaid: inputTax, netVatPayable: net, taxableSales, configured: { outputVat: !!outputMapping, inputVat: !!inputMapping } })
})

export default router
