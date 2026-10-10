import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { scopeReportBranch } from '../utils/branchScope'
import { requireAnyPermission, requireExportPermission } from '../middleware/authorize'
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
router.use(scopeReportBranch)
router.use(requireExportPermission)

function dateRangeFilter(fromDate?: string, toDate?: string) {
  if (!fromDate && !toDate) return undefined
  return {
    ...(fromDate && { gte: new Date(fromDate) }),
    ...(toDate && { lte: new Date(toDate) }),
  }
}

const asOfLabel = (toDate?: string) => (toDate ? toDate : new Date().toISOString().slice(0, 10))

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

router.get('/daily-sales', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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
        { key: 'vat', label: 'VAT', format: 'money' }, { key: 'net', label: 'Net sales', format: 'money' },
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
        { key: 'vat', label: 'VAT', format: 'money' as const }, { key: 'net', label: 'Net sales', format: 'money' as const },
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
        { key: 'vat', label: 'VAT', format: 'money' }, { key: 'net', label: 'Net sales', format: 'money' },
        { key: 'status', label: 'Status', format: 'status' },
      ],
      rows: register,
      totals: totalsOf(register, 'TOTAL', moneyKeys, 'saleNo'),
    },
  ]

  const report: ProReport = {
    ...(await baseReport(req, 'daily-sales', 'Sales Report', 'Sales at a glance', sales.map((s) => s.saleDate))),
    summaryLine: '',
    kpis: [
      { label: 'Net sales', value: net, hint: `${plural(sales.length, 'sale')} over ${plural(days, 'day')}` },
      { label: 'VAT collected', value: vat, hint: `${pct(vat, gross).toFixed(1)}% of gross sales` },
      { label: 'Average per day', value: days > 0 ? round2(net / days) : 0, hint: 'Net sales ÷ trading days' },
      { label: 'Gross sales', value: gross, hint: 'Including VAT', tone: 'dark' },
    ],
    sections,
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(sales.length, 'sale')}  |  ${plural(days, 'trading day')}  |  ${plural(branchCount, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: register })
})

// ── Branch Sales Comparison ─────────────────────────────────────────────────

