import { roundMoney as regionalRoundMoney } from '../utils/money'

import { moneyTolerance as regionalMoneyTolerance } from '../utils/money'
import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { withReportingScope } from '../middleware/reportScope'
import { withReportFormat } from '../utils/reportFormat'
import { requireModule, requirePermission } from '../middleware/authorize'
import { ProReport, ReportRow, ReportColumn, sendProReport, reportScope, periodLabelFor, plural, round2 } from '../utils/proReport'
import { todayInZone, formatMoney } from '../utils/reportFormat'
import { netByAccount } from '../services/financialStatements'
import { getEverStockedKeys, isNeverStocked } from '../utils/stock'

const router = Router()

router.use(authenticate)
router.use(withReportingScope)
router.use(withReportFormat)
router.use(requireModule('reports'))

// GET /reports/dashboard
router.get('/dashboard', async (req: Request, res: Response) => {
  const { branchId } = req.query as { branchId?: string }
  const orgId = req.user.organizationId

  const now = new Date()
  const today = todayInZone()
  const endOfToday = new Date(today)
  endOfToday.setUTCHours(23, 59, 59, 999)

  const startOfWeek = new Date(today)
  startOfWeek.setUTCDate(today.getUTCDate() - today.getUTCDay())

  const startOfMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))

  const branchFilter = branchId ? { branchId } : {}
  const orgFilter = { organizationId: orgId }
  const notVoid = { status: { not: 'void' } }

  // Run all aggregations in parallel
  const [
    todaySales,
    monthSales,
    todayExpenses,
    monthExpenses,
    pendingApprovals,
    overdueBills,
    branches,
    auditLogs,
  ] = await Promise.all([
    prisma.dailySale.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: { gte: today, lte: endOfToday } },
      _sum: { netAmount: true },
    }),
    prisma.dailySale.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: { gte: startOfMonth } },
      _sum: { netAmount: true },
    }),
    prisma.expense.aggregate({
      where: { source: { not: 'purchasing' }, ...orgFilter, ...branchFilter, ...notVoid, expenseDate: { gte: today, lte: endOfToday } },
      _sum: { totalAmount: true },
    }),
    prisma.expense.aggregate({
      where: { source: { not: 'purchasing' }, ...orgFilter, ...branchFilter, ...notVoid, expenseDate: { gte: startOfMonth } },
      _sum: { totalAmount: true },
    }),
    Promise.all([
      prisma.dailySale.count({ where: { ...orgFilter, ...branchFilter, status: 'submitted' } }),
      prisma.expense.count({ where: { ...orgFilter, ...branchFilter, status: 'submitted' } }),
      prisma.cashClosing.count({ where: { ...orgFilter, ...branchFilter, status: 'submitted' } }),
    ]),
    prisma.bill.count({
      where: {
        ...orgFilter,
        ...(branchId ? branchFilter : {}),
        status: { notIn: ['paid', 'void'] },
        dueDate: { lt: now },
      },
    }),
    prisma.branch.findMany({
      where: { organizationId: orgId, isActive: true, ...(branchId ? { id: branchId } : {}) },
      select: { id: true, name: true },
    }),
    prisma.auditLog.findMany({
      where: { organizationId: orgId, ...(branchId ? { branchId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        action: true,
        module: true,
        createdAt: true,
        userEmail: true,
        resourceType: true,
        resourceRef: true,
      },
    }),
  ])

  // Low stock: compare quantityOnHand against the org-wide threshold when
  // set (overrides every item's individual reorder point), else per-item
  // reorder point. (Prisma does not support field-to-field comparisons.)
  // Catalog items that have sat at zero since creation (never actually
  // received via a purchase) are excluded — that's "not stocked yet," not
  // "critically low."
  const [allStocks, orgForThreshold, everStocked] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...(branchId ? { branchId } : {}) },
      select: { quantityOnHand: true, reorderPoint: true, branchId: true, itemId: true },
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
    getEverStockedKeys(prisma, orgId),
  ])
  const globalThreshold = orgForThreshold?.lowStockThreshold ?? null
  type StockRow = { quantityOnHand: number; reorderPoint: number; branchId: string; itemId: string }
  const lowStockCount = (allStocks as StockRow[]).filter(
    (s: StockRow) => !isNeverStocked(everStocked, s.branchId, s.itemId, s.quantityOnHand) && s.quantityOnHand < (globalThreshold ?? s.reorderPoint)
  ).length

  // Cash position from most recent approved closings
  const latestClosings = await prisma.cashClosing.findMany({
    where: {
      organizationId: orgId,
      ...(branchId ? { branchId } : {}),
      status: 'approved',
    },
    orderBy: { closingDate: 'desc' },
    take: branchId ? 1 : 3,
    select: { actualCashCounted: true, cashDeposited: true },
  })

  const cashPosition = latestClosings.reduce(
    (sum: number, c: { actualCashCounted: number; cashDeposited: number }) =>
      sum + (c.actualCashCounted - c.cashDeposited),
    0
  )

  // Per-branch sales breakdown
  const branchSales = await Promise.all(
    branches.map(async (branch: { id: string; name: string }) => {
      const [todayB, weekB, monthB] = await Promise.all([
        prisma.dailySale.aggregate({
          where: { organizationId: orgId, branchId: branch.id, ...notVoid, saleDate: { gte: today, lte: endOfToday } },
          _sum: { netAmount: true },
        }),
        prisma.dailySale.aggregate({
          where: { organizationId: orgId, branchId: branch.id, ...notVoid, saleDate: { gte: startOfWeek } },
          _sum: { netAmount: true },
        }),
        prisma.dailySale.aggregate({
          where: { organizationId: orgId, branchId: branch.id, ...notVoid, saleDate: { gte: startOfMonth } },
          _sum: { netAmount: true },
        }),
      ])

      return {
        branchId: branch.id,
        branchName: branch.name,
        today: todayB._sum.netAmount ?? 0,
        thisWeek: weekB._sum.netAmount ?? 0,
        thisMonth: monthB._sum.netAmount ?? 0,
      }
    })
  )

  const totalPendingApprovals = pendingApprovals[0] + pendingApprovals[1] + pendingApprovals[2]

  const recentActivity = auditLogs.map(
    (log: {
      id: string
      action: string
      module: string
      createdAt: Date
      userEmail: string
      resourceType: string | null
      resourceRef: string | null
    }) => ({
      id: log.id,
      description: `${log.action} ${log.resourceType ?? ''} ${log.resourceRef ?? ''}`.trim(),
      module: log.module,
      createdAt: log.createdAt.toISOString(),
      userEmail: log.userEmail,
    })
  )

  res.json({
    totalSalesToday: todaySales._sum.netAmount ?? 0,
    totalSalesMonth: monthSales._sum.netAmount ?? 0,
    totalExpensesToday: todayExpenses._sum.totalAmount ?? 0,
    totalExpensesMonth: monthExpenses._sum.totalAmount ?? 0,
    cashPosition,
    pendingApprovals: totalPendingApprovals,
    overdueSupplierBills: overdueBills,
    lowStockItems: lowStockCount,
    branchSales,
    recentActivity,
  })
})

// GET /reports/financial
router.get('/financial', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const dateFilter: Record<string, Date> = {}
  if (fromDate) dateFilter.gte = new Date(fromDate)
  if (toDate) dateFilter.lte = new Date(toDate)
  const hasDateFilter = Object.keys(dateFilter).length > 0

  const [totalSales, totalExpenses, totalBills] = await Promise.all([
    prisma.dailySale.aggregate({
      where: {
        organizationId: orgId,
        ...(branchId && { branchId }),
        status: { not: 'void' },
        ...(hasDateFilter && { saleDate: dateFilter }),
      },
      _sum: { netAmount: true, vatAmount: true, totalAmount: true },
      _count: true,
    }),
    prisma.expense.aggregate({
      where: { source: { not: 'purchasing' },
        organizationId: orgId,
        ...(branchId && { branchId }),
        status: { not: 'void' },
        ...(hasDateFilter && { expenseDate: dateFilter }),
      },
      _sum: { totalAmount: true, vatAmount: true },
      _count: true,
    }),
    prisma.bill.aggregate({
      where: {
        organizationId: orgId,
        ...(branchId && { branchId }),
        status: { not: 'void' },
        ...(hasDateFilter && { billDate: dateFilter }),
      },
      _sum: { totalAmount: true, paidAmount: true, balanceDue: true },
      _count: true,
    }),
  ])

  // Supplier purchases (bills) count toward expenses alongside manually
  // recorded Expense entries.
  const combinedExpenses = (totalExpenses._sum.totalAmount ?? 0) + (totalBills._sum.totalAmount ?? 0)
  const grossProfit = (totalSales._sum.netAmount ?? 0) - combinedExpenses

  res.json({
    revenue: {
      totalSales: totalSales._sum.netAmount ?? 0,
      totalVatCollected: totalSales._sum.vatAmount ?? 0,
      saleCount: totalSales._count,
    },
    expenses: {
      totalExpenses: combinedExpenses,
      vatPaid: totalExpenses._sum.vatAmount ?? 0,
      expenseCount: totalExpenses._count,
    },
    payables: {
      totalBills: totalBills._sum.totalAmount ?? 0,
      totalPaid: totalBills._sum.paidAmount ?? 0,
      balanceDue: totalBills._sum.balanceDue ?? 0,
      billCount: totalBills._count,
    },
    grossProfit,
    netProfit: grossProfit,
  })
})

type DashboardRange = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'this_year' | 'overall'