router.get('/branch-sales', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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
      { label: 'Top branch', value: top && top.totalSales > 0 ? top.branch : '—', format: 'text', hint: top && top.totalSales > 0 ? `${fmtMoney(top.totalSales)} · ${pct(top.totalSales, total).toFixed(1)}% share` : 'No sales in period', tone: 'dark' },
    ],
    sections: [{
      type: 'table', id: 'branches', title: 'Branch ranking', subtitle: 'Ranked by net sales, highest first', primary: true,
      columns: [
        { key: 'rank', label: '#', format: 'integer', width: 0.4 }, { key: 'branch', label: 'Branch' },
        { key: 'saleCount', label: 'Sales', format: 'integer' }, { key: 'avgSaleValue', label: 'Avg sale', format: 'money' },
        { key: 'totalVat', label: 'VAT', format: 'money' }, { key: 'grossSales', label: 'Gross sales', format: 'money' },
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

router.get('/branch-profit', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: 'Operational view: net sales from approved daily sales, minus supplier purchases (bills, including VAT) and operating expenses. Payments made against purchases are not counted again. For the accounting view use the Profit & Loss statement, which is built from posted journal entries.' },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(rows.length, 'branch', 'branches')}`
  await sendProReport(res, format, report, { data: rows })
})

// ── Cash Closing ────────────────────────────────────────────────────────────

router.get('/cash-closing', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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
      { label: 'Cash counted', value: counted, hint: `${pct(counted, expected).toFixed(1)}% of expected` },
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

router.get('/expenses', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const expenseDate = dateRangeFilter(fromDate, toDate)

  const expenses = await prisma.expense.findMany({
    where: { organizationId: orgId, ...(branchId && { branchId }), status: { not: 'void' }, ...(expenseDate && { expenseDate }) },
    include: { branch: { select: { name: true } }, category: { select: { name: true } } },
    orderBy: { expenseDate: 'desc' },
  })

  const manual = expenses.filter((e) => e.source !== 'purchasing')
  const purchasePayments = expenses.filter((e) => e.source === 'purchasing')
  const total = sum(expenses, (e) => e.totalAmount)
  const vat = sum(expenses, (e) => e.vatAmount)
  const pending = expenses.filter((e) => e.status === 'draft' || e.status === 'submitted')

  const monthly = monthlyRows(expenses, (e) => e.expenseDate, {
    operating: (e) => (e.source === 'purchasing' ? 0 : e.totalAmount),
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
    description: e.description, type: e.source === 'purchasing' ? 'Purchase payment' : 'Manual',
    paymentMethod: e.paymentMethod.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    amount: e.amount, vat: e.vatAmount, totalAmount: e.totalAmount, status: e.status,
  }))

  const report: ProReport = {
    ...(await baseReport(req, 'expenses', 'Expense Report', 'Expenses at a glance', expenses.map((e) => e.expenseDate))),
    summaryLine: '',
    kpis: [
      { label: 'Total expenses', value: total, hint: `Includes VAT · ${plural(expenses.length, 'entry', 'entries')}` },
      { label: 'Operating expenses', value: sum(manual, (e) => e.totalAmount), hint: `${pct(sum(manual, (e) => e.totalAmount), total).toFixed(1)}% · manual entries` },
      { label: 'Purchase payments', value: sum(purchasePayments, (e) => e.totalAmount), hint: `${plural(purchasePayments.length, 'payment')} against purchases` },
      { label: 'Top category', value: topCat ? String(topCat.category) : '—', format: 'text', hint: topCat ? `${fmtMoney(Number(topCat.total))} · ${Number(topCat.share).toFixed(1)}% of total` : 'No expenses in period', tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'monthly', title: 'Monthly expense summary',
        columns: [
          { key: 'month', label: 'Month' }, { key: 'count', label: 'Entries', format: 'integer' },
          { key: 'operating', label: 'Operating', format: 'money' }, { key: 'purchasePayments', label: 'Purchase payments', format: 'money' },
          { key: 'vat', label: 'VAT', format: 'money' }, { key: 'total', label: 'Total', format: 'money' },
        ],
        rows: monthly,
        totals: totalsOf(monthly, 'TOTAL', ['count', 'operating', 'purchasePayments', 'vat', 'total'], 'month'),
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
          { key: 'amount', label: 'Net amount', format: 'money' }, { key: 'vat', label: 'VAT', format: 'money' },
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
          { key: 'amount', label: 'Net', format: 'money' }, { key: 'vat', label: 'VAT', format: 'money' },
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
router.get('/purchases', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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

  // Reconciliation: every bill should satisfy subtotal + VAT − discount = total
  // and total − paid = balance (to the cent).
  const mismatched = bills.filter((b) =>
    Math.abs(b.subtotal + b.vatAmount - b.discountAmount - b.totalAmount) > 0.01 ||
    Math.abs(b.totalAmount - b.paidAmount - b.balanceDue) > 0.01)
  const paidWithResidue = bills.filter((b) => b.status === 'paid' && Math.abs(b.balanceDue) >= 0.005)
  const reconText = [
    mismatched.length === 0
      ? `All ${plural(bills.length, 'purchase')} reconcile: subtotal + VAT = total, and total − paid = balance.`
      : `${plural(mismatched.length, 'purchase')} do not reconcile (subtotal + VAT ≠ total, or total − paid ≠ balance): ${mismatched.slice(0, 8).map((b) => b.billNo).join(', ')}${mismatched.length > 8 ? '…' : ''}.`,
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
      { label: 'Total purchases', value: total, hint: `Includes VAT · ${plural(bills.length, 'purchase')}` },
      { label: 'Amount paid', value: paid, hint: `${pct(paid, total).toFixed(1)}% of total purchase value` },
      { label: 'Balance due', value: balance, hint: `${pct(balance, total).toFixed(1)}% of total purchase value`, tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'monthly', title: 'Monthly purchase summary',
        columns: [
          { key: 'month', label: 'Month' }, { key: 'count', label: 'Purchases', format: 'integer' },
          { key: 'subtotal', label: 'Subtotal', format: 'money' }, { key: 'vat', label: 'VAT', format: 'money' },
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
        subtitle: `All ${plural(supplierCount, 'supplier')}  |  Ranked by balance due, highest first  |  Amounts include VAT`,
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
          { key: 'subtotal', label: 'Subtotal', format: 'money' }, { key: 'vat', label: 'VAT', format: 'money', width: 1 },
          { key: 'totalAmount', label: 'Total amount', format: 'money' }, { key: 'paidAmount', label: 'Paid amount', format: 'money' },
          { key: 'balanceDue', label: 'Balance due', format: 'money' }, { key: 'status', label: 'Status', format: 'status' },
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

router.get('/supplier-payable', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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
      { label: 'Not yet due', value: round2(outstanding - overdueAmt), hint: `${pct(outstanding - overdueAmt, outstanding).toFixed(1)}% of outstanding`, tone: 'positive' },
      { label: 'Over 90 days', value: over90, hint: `${pct(over90, outstanding).toFixed(1)}% of outstanding`, tone: over90 > 0 ? 'negative' : 'default' },
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

router.get('/inventory-stock', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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

// ── Wastage ─────────────────────────────────────────────────────────────────

router.get('/wastage', requireAnyPermission('can_view_reports'), async (req: Request, res: Response) => {
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
      { label: 'Approved & posted', value: approvedValue, hint: `${pct(approvedValue, value).toFixed(1)}% of wastage value`, tone: 'positive' },
      { label: 'Pending approval', value: round2(value - approvedValue), hint: plural(reports.filter((r) => r.status !== 'approved').length, 'report'), tone: value - approvedValue > 0.005 ? 'warning' : 'default' },
      { label: 'Top item', value: itemRows[0] ? String(itemRows[0].item) : '—', format: 'text', hint: itemRows[0] ? `${fmtMoney(Number(itemRows[0].value))} · ${Number(itemRows[0].share).toFixed(1)}% of losses` : 'No wastage in period', tone: 'dark' },
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

router.get('/audit-log', requireAnyPermission('can_view_audit_logs'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const createdAt = dateRangeFilter(fromDate, toDate)

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

// ── Profit & Loss ───────────────────────────────────────────────────────────

// Expense reportingGroups that roll up into Cost of Sales rather than
// Operating Expenses on the P&L — mirrors the standard 5xxx chart section.
const COST_OF_SALES_GROUPS = new Set(['Cost of Sales', 'Wastage', 'Direct Costs'])

// Built entirely from posted JournalLine data (never combined with
// operational-table totals, which could double-count or diverge from what's
// actually posted to the ledger).
router.get('/profit-loss', requireAnyPermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  const entryDate = dateRangeFilter(fromDate, toDate)
  if (entryDate) entryWhere.entryDate = entryDate

  const accounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE', accountClass: { in: ['REVENUE', 'EXPENSE'] } },
    select: { id: true, code: true, name: true, accountClass: true, reportingGroup: true, normalBalance: true },
    orderBy: { code: 'asc' },
  })
  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: entryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })

  const sums = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const s = sums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    sums.set(l.accountId, s)
  }

  const rows = accounts
    .map((a) => {
      const s = sums.get(a.id) ?? { debit: 0, credit: 0 }
      const balance = a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit
      return { ...a, balance }
    })
    .filter((r) => Math.abs(r.balance) > 0.005)

  const otherIncomeRows = rows.filter((r) => r.accountClass === 'REVENUE' && r.reportingGroup === 'Other Income')
  const discountRows = rows.filter((r) => r.accountClass === 'REVENUE' && r.reportingGroup === 'Discounts')
  const grossRevenueRows = rows.filter((r) => r.accountClass === 'REVENUE' && r.reportingGroup !== 'Other Income' && r.reportingGroup !== 'Discounts')
  const costOfSalesRows = rows.filter((r) => r.accountClass === 'EXPENSE' && COST_OF_SALES_GROUPS.has(r.reportingGroup ?? ''))
  const opexRows = rows.filter((r) => r.accountClass === 'EXPENSE' && !COST_OF_SALES_GROUPS.has(r.reportingGroup ?? ''))

  const grossRevenue = grossRevenueRows.reduce((s, r) => s + r.balance, 0)
  const discounts = discountRows.reduce((s, r) => s + r.balance, 0)
  const netRevenue = grossRevenue - discounts
  const costOfSales = costOfSalesRows.reduce((s, r) => s + r.balance, 0)
  const grossProfit = netRevenue - costOfSales
  const operatingExpenses = opexRows.reduce((s, r) => s + r.balance, 0)
  const otherIncome = otherIncomeRows.reduce((s, r) => s + r.balance, 0)
  const netProfit = grossProfit - operatingExpenses + otherIncome

  const lines_ = [
    { name: 'Revenue', amount: 0, type: 'header' as const },
    ...grossRevenueRows.map((r) => ({ name: r.name, amount: r.balance, type: 'line' as const })),
    ...(discounts > 0.005 ? [{ name: 'Sales Returns and Discounts', amount: -discounts, type: 'line' as const }] : []),
    { name: 'Net Revenue', amount: netRevenue, type: 'subtotal' as const },
    { name: 'Cost of Sales', amount: 0, type: 'header' as const },
    ...costOfSalesRows.map((r) => ({ name: r.name, amount: r.balance, type: 'line' as const })),
    { name: 'Gross Profit', amount: grossProfit, type: 'subtotal' as const },
    { name: 'Operating Expenses', amount: 0, type: 'header' as const },
    ...opexRows.map((r) => ({ name: r.name, amount: r.balance, type: 'line' as const })),
    ...(Math.abs(otherIncome) > 0.005 ? [{ name: 'Other Income', amount: otherIncome, type: 'line' as const }] : []),
    { name: 'Net Profit', amount: netProfit, type: 'subtotal' as const },
  ]

  const codeOf = new Map(rows.map((r) => [r.name, r.code]))
  const statementRows: ReportRow[] = lines_.map((l) => ({
    code: l.type === 'line' ? codeOf.get(l.name) ?? '' : '',
    name: l.name,
    amount: l.type === 'header' ? null : round2(l.amount),
    share: l.type === 'header' ? null : pct(l.amount, netRevenue),
    _style: l.type === 'header' ? 'heading' : l.type === 'subtotal' ? 'subtotal' : 'indent',
  }))

  const report: ProReport = {
    ...(await baseReport(req, 'profit-loss', 'Profit & Loss Statement', 'Profit & loss')),
    summaryLine: '',
    kpis: [
      { label: 'Net revenue', value: round2(netRevenue), hint: discounts > 0.005 ? `After ${fmtMoney(discounts)} discounts` : 'From posted journal entries' },
      { label: 'Gross profit', value: round2(grossProfit), hint: `${pct(grossProfit, netRevenue).toFixed(1)}% gross margin`, tone: grossProfit >= 0 ? 'default' : 'negative' },
      { label: 'Operating expenses', value: round2(operatingExpenses), hint: `${pct(operatingExpenses, netRevenue).toFixed(1)}% of revenue` },
      { label: 'Net profit', value: round2(netProfit), hint: `${pct(netProfit, netRevenue).toFixed(1)}% net margin`, tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'statement', title: 'Statement', subtitle: 'Accounts with posted activity in the period', primary: true,
        columns: [{ key: 'code', label: 'Account', format: 'code', width: 0.8 }, { key: 'name', label: 'Line item', width: 3.2 }, { key: 'amount', label: 'Amount', format: 'money' }, { key: 'share', label: '% of revenue', format: 'percent' }],
        rows: statementRows,
      },
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: 'Prepared from posted journal entries only — drafts and unapproved records are excluded. Cost of sales includes the Cost of Sales, Wastage and Direct Costs reporting groups.' },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(rows.length, 'account')} with activity`
  await sendProReport(res, format, report, { revenue: netRevenue, expenses: costOfSales + operatingExpenses, grossProfit, netProfit, lines: lines_ })
})