// Resolves the selected filter-bar range to concrete date bounds. `start`
// is null for 'overall', meaning no lower bound (all-time up to `end`).
function getRangeBounds(range: DashboardRange, today: Date, endOfToday: Date): { start: Date | null; end: Date; label: string } {
  switch (range) {
    case 'today':
      return { start: today, end: endOfToday, label: 'Today' }
    case 'yesterday': {
      const start = new Date(today)
      start.setUTCDate(today.getUTCDate() - 1)
      const end = new Date(start)
      end.setUTCHours(23, 59, 59, 999)
      return { start, end, label: 'Yesterday' }
    }
    case 'this_week': {
      const start = new Date(today)
      start.setUTCDate(today.getUTCDate() - today.getUTCDay())
      return { start, end: endOfToday, label: 'This Week' }
    }
    case 'this_year': {
      const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1))
      return { start, end: endOfToday, label: 'This Year' }
    }
    case 'overall':
      return { start: null, end: endOfToday, label: 'Overall' }
    case 'this_month':
    default: {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      return { start, end: endOfToday, label: 'This Month' }
    }
  }
}

// The equivalent immediately-prior period, for the "vs previous period"
// growth comparisons. Null for 'overall' (nothing to compare against).
function getPreviousRangeBounds(range: DashboardRange, today: Date): { start: Date; end: Date } | null {
  switch (range) {
    case 'today': {
      const start = new Date(today)
      start.setUTCDate(today.getUTCDate() - 1)
      const end = new Date(start)
      end.setUTCHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'yesterday': {
      const start = new Date(today)
      start.setUTCDate(today.getUTCDate() - 2)
      const end = new Date(start)
      end.setUTCHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'this_week': {
      const currentStart = new Date(today)
      currentStart.setUTCDate(today.getUTCDate() - today.getUTCDay())
      const start = new Date(currentStart)
      start.setUTCDate(currentStart.getUTCDate() - 7)
      const end = new Date(currentStart)
      end.setUTCDate(currentStart.getUTCDate() - 1)
      end.setUTCHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'this_year': {
      const start = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1))
      const end = new Date(Date.UTC(today.getUTCFullYear() - 1, 11, 31, 23, 59, 59, 999))
      return { start, end }
    }
    case 'overall':
      return null
    case 'this_month':
    default: {
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
      const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0, 23, 59, 59, 999))
      return { start, end }
    }
  }
}

// GET /reports/dashboard-v2 — comprehensive data for premium dashboard
router.get('/dashboard-v2', async (req: Request, res: Response) => {
  const { branchId, range = 'this_month', compare = 'branch' } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const selectedRange = range as DashboardRange

  const now = new Date()
  const today = todayInZone()
  const endOfToday = new Date(today)
  endOfToday.setUTCHours(23, 59, 59, 999)

  const { start: rangeStart, end: rangeEnd, label: rangeLabel } = getRangeBounds(selectedRange, today, endOfToday)
  const dateFilter = { ...(rangeStart && { gte: rangeStart }), lte: rangeEnd }
  const previousRange = getPreviousRangeBounds(selectedRange, today)

  const notVoid = { status: { not: 'void' } }
  const orgFilter = { organizationId: orgId }
  const branchFilter = branchId ? { branchId } : {}

  // Number of calendar days in the selected range — used for "average per
  // day" figures instead of a fabricated "orders" concept this system has
  // no real data for. For 'overall' (no lower bound), falls back to the
  // earliest recorded sale.
  let daysInPeriod: number
  if (rangeStart) {
    daysInPeriod = Math.max(1, Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / 86400000) + 1)
  } else {
    const earliestSale = await prisma.dailySale.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid },
      _min: { saleDate: true },
    })
    const start = earliestSale._min.saleDate ?? rangeEnd
    daysInPeriod = Math.max(1, Math.floor((rangeEnd.getTime() - start.getTime()) / 86400000) + 1)
  }

  const branches = await prisma.branch.findMany({
    where: { ...orgFilter, isActive: true, ...(branchId ? { id: branchId } : {}) },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  })

  const branchTargets = await prisma.branchTarget.findMany({
    where: { ...orgFilter, year: today.getUTCFullYear(), month: today.getUTCMonth() + 1, ...(branchId ? { branchId } : {}) },
  })
  const targetMap: Record<string, number> = {}
  for (const t of branchTargets) targetMap[t.branchId] = t.salesTarget

  // ── Daily sales trend within the selected range (capped for readability) ──
  const MAX_TREND_DAYS = 180
  let trendStart: Date
  if (rangeStart) {
    const spanDays = Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / 86400000) + 1
    if (spanDays > MAX_TREND_DAYS) {
      trendStart = new Date(rangeEnd)
      trendStart.setUTCDate(rangeEnd.getUTCDate() - MAX_TREND_DAYS + 1)
    } else {
      trendStart = rangeStart
    }
  } else {
    // 'overall' has no lower bound for totals, but the trend chart shows a
    // recent trailing window rather than querying literally all-time rows.
    trendStart = new Date(rangeEnd)
    trendStart.setUTCDate(rangeEnd.getUTCDate() - MAX_TREND_DAYS + 1)
  }

  const trendSales = await prisma.dailySale.findMany({
    where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: { gte: trendStart, lte: rangeEnd } },
    select: { saleDate: true, netAmount: true, branchId: true },
    orderBy: { saleDate: 'asc' },
  })

  // Group by date string per branch
  const trendMap: Record<string, Record<string, number>> = {}
  for (const s of trendSales) {
    const dateStr = s.saleDate.toISOString().slice(0, 10)
    if (!trendMap[dateStr]) trendMap[dateStr] = {}
    trendMap[dateStr][s.branchId] = (trendMap[dateStr][s.branchId] ?? 0) + s.netAmount
  }
  const salesTrend = Object.entries(trendMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, byBranch]) => ({ date, ...byBranch }))

  // ── Per-branch aggregates for the selected range ──────────────────────────
  const branchStats = await Promise.all(
    branches.map(async (branch) => {
      const bf = { branchId: branch.id }

      const [salesAgg, expAgg, billsAgg, prevSalesAgg, recipeAgg] = await Promise.all([
        prisma.dailySale.aggregate({
          where: { ...orgFilter, ...bf, ...notVoid, saleDate: dateFilter },
          _sum: {
            netAmount: true, subtotal: true, vatAmount: true,
            cashAmount: true, cardAmount: true, deliveryAmount: true,
            discountAmount: true, refundAmount: true,
          },
          _count: true,
        }),
        prisma.expense.aggregate({
          where: { source: { not: 'purchasing' }, ...orgFilter, ...bf, ...notVoid, expenseDate: dateFilter },
          _sum: { totalAmount: true },
          _count: true,
        }),
        // Supplier purchases (bills) count toward expenses too — food cost /
        // net profit shouldn't ignore what was actually spent on stock.
        prisma.bill.aggregate({
          where: { ...orgFilter, ...bf, status: { not: 'void' }, billDate: dateFilter },
          _sum: { totalAmount: true },
        }),
        // Previous equivalent period, for the growth comparison
        previousRange
          ? prisma.dailySale.aggregate({
              where: { ...orgFilter, ...bf, ...notVoid, saleDate: { gte: previousRange.start, lte: previousRange.end } },
              _sum: { netAmount: true },
            })
          : Promise.resolve({ _sum: { netAmount: 0 } }),
        // Recipe cost of paid POS / QR orders (automatic "orders" daily sales)
        prisma.dailySale.aggregate({
          where: { ...orgFilter, ...bf, ...notVoid, source: 'orders', costOfSales: { gt: 0 }, saleDate: dateFilter },
          _sum: { costOfSales: true, netAmount: true, vatAmount: true },
        }),
      ])

      const totalSales = salesAgg._sum.netAmount ?? 0
      const totalExpenses = (expAgg._sum.totalAmount ?? 0) + (billsAgg._sum.totalAmount ?? 0)
      const grossProfit = totalSales - totalExpenses
      const prevSales = prevSalesAgg._sum.netAmount ?? 0
      const salesGrowth = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : 0
      // Food cost %: from recipes when dishes have them (recipe cost ÷ net
      // food sales excl. tax); otherwise the purchases-based estimate
      const recipeCost = recipeAgg._sum.costOfSales ?? 0
      const recipeNetSales = (recipeAgg._sum.netAmount ?? 0) - (recipeAgg._sum.vatAmount ?? 0)
      const foodCostPct = recipeCost > 0 && recipeNetSales > 0
        ? (recipeCost / recipeNetSales) * 100
        : totalSales > 0 ? (totalExpenses / totalSales) * 100 : 0

      return {
        branchId: branch.id,
        branchName: branch.name,
        branchCode: branch.code,
        totalSales,
        totalExpenses,
        grossProfit,
        netProfit: grossProfit,
        prevPeriodSales: prevSales,
        salesGrowth: Math.round(salesGrowth * 10) / 10,
        foodCostPct: Math.round(foodCostPct * 10) / 10,
        foodCostSource: recipeCost > 0 ? 'recipes' : 'purchases',
        recipeFoodCost: regionalRoundMoney(recipeCost),
        avgPerDaySale: totalSales / daysInPeriod,
        saleCount: salesAgg._count,
        paymentBreakdown: {
          cash: salesAgg._sum.cashAmount ?? 0,
          card: salesAgg._sum.cardAmount ?? 0,
          delivery: salesAgg._sum.deliveryAmount ?? 0,
        },
        salesTarget: targetMap[branch.id] ?? 0,
      }
    })
  )

  // ── Expense breakdown by category (selected range, all/filtered branches) ─
  const expByCategory = await prisma.expense.groupBy({
    by: ['categoryId'],
    where: { source: { not: 'purchasing' }, ...orgFilter, ...branchFilter, ...notVoid, expenseDate: dateFilter },
    _sum: { totalAmount: true },
  })
  const catIds = expByCategory.map((e) => e.categoryId)
  const catDetails = await prisma.expenseCategory.findMany({
    where: { id: { in: catIds } },
    select: { id: true, name: true },
  })
  const catMap: Record<string, string> = {}
  for (const c of catDetails) catMap[c.id] = c.name
  const expenseBreakdown = expByCategory.map((e) => ({
    categoryId: e.categoryId,
    categoryName: catMap[e.categoryId] ?? e.categoryId,
    total: e._sum.totalAmount ?? 0,
  }))

  // ── Payment method breakdown (selected range, all/filtered branches) ─────
  const pmSales = await prisma.dailySale.aggregate({
    where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: dateFilter },
    _sum: {
      cashAmount: true, cardAmount: true,
      deliveryAmount: true, bankTransferAmount: true, otherAmount: true,
    },
  })
  const paymentBreakdown = {
    cash: pmSales._sum.cashAmount ?? 0,
    card: pmSales._sum.cardAmount ?? 0,
    delivery: pmSales._sum.deliveryAmount ?? 0,
    bankTransfer: pmSales._sum.bankTransferAmount ?? 0,
    other: pmSales._sum.otherAmount ?? 0,
  }

  // ── Pending approvals & overdue bills ─────────────────────────────────────
  const [pendingSales, pendingExp, pendingCC, overdueBills, lowStockItems, orgForThreshold, everStockedV2] = await Promise.all([
    prisma.dailySale.count({ where: { ...orgFilter, ...branchFilter, status: 'submitted' } }),
    prisma.expense.count({ where: { ...orgFilter, ...branchFilter, status: 'submitted' } }),
    prisma.cashClosing.count({ where: { ...orgFilter, ...branchFilter, status: 'submitted' } }),
    prisma.bill.count({
      where: { ...orgFilter, ...(branchId ? branchFilter : {}), status: { notIn: ['paid', 'void'] }, dueDate: { lt: now } },
    }),
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...(branchId ? { branchId } : {}) },
      select: { quantityOnHand: true, reorderPoint: true, itemId: true, branchId: true },
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
    getEverStockedKeys(prisma, orgId),
  ])

  const globalThreshold = orgForThreshold?.lowStockThreshold ?? null
  const lowStockCount = lowStockItems.filter((s) =>
    !isNeverStocked(everStockedV2, s.branchId, s.itemId, s.quantityOnHand) && s.quantityOnHand < (globalThreshold ?? s.reorderPoint)
  ).length

  // ── Recent activity ───────────────────────────────────────────────────────
  const auditLogs = await prisma.auditLog.findMany({
    where: { ...orgFilter, ...(branchId ? { branchId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { id: true, action: true, module: true, createdAt: true, userEmail: true, userName: true, resourceType: true, resourceRef: true, branchId: true },
  })

  // ── Totals for the selected range ─────────────────────────────────────────
  // "Expenses" here includes supplier purchases (bills) alongside manually
  // recorded Expense entries — purchases are real spend and belong in the
  // same figure, not a number this dashboard silently ignores.
  const [periodSalesAgg, periodExpensesAgg, periodBillsAgg, previousPeriodSalesAgg] = await Promise.all([
    prisma.dailySale.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: dateFilter },
      _sum: { netAmount: true },
    }),
    prisma.expense.aggregate({
      where: { source: { not: 'purchasing' }, ...orgFilter, ...branchFilter, ...notVoid, expenseDate: dateFilter },
      _sum: { totalAmount: true },
    }),
    prisma.bill.aggregate({
      where: { ...orgFilter, ...branchFilter, status: { not: 'void' }, billDate: dateFilter },
      _sum: { totalAmount: true },
    }),
    previousRange
      ? prisma.dailySale.aggregate({
          where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: { gte: previousRange.start, lte: previousRange.end } },
          _sum: { netAmount: true },
        })
      : Promise.resolve({ _sum: { netAmount: 0 } }),
  ])

  // ── Average sales per day — a straightforward, always-meaningful metric
  // (unlike "orders", which this system has no real concept of) ───────────
  const avgPerDaySale = (periodSalesAgg._sum.netAmount ?? 0) / daysInPeriod

  // ── Week/Month period-over-period comparison (only computed when requested) ─
  let comparison: {
    mode: 'week' | 'month'
    currentLabel: string
    previousLabel: string
    byBranch: { branchId: string; branchName: string; current: number; previous: number; changePct: number }[]
    trend: { dayOffset: number; current: number; previous: number }[]
  } | null = null

  if (compare === 'week' || compare === 'month') {
    let currentStart: Date, currentEnd: Date, previousStart: Date, previousEnd: Date, currentLabel: string, previousLabel: string

    if (compare === 'week') {
      currentStart = new Date(today)
      currentStart.setUTCDate(today.getUTCDate() - 6)
      currentEnd = endOfToday
      previousStart = new Date(today)
      previousStart.setUTCDate(today.getUTCDate() - 13)
      previousEnd = new Date(today)
      previousEnd.setUTCDate(today.getUTCDate() - 7)
      previousEnd.setUTCHours(23, 59, 59, 999)
      currentLabel = 'This Week'
      previousLabel = 'Last Week'
    } else {
      currentStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
      currentEnd = endOfToday
      const daysElapsed = today.getUTCDate() // 1-based day of month, e.g. 15
      previousStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1))
      previousEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, daysElapsed, 23, 59, 59, 999))
      currentLabel = 'This Month (to date)'
      previousLabel = 'Last Month (same days)'
    }

    const periodLen = compare === 'week'
      ? 7
      : Math.floor((currentEnd.getTime() - currentStart.getTime()) / (1000 * 60 * 60 * 24)) + 1

    const sumSalesFor = (start: Date, end: Date, extraFilter: Record<string, unknown> = {}) =>
      prisma.dailySale.aggregate({
        where: { ...orgFilter, ...notVoid, ...extraFilter, saleDate: { gte: start, lte: end } },
        _sum: { netAmount: true },
      })

    const byBranch = await Promise.all(
      branches.map(async (branch) => {
        const [curr, prev] = await Promise.all([
          sumSalesFor(currentStart, currentEnd, { branchId: branch.id }),
          sumSalesFor(previousStart, previousEnd, { branchId: branch.id }),
        ])
        const current = curr._sum.netAmount ?? 0
        const previous = prev._sum.netAmount ?? 0
        const changePct = previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : 0
        return { branchId: branch.id, branchName: branch.name, current, previous, changePct }
      })
    )

    const trend = await Promise.all(
      Array.from({ length: periodLen }, (_, i) => i).map(async (i) => {
        const cDay = new Date(currentStart)
        cDay.setUTCDate(currentStart.getUTCDate() + i)
        const cDayEnd = new Date(cDay)
        cDayEnd.setUTCHours(23, 59, 59, 999)

        const pDay = new Date(previousStart)
        pDay.setUTCDate(previousStart.getUTCDate() + i)
        const pDayEnd = new Date(pDay)
        pDayEnd.setUTCHours(23, 59, 59, 999)

        const [curr, prev] = await Promise.all([
          sumSalesFor(cDay, cDayEnd, branchFilter),
          sumSalesFor(pDay, pDayEnd, branchFilter),
        ])
        return { dayOffset: i + 1, current: curr._sum.netAmount ?? 0, previous: prev._sum.netAmount ?? 0 }
      })
    )

    comparison = { mode: compare, currentLabel, previousLabel, byBranch, trend }
  }

  const periodSales = periodSalesAgg._sum.netAmount ?? 0
  const periodExpenses = (periodExpensesAgg._sum.totalAmount ?? 0) + (periodBillsAgg._sum.totalAmount ?? 0)
  const previousPeriodSales = previousPeriodSalesAgg._sum.netAmount ?? 0
  const periodSalesChangePct = previousPeriodSales > 0
    ? Math.round(((periodSales - previousPeriodSales) / previousPeriodSales) * 1000) / 10
    : 0

  res.json({
    period: { start: rangeStart ? rangeStart.toISOString() : null, end: rangeEnd.toISOString(), range: selectedRange, label: rangeLabel },
    kpis: {
      periodSales,
      periodExpenses,
      periodProfit: periodSales - periodExpenses,
      periodSalesChangePct,
      avgPerDaySale,
      pendingApprovals: pendingSales + pendingExp + pendingCC,
      overdueSupplierBills: overdueBills,
      lowStockItems: lowStockCount,
    },
    branchStats,
    salesTrend,
    expenseBreakdown,
    paymentBreakdown,
    comparison,
    recentActivity: auditLogs.map((log) => ({
      id: log.id,
      description: `${log.action} ${log.resourceType ?? ''} ${log.resourceRef ?? ''}`.trim(),
      module: log.module,
      createdAt: log.createdAt.toISOString(),
      userEmail: log.userEmail,
      userName: log.userName,
      branchId: log.branchId,
    })),
  })
})