// ── Trial Balance ───────────────────────────────────────────────────────────

router.get('/trial-balance', requireAnyPermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  const entryDate = dateRangeFilter(fromDate, toDate)
  if (entryDate) entryWhere.entryDate = entryDate

  const accounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE' },
    orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
  })
  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: entryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })

  const sums = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const s = sums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    sums.set(l.accountId, s)
  }

  const rows = accounts
    .map((a) => {
      const s = sums.get(a.id) ?? { debit: 0, credit: 0 }
      return { code: a.code, name: a.name, accountClass: a.accountClass, debit: round2(s.debit), credit: round2(s.credit) }
    })
    .filter((r) => r.debit > 0 || r.credit > 0)
    .sort((a, b) => a.code.localeCompare(b.code))

  const totalDebit = sum(rows, (r) => r.debit)
  const totalCredit = sum(rows, (r) => r.credit)
  const diff = round2(totalDebit - totalCredit)
  const classLabel: Record<string, string> = { ASSET: 'Asset', LIABILITY: 'Liability', EQUITY: 'Equity', REVENUE: 'Revenue', EXPENSE: 'Expense' }
  const tableRows: ReportRow[] = rows.map((r) => ({ ...r, accountClass: classLabel[r.accountClass] ?? r.accountClass, net: round2(r.debit - r.credit) }))

  const report: ProReport = {
    ...(await baseReport(req, 'trial-balance', 'Trial Balance', 'Trial balance')),
    summaryLine: '',
    kpis: [
      { label: 'Total debits', value: totalDebit, hint: plural(rows.length, 'account') },
      { label: 'Total credits', value: totalCredit, hint: 'Posted entries only' },
      { label: 'Difference', value: diff, hint: Math.abs(diff) < 0.01 ? 'Books are in balance' : 'Debits ≠ credits — investigate', tone: Math.abs(diff) < 0.01 ? 'positive' : 'negative' },
      { label: 'Status', value: Math.abs(diff) < 0.01 ? 'Balanced' : 'Out of balance', format: 'text', hint: `As of ${asOfLabel(toDate)}`, tone: 'dark' },
    ],
    sections: [{
      type: 'table', id: 'accounts', title: 'Account balances', subtitle: 'Ordered by account code', primary: true,
      columns: [{ key: 'code', label: 'Code', format: 'code', width: 0.8 }, { key: 'name', label: 'Account', width: 2.8 }, { key: 'accountClass', label: 'Type', width: 1 }, { key: 'debit', label: 'Debit', format: 'money' }, { key: 'credit', label: 'Credit', format: 'money' }, { key: 'net', label: 'Net (Dr − Cr)', format: 'money' }],
      rows: tableRows,
      totals: { code: 'TOTAL', debit: totalDebit, credit: totalCredit, net: diff },
    }],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${plural(rows.length, 'account')} with activity`
  await sendProReport(res, format, report, { accounts: rows })
})

// ── Balance Sheet ───────────────────────────────────────────────────────────

// Assets, Liabilities & Equity as of a date. Current Year Earnings is
// computed live from Revenue − Expenses for the fiscal year to date rather
// than stored, since there is no year-end closing-entry workflow yet; it is
// reported here but excluded from the real Equity account list to avoid
// double-counting if that account exists.
router.get('/balance-sheet', requireAnyPermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const asOf = toDate ? new Date(toDate) : new Date()

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted', entryDate: { lte: asOf } }
  if (branchId) entryWhere.branchId = branchId

  const [org, accounts] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { fiscalYearStart: true } }),
    prisma.account.findMany({
      where: { organizationId: orgId, status: 'ACTIVE', accountClass: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
      orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
    }),
  ])

  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: entryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })

  const sums = new Map<string, { debit: number; credit: number }>()
  for (const l of lines) {
    const s = sums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    sums.set(l.accountId, s)
  }

  const rows = accounts.map((a) => {
    const s = sums.get(a.id) ?? { debit: 0, credit: 0 }
    const balance = a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit
    return { code: a.code, name: a.name, accountType: a.accountClass, reportingGroup: a.reportingGroup, balance }
  }).filter((r) => r.balance !== 0)

  const assets = rows.filter((r) => r.accountType === 'ASSET')
  const liabilities = rows.filter((r) => r.accountType === 'LIABILITY')
  const equity = rows.filter((r) => r.accountType === 'EQUITY' && r.reportingGroup !== 'Current Year Earnings')

  const fyStart = fiscalYearStartFor(asOf, org?.fiscalYearStart ?? '01-01')
  const pnlEntryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted', entryDate: { gte: fyStart, lte: asOf } }
  if (branchId) pnlEntryWhere.branchId = branchId

  const pnlAccounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE', accountClass: { in: ['REVENUE', 'EXPENSE'] } },
    select: { id: true, accountClass: true, normalBalance: true },
  })
  const pnlLines = await prisma.journalLine.findMany({
    where: { journalEntry: pnlEntryWhere },
    select: { accountId: true, debitAmount: true, creditAmount: true },
  })
  const pnlSums = new Map<string, { debit: number; credit: number }>()
  for (const l of pnlLines) {
    const s = pnlSums.get(l.accountId) ?? { debit: 0, credit: 0 }
    s.debit += Number(l.debitAmount)
    s.credit += Number(l.creditAmount)
    pnlSums.set(l.accountId, s)
  }
  let revenueTotal = 0
  let expenseTotal = 0
  for (const a of pnlAccounts) {
    const s = pnlSums.get(a.id) ?? { debit: 0, credit: 0 }
    const balance = a.normalBalance === 'DEBIT' ? s.debit - s.credit : s.credit - s.debit
    if (a.accountClass === 'REVENUE') revenueTotal += balance
    else expenseTotal += balance
  }
  const currentYearEarnings = revenueTotal - expenseTotal

  const totalAssets = assets.reduce((s, r) => s + r.balance, 0)
  const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0)
  const totalEquity = equity.reduce((s, r) => s + r.balance, 0) + currentYearEarnings

  const equityRows = [
    ...equity.map(({ code, name, balance }) => ({ code, name, balance })),
    { code: '3300', name: 'Current Year Earnings', balance: currentYearEarnings },
  ]

  const legacy = {
    asOf: asOf.toISOString(),
    assets: assets.map(({ code, name, balance }) => ({ code, name, balance })),
    liabilities: liabilities.map(({ code, name, balance }) => ({ code, name, balance })),
    equity: equityRows,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netPosition: totalAssets - totalLiabilities,
    // Assets = Liabilities + Equity
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
  }

  const section = (id: string, title: string, list: { code: string; name: string; balance: number }[], total: number): ReportSection => ({
    type: 'table', id, title,
    columns: [{ key: 'code', label: 'Code', format: 'code', width: 0.8 }, { key: 'name', label: 'Account', width: 3.2 }, { key: 'balance', label: 'Balance', format: 'money' }],
    rows: list.map((r) => ({ code: r.code, name: r.name, balance: round2(r.balance) })),
    totals: { code: `TOTAL ${title.toUpperCase()}`, balance: round2(total) },
    emptyMessage: 'No balances',
  })

  const report: ProReport = {
    ...(await baseReport(req, 'balance-sheet', 'Balance Sheet', 'Financial position')),
    periodLabel: `As of ${asOf.toISOString().slice(0, 10)}`,
    summaryLine: '',
    kpis: [
      { label: 'Total assets', value: round2(totalAssets), hint: plural(assets.length, 'account') },
      { label: 'Total liabilities', value: round2(totalLiabilities), hint: plural(liabilities.length, 'account') },
      { label: 'Total equity', value: round2(totalEquity), hint: `Incl. ${fmtMoney(currentYearEarnings)} current-year earnings` },
      { label: 'Assets = Liab. + Equity', value: legacy.balanced ? 'Balanced' : 'Out of balance', format: 'text', hint: legacy.balanced ? 'Books balance' : `Difference ${fmtMoney(totalAssets - totalLiabilities - totalEquity)}`, tone: 'dark' },
    ],
    sections: [
      section('assets', 'Assets', legacy.assets, totalAssets),
      section('liabilities', 'Liabilities', legacy.liabilities, totalLiabilities),
      section('equity', 'Equity', equityRows, totalEquity),
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: `Balances from posted journal entries up to ${asOf.toISOString().slice(0, 10)}. Current Year Earnings is computed live as revenue minus expenses since the fiscal year start (${fyStart.toISOString().slice(0, 10)}).` },
    ],
  }
  report.summaryLine = `As of ${asOf.toISOString().slice(0, 10)}  |  ${plural(rows.length, 'account')} with balances`
  await sendProReport(res, format, report, legacy)
})

// ── VAT Summary ─────────────────────────────────────────────────────────────

router.get('/vat-summary', requireAnyPermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  const entryDate = dateRangeFilter(fromDate, toDate)
  if (entryDate) entryWhere.entryDate = entryDate

  // Sourced from Output VAT / Input VAT account activity (captured at
  // posting time) rather than raw vatAmount fields on operational records —
  // changing an account's default tax rate later never alters these figures.
  const [outputMapping, inputMapping] = await Promise.all([
    prisma.accountingMapping.findUnique({ where: { organizationId_key: { organizationId: orgId, key: 'OUTPUT_VAT' } } }),
    prisma.accountingMapping.findUnique({ where: { organizationId_key: { organizationId: orgId, key: 'INPUT_VAT' } } }),
  ])

  const [outputLines, inputLines] = await Promise.all([
    outputMapping
      ? prisma.journalLine.findMany({ where: { accountId: outputMapping.accountId, journalEntry: entryWhere }, select: { debitAmount: true, creditAmount: true } })
      : Promise.resolve([]),
    inputMapping
      ? prisma.journalLine.findMany({
          where: { accountId: inputMapping.accountId, journalEntry: entryWhere },
          select: { debitAmount: true, creditAmount: true, journalEntry: { select: { sourceType: true } } },
        })
      : Promise.resolve([]),
  ])

  const vatCollected = outputLines.reduce((s, l) => s + Number(l.creditAmount) - Number(l.debitAmount), 0)

  let vatPaidExpenses = 0
  let vatPaidBills = 0
  let vatPaidOther = 0
  for (const l of inputLines) {
    const net = Number(l.debitAmount) - Number(l.creditAmount)
    if (l.journalEntry.sourceType === 'EXPENSE') vatPaidExpenses += net
    else if (l.journalEntry.sourceType === 'BILL') vatPaidBills += net
    else vatPaidOther += net
  }
  const vatPaid = vatPaidExpenses + vatPaidBills + vatPaidOther
  const net = vatCollected - vatPaid

  const legacy = {
    fromDate: fromDate || null,
    toDate: toDate || null,
    vatCollected,
    vatPaidExpenses,
    vatPaidBills,
    vatPaid,
    netVatPayable: net,
    configured: { outputVat: !!outputMapping, inputVat: !!inputMapping },
  }

  const breakdown: ReportRow[] = [
    { line: 'Output VAT — collected on sales', amount: round2(vatCollected), _style: 'indent' },
    { line: 'Input VAT — paid on expenses', amount: round2(-vatPaidExpenses), _style: 'indent' },
    { line: 'Input VAT — paid on supplier purchases', amount: round2(-vatPaidBills), _style: 'indent' },
    ...(Math.abs(vatPaidOther) > 0.005 ? [{ line: 'Input VAT — other', amount: round2(-vatPaidOther), _style: 'indent' as const }] : []),
    { line: net >= 0 ? 'Net VAT payable to authority' : 'Net VAT refundable', amount: round2(net), _style: 'subtotal' },
  ]

  const report: ProReport = {
    ...(await baseReport(req, 'vat-summary', 'VAT / Tax Summary', 'VAT position')),
    summaryLine: '',
    kpis: [
      { label: 'Output VAT', value: round2(vatCollected), hint: 'Collected on sales' },
      { label: 'Input VAT', value: round2(vatPaid), hint: 'Paid on expenses & purchases' },
      { label: 'Recovery rate', value: pct(vatPaid, vatCollected), format: 'percent', hint: 'Input ÷ output VAT' },
      { label: net >= 0 ? 'Net VAT payable' : 'Net VAT refundable', value: round2(Math.abs(net)), hint: 'Output − input VAT', tone: 'dark' },
    ],
    sections: [
      {
        type: 'table', id: 'breakdown', title: 'VAT computation', primary: true,
        columns: [{ key: 'line', label: 'Line', width: 4 }, { key: 'amount', label: 'Amount', format: 'money' }],
        rows: breakdown,
      },
      ...(!outputMapping || !inputMapping ? [{ type: 'note' as const, id: 'config', title: 'Configuration warning', tone: 'warning' as const, text: `${!outputMapping ? 'Output VAT' : ''}${!outputMapping && !inputMapping ? ' and ' : ''}${!inputMapping ? 'Input VAT' : ''} account mapping is not configured — those figures show as zero. Set it under Chart of Accounts → Settings.` }] : []),
      { type: 'note', id: 'basis', title: 'Basis of preparation', text: 'Figures come from posted activity on the mapped Output VAT and Input VAT accounts, so they match the general ledger exactly.' },
    ],
  }
  report.summaryLine = `Period: ${report.periodLabel}  |  ${report.scopeLabel}`
  await sendProReport(res, format, report, legacy)
})

export default router