// GET /reports/inventory-health — real stock value, low/critical stock, movement velocity, wastage
router.get('/inventory-health', async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const now = new Date()
  const businessToday = todayInZone()
  const startOfMonth = new Date(Date.UTC(businessToday.getUTCFullYear(), businessToday.getUTCMonth(), 1))
  const last30Days = new Date(now)
  last30Days.setUTCDate(now.getUTCDate() - 30)

  const branchFilter = branchId ? { branchId } : {}

  const [stocks, orgForThreshold, everStockedHealth] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...branchFilter },
      include: {
        item: { select: { id: true, name: true, code: true, unit: true } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
    getEverStockedKeys(prisma, orgId),
  ])
  const globalThreshold = orgForThreshold?.lowStockThreshold ?? null
  const thresholdFor = (st: { reorderPoint: number }) => globalThreshold ?? st.reorderPoint
  // Catalog items still at zero since creation (never actually received via
  // a purchase) are excluded from low/critical counts — never stocked isn't
  // the same as critically low.
  const everStocked = (st: { branchId: string; itemId: string; quantityOnHand: number }) =>
    !isNeverStocked(everStockedHealth, st.branchId, st.itemId, st.quantityOnHand)

  const totalStockValue = stocks.reduce((s, st) => s + st.totalValue, 0)

  const lowStockStocks = stocks.filter((st) => everStocked(st) && st.quantityOnHand < thresholdFor(st) && st.quantityOnHand > thresholdFor(st) * 0.5)
  const criticalStockStocks = stocks.filter((st) => everStocked(st) && st.quantityOnHand <= thresholdFor(st) * 0.5)
  const purchaseRequired = lowStockStocks.length + criticalStockStocks.length

  // Movement velocity: count stock_out movements per item in the last 30 days
  const movements = await prisma.stockMovement.findMany({
    where: {
      organizationId: orgId, ...branchFilter,
      movementType: 'stock_out',
      createdAt: { gte: last30Days },
    },
    select: { itemId: true },
  })
  const movementCounts: Record<string, number> = {}
  for (const m of movements) movementCounts[m.itemId] = (movementCounts[m.itemId] ?? 0) + 1

  const distinctItemIds = new Set(stocks.map((st) => st.itemId))
  let fastMovingItems = 0
  let slowMovingItems = 0
  for (const itemId of distinctItemIds) {
    const count = movementCounts[itemId] ?? 0
    if (count >= 4) fastMovingItems++
    else if (count >= 1) slowMovingItems++
  }

  const wastageAgg = await prisma.wastageReport.aggregate({
    where: { organizationId: orgId, ...branchFilter, reportDate: { gte: startOfMonth } },
    _sum: { totalValue: true },
  })

  const lowStockList = [...criticalStockStocks, ...lowStockStocks]
    .sort((a, b) => (a.quantityOnHand / (thresholdFor(a) || 1)) - (b.quantityOnHand / (thresholdFor(b) || 1)))
    .slice(0, 10)
    .map((st) => ({
      item: st.item.name,
      branch: st.branch.name,
      current: st.quantityOnHand,
      minimum: thresholdFor(st),
      unit: st.item.unit,
      status: st.quantityOnHand <= thresholdFor(st) * 0.5 ? 'critical' : 'low',
      recommended: Math.max(0, Math.round(thresholdFor(st) * 2 - st.quantityOnHand)),
    }))

  res.json({
    totalStockValue,
    lowStockItems: lowStockStocks.length,
    criticalStockItems: criticalStockStocks.length,
    purchaseRequired,
    fastMovingItems,
    slowMovingItems,
    itemsMonitored: distinctItemIds.size,
    wastageValue: wastageAgg._sum.totalValue ?? 0,
    lowStockList,
  })
})

// GET /reports/sales
router.get('/sales', async (req: Request, res: Response) => {
  const { branchId, fromDate, toDate } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const where: Record<string, unknown> = {
    organizationId: orgId,
    status: { not: 'void' },
  }
  if (branchId) where.branchId = branchId
  if (fromDate || toDate) {
    where.saleDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [salesAgg, byBranch, dailyTrend] = await Promise.all([
    prisma.dailySale.aggregate({
      where,
      _sum: {
        cashAmount: true,
        cardAmount: true,
        deliveryAmount: true,
        bankTransferAmount: true,
        subtotal: true,
        discountAmount: true,
        vatAmount: true,
        totalAmount: true,
        refundAmount: true,
        netAmount: true,
      },
      _count: true,
    }),
    prisma.dailySale.groupBy({
      by: ['branchId'],
      where,
      _sum: { netAmount: true, totalAmount: true },
      _count: true,
    }),
    prisma.dailySale.findMany({
      where,
      orderBy: { saleDate: 'asc' },
      select: { saleDate: true, netAmount: true, branchId: true },
    }),
  ])

  // Enrich branch groupBy with names
  type GroupByBranch = (typeof byBranch)[number]
  type BranchRow = { id: string; name: string }

  const branchIds = byBranch.map((b: GroupByBranch) => b.branchId)
  const branchDetails = await prisma.branch.findMany({
    where: { id: { in: branchIds } },
    select: { id: true, name: true },
  })
  const branchMap = Object.fromEntries(
    branchDetails.map((b: BranchRow) => [b.id, b.name])
  )

  const byBranchEnriched = byBranch.map((b: GroupByBranch) => ({
    branchId: b.branchId,
    branchName: (branchMap[b.branchId] as string) || b.branchId,
    netAmount: b._sum.netAmount ?? 0,
    totalAmount: b._sum.totalAmount ?? 0,
    count: b._count,
  }))

  res.json({
    summary: {
      totalSales: salesAgg._sum.netAmount ?? 0,
      saleCount: salesAgg._count,
      totalVat: salesAgg._sum.vatAmount ?? 0,
      totalDiscount: salesAgg._sum.discountAmount ?? 0,
      totalRefunds: salesAgg._sum.refundAmount ?? 0,
    },
    paymentBreakdown: {
      cash: salesAgg._sum.cashAmount ?? 0,
      card: salesAgg._sum.cardAmount ?? 0,
      delivery: salesAgg._sum.deliveryAmount ?? 0,
      bankTransfer: salesAgg._sum.bankTransferAmount ?? 0,
    },
    byBranch: byBranchEnriched,
    dailyTrend,
  })
})

// GET /reports/general-ledger — every posted line per account with its
// opening balance, running balance and closing balance, in the same report
// format (screen / PDF / Excel / CSV) as the rest of the catalogue.
router.get('/general-ledger', requirePermission('can_view_financial_reports'), async (req: Request, res: Response) => {
  const { branchId, accountId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId
  const day = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00.000Z`) : undefined)
  const from = day(fromDate)
  const to = day(toDate)

  const [accounts, opening] = await Promise.all([
    prisma.account.findMany({ where: { organizationId: orgId, ...(accountId ? { id: accountId } : {}) }, orderBy: { code: 'asc' } }),
    from ? netByAccount(orgId, { to: new Date(from.getTime() - 86_400_000) }, branchId || undefined) : Promise.resolve(new Map<string, { debit: number; credit: number }>()),
  ])
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { organizationId: orgId, status: 'posted', ...(branchId && { branchId }), ...((from || to) && { entryDate: { ...(from && { gte: from }), ...(to && { lt: new Date(to.getTime() + 86_400_000) }) } }) },
    },
    include: { journalEntry: { select: { entryNo: true, entryDate: true, description: true, branch: { select: { name: true } } } } },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
  })
  const byAccount = new Map<string, typeof lines>()
  for (const l of lines) {
    if (!byAccount.has(l.accountId)) byAccount.set(l.accountId, [])
    byAccount.get(l.accountId)!.push(l)
  }

  const showBranch = !branchId && !res.locals.singleBranch
  const rows: ReportRow[] = []
  let grandDebit = 0, grandCredit = 0, shown = 0
  const legacyAccounts: Record<string, unknown>[] = []
  for (const acc of accounts) {
    const accLines = byAccount.get(acc.id) ?? []
    const o = opening.get(acc.id)
    const sign = acc.normalBalance === 'DEBIT' ? 1 : -1
    const openingBalance = round2(o ? sign * (o.debit - o.credit) : 0)
    if (!accountId && accLines.length === 0 && Math.abs(openingBalance) < 0.005) continue
    shown++
    rows.push({ description: `${acc.code} — ${acc.name}`, _style: 'heading' })
    rows.push({ description: 'Opening balance', balance: openingBalance, _style: 'indent' })
    let running = openingBalance, accDebit = 0, accCredit = 0
    const legacyLines = []
    for (const l of accLines) {
      const debit = Number(l.debitAmount), credit = Number(l.creditAmount)
      running = round2(running + sign * (debit - credit))
      accDebit += debit; accCredit += credit
      rows.push({ date: l.journalEntry.entryDate, entryNo: l.journalEntry.entryNo, description: l.description || l.journalEntry.description, branch: l.journalEntry.branch?.name ?? '', debit, credit, balance: running })
      legacyLines.push({ date: l.journalEntry.entryDate, entryNo: l.journalEntry.entryNo, description: l.description || l.journalEntry.description, branch: l.journalEntry.branch?.name ?? null, debit, credit, balance: running })
    }
    grandDebit += accDebit; grandCredit += accCredit
    rows.push({ description: `Closing balance — ${acc.code} (period Dr ${formatMoney(accDebit)} · Cr ${formatMoney(accCredit)})`, balance: running, _style: 'subtotal' })
    legacyAccounts.push({ accountId: acc.id, code: acc.code, name: acc.name, accountType: acc.accountClass, openingBalance, lines: legacyLines, closingBalance: running })
  }

  const scope = await reportScope(prisma, orgId, branchId || undefined)
  const period = periodLabelFor(fromDate, toDate)
  const report: ProReport = {
    key: 'general-ledger', eyebrow: 'General Ledger', headline: 'General ledger', ...scope, periodLabel: period, generatedAt: new Date().toISOString(),
    summaryLine: `Period: ${period}  |  ${plural(shown, 'account')}  |  ${plural(lines.length, 'posting')}`,
    kpis: [
      { label: 'Accounts', value: shown, format: 'integer', hint: accountId ? 'Selected account' : 'With activity or a balance' },
      { label: 'Postings', value: lines.length, format: 'integer', hint: 'Posted journal lines' },
      { label: 'Total debits', value: round2(grandDebit), hint: 'In the period' },
      { label: 'Total credits', value: round2(grandCredit), hint: Math.abs(grandDebit - grandCredit) < regionalMoneyTolerance() || accountId ? 'In the period' : 'Does not equal debits — check filters', tone: 'dark' },
    ],
    sections: [{
      type: 'table', id: 'ledger', title: 'Ledger', subtitle: 'Each account opens with its balance at the start of the period; balances are on the account’s normal side', register: true, primary: true,
      columns: [
        { key: 'date', label: 'Date', format: 'date', width: 0.9 }, { key: 'entryNo', label: 'Entry no.', format: 'code', width: 1 },
        { key: 'description', label: 'Description', width: 3 },
        ...(showBranch ? [{ key: 'branch', label: 'Branch', width: 1.1 } as ReportColumn] : []),
        { key: 'debit', label: 'Debit', format: 'money' }, { key: 'credit', label: 'Credit', format: 'money' },
        { key: 'balance', label: 'Balance', format: 'money', sum: false },
      ],
      rows,
      totals: { date: 'TOTAL', debit: round2(grandDebit), credit: round2(grandCredit) },
      emptyMessage: 'No postings for the selected filters',
    }],
  }
  await sendProReport(res, format, report, { generatedAt: report.generatedAt, branchName: branchId ? scope.scopeLabel : null, fromDate: fromDate || null, toDate: toDate || null, accounts: legacyAccounts, totals: { debit: grandDebit, credit: grandCredit } })
})

export default router
