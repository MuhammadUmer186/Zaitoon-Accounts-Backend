import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { sendGeneralLedgerCsv, sendGeneralLedgerExcel, sendGeneralLedgerPdf, GLReportData, GLReportAccount, GLReportLine } from '../utils/glReport'

const router = Router()

router.use(authenticate)

// GET /reports/dashboard
router.get('/dashboard', async (req: Request, res: Response) => {
  const { branchId } = req.query as { branchId?: string }
  const orgId = req.user.organizationId

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfToday = new Date(today)
  endOfToday.setHours(23, 59, 59, 999)

  const startOfWeek = new Date(today)
  startOfWeek.setDate(today.getDate() - today.getDay())

  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)

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
      where: { ...orgFilter, ...branchFilter, ...notVoid, expenseDate: { gte: today, lte: endOfToday } },
      _sum: { totalAmount: true },
    }),
    prisma.expense.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid, expenseDate: { gte: startOfMonth } },
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
  const [allStocks, orgForThreshold] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...(branchId ? { branchId } : {}) },
      select: { quantityOnHand: true, reorderPoint: true },
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
  ])
  const globalThreshold = orgForThreshold?.lowStockThreshold ?? null
  type StockRow = { quantityOnHand: number; reorderPoint: number }
  const lowStockCount = (allStocks as StockRow[]).filter(
    (s: StockRow) => s.quantityOnHand < (globalThreshold ?? s.reorderPoint)
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
router.get('/financial', async (req: Request, res: Response) => {
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
      where: {
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

  const grossProfit = (totalSales._sum.netAmount ?? 0) - (totalExpenses._sum.totalAmount ?? 0)

  res.json({
    revenue: {
      totalSales: totalSales._sum.netAmount ?? 0,
      totalVatCollected: totalSales._sum.vatAmount ?? 0,
      saleCount: totalSales._count,
    },
    expenses: {
      totalExpenses: totalExpenses._sum.totalAmount ?? 0,
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
    netProfit: grossProfit - (totalBills._sum.totalAmount ?? 0),
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
      start.setDate(today.getDate() - 1)
      const end = new Date(start)
      end.setHours(23, 59, 59, 999)
      return { start, end, label: 'Yesterday' }
    }
    case 'this_week': {
      const start = new Date(today)
      start.setDate(today.getDate() - today.getDay())
      return { start, end: endOfToday, label: 'This Week' }
    }
    case 'this_year': {
      const start = new Date(today.getFullYear(), 0, 1)
      return { start, end: endOfToday, label: 'This Year' }
    }
    case 'overall':
      return { start: null, end: endOfToday, label: 'Overall' }
    case 'this_month':
    default: {
      const start = new Date(today.getFullYear(), today.getMonth(), 1)
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
      start.setDate(today.getDate() - 1)
      const end = new Date(start)
      end.setHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'yesterday': {
      const start = new Date(today)
      start.setDate(today.getDate() - 2)
      const end = new Date(start)
      end.setHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'this_week': {
      const currentStart = new Date(today)
      currentStart.setDate(today.getDate() - today.getDay())
      const start = new Date(currentStart)
      start.setDate(currentStart.getDate() - 7)
      const end = new Date(currentStart)
      end.setDate(currentStart.getDate() - 1)
      end.setHours(23, 59, 59, 999)
      return { start, end }
    }
    case 'this_year': {
      const start = new Date(today.getFullYear() - 1, 0, 1)
      const end = new Date(today.getFullYear() - 1, 11, 31, 23, 59, 59, 999)
      return { start, end }
    }
    case 'overall':
      return null
    case 'this_month':
    default: {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      const end = new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59, 999)
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
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const endOfToday = new Date(today)
  endOfToday.setHours(23, 59, 59, 999)

  const { start: rangeStart, end: rangeEnd, label: rangeLabel } = getRangeBounds(selectedRange, today, endOfToday)
  const dateFilter = { ...(rangeStart && { gte: rangeStart }), lte: rangeEnd }
  const previousRange = getPreviousRangeBounds(selectedRange, today)

  const notVoid = { status: { not: 'void' } }
  const orgFilter = { organizationId: orgId }
  const branchFilter = branchId ? { branchId } : {}

  const branches = await prisma.branch.findMany({
    where: { ...orgFilter, isActive: true, ...(branchId ? { id: branchId } : {}) },
    select: { id: true, name: true, code: true },
    orderBy: { name: 'asc' },
  })

  const branchTargets = await prisma.branchTarget.findMany({
    where: { ...orgFilter, year: today.getFullYear(), month: today.getMonth() + 1, ...(branchId ? { branchId } : {}) },
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
      trendStart.setDate(rangeEnd.getDate() - MAX_TREND_DAYS + 1)
    } else {
      trendStart = rangeStart
    }
  } else {
    // 'overall' has no lower bound for totals, but the trend chart shows a
    // recent trailing window rather than querying literally all-time rows.
    trendStart = new Date(rangeEnd)
    trendStart.setDate(rangeEnd.getDate() - MAX_TREND_DAYS + 1)
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

      const [salesAgg, expAgg, prevSalesAgg] = await Promise.all([
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
          where: { ...orgFilter, ...bf, ...notVoid, expenseDate: dateFilter },
          _sum: { totalAmount: true },
          _count: true,
        }),
        // Previous equivalent period, for the growth comparison
        previousRange
          ? prisma.dailySale.aggregate({
              where: { ...orgFilter, ...bf, ...notVoid, saleDate: { gte: previousRange.start, lte: previousRange.end } },
              _sum: { netAmount: true },
            })
          : Promise.resolve({ _sum: { netAmount: 0 } }),
      ])

      const totalSales = salesAgg._sum.netAmount ?? 0
      const totalExpenses = expAgg._sum.totalAmount ?? 0
      const grossProfit = totalSales - totalExpenses
      const prevSales = prevSalesAgg._sum.netAmount ?? 0
      const salesGrowth = prevSales > 0 ? ((totalSales - prevSales) / prevSales) * 100 : 0
      const foodCostPct = totalSales > 0 ? (totalExpenses / totalSales) * 100 : 0

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
    where: { ...orgFilter, ...branchFilter, ...notVoid, expenseDate: dateFilter },
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
  const [pendingSales, pendingExp, pendingCC, overdueBills, lowStockItems, orgForThreshold] = await Promise.all([
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
  ])

  const globalThreshold = orgForThreshold?.lowStockThreshold ?? null
  const lowStockCount = lowStockItems.filter((s) => s.quantityOnHand < (globalThreshold ?? s.reorderPoint)).length

  // ── Recent activity ───────────────────────────────────────────────────────
  const auditLogs = await prisma.auditLog.findMany({
    where: { ...orgFilter, ...(branchId ? { branchId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 15,
    select: { id: true, action: true, module: true, createdAt: true, userEmail: true, userName: true, resourceType: true, resourceRef: true, branchId: true },
  })

  // ── Totals for the selected range ─────────────────────────────────────────
  const [periodSalesAgg, periodExpensesAgg, previousPeriodSalesAgg] = await Promise.all([
    prisma.dailySale.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: dateFilter },
      _sum: { netAmount: true },
    }),
    prisma.expense.aggregate({
      where: { ...orgFilter, ...branchFilter, ...notVoid, expenseDate: dateFilter },
      _sum: { totalAmount: true },
    }),
    previousRange
      ? prisma.dailySale.aggregate({
          where: { ...orgFilter, ...branchFilter, ...notVoid, saleDate: { gte: previousRange.start, lte: previousRange.end } },
          _sum: { netAmount: true },
        })
      : Promise.resolve({ _sum: { netAmount: 0 } }),
  ])

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
      currentStart.setDate(today.getDate() - 6)
      currentEnd = endOfToday
      previousStart = new Date(today)
      previousStart.setDate(today.getDate() - 13)
      previousEnd = new Date(today)
      previousEnd.setDate(today.getDate() - 7)
      previousEnd.setHours(23, 59, 59, 999)
      currentLabel = 'This Week'
      previousLabel = 'Last Week'
    } else {
      currentStart = new Date(today.getFullYear(), today.getMonth(), 1)
      currentEnd = endOfToday
      const daysElapsed = today.getDate() // 1-based day of month, e.g. 15
      previousStart = new Date(today.getFullYear(), today.getMonth() - 1, 1)
      previousEnd = new Date(today.getFullYear(), today.getMonth() - 1, daysElapsed, 23, 59, 59, 999)
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
        cDay.setDate(currentStart.getDate() + i)
        const cDayEnd = new Date(cDay)
        cDayEnd.setHours(23, 59, 59, 999)

        const pDay = new Date(previousStart)
        pDay.setDate(previousStart.getDate() + i)
        const pDayEnd = new Date(pDay)
        pDayEnd.setHours(23, 59, 59, 999)

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
  const periodExpenses = periodExpensesAgg._sum.totalAmount ?? 0
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
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const last30Days = new Date(now)
  last30Days.setDate(now.getDate() - 30)

  const branchFilter = branchId ? { branchId } : {}

  const [stocks, orgForThreshold] = await Promise.all([
    prisma.branchStock.findMany({
      where: { organizationId: orgId, ...branchFilter },
      include: {
        item: { select: { id: true, name: true, code: true, unit: true } },
        branch: { select: { id: true, name: true } },
      },
    }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { lowStockThreshold: true } }),
  ])
  const globalThreshold = orgForThreshold?.lowStockThreshold ?? null
  const thresholdFor = (st: { reorderPoint: number }) => globalThreshold ?? st.reorderPoint

  const totalStockValue = stocks.reduce((s, st) => s + st.totalValue, 0)

  const lowStockStocks = stocks.filter((st) => st.quantityOnHand < thresholdFor(st) && st.quantityOnHand > thresholdFor(st) * 0.5)
  const criticalStockStocks = stocks.filter((st) => st.quantityOnHand <= thresholdFor(st) * 0.5)
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

// GET /reports/general-ledger — the full posted ledger (Assets, Liabilities,
// Revenue, Expenses — Equity is excluded from GL reporting), viewable on
// screen (format omitted/json) or exported as csv / excel / pdf for
// printing and record-keeping.
router.get('/general-ledger', async (req: Request, res: Response) => {
  const { branchId, accountId, fromDate, toDate, format } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  if (fromDate || toDate) {
    entryWhere.entryDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [accounts, branch] = await Promise.all([
    prisma.account.findMany({
      where: {
        organizationId: orgId,
        isActive: true,
        accountType: { not: 'equity' },
        ...(accountId ? { id: accountId } : {}),
      },
      orderBy: [{ accountType: 'asc' }, { code: 'asc' }],
    }),
    branchId ? prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : Promise.resolve(null),
  ])

  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: entryWhere },
    include: {
      journalEntry: {
        select: { entryNo: true, entryDate: true, description: true, branch: { select: { name: true } } },
      },
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
  })

  const byAccount = new Map<string, typeof lines>()
  for (const l of lines) {
    if (!byAccount.has(l.accountId)) byAccount.set(l.accountId, [])
    byAccount.get(l.accountId)!.push(l)
  }

  let grandDebit = 0
  let grandCredit = 0

  const accountSections: GLReportAccount[] = accounts
    .map((acc) => {
      const accLines = byAccount.get(acc.id) ?? []
      let running = 0
      const rows: GLReportLine[] = accLines.map((l) => {
        running += acc.normalBalance === 'debit' ? l.debitAmount - l.creditAmount : l.creditAmount - l.debitAmount
        grandDebit += l.debitAmount
        grandCredit += l.creditAmount
        return {
          date: l.journalEntry.entryDate,
          entryNo: l.journalEntry.entryNo,
          description: l.description || l.journalEntry.description,
          branch: l.journalEntry.branch?.name ?? null,
          debit: l.debitAmount,
          credit: l.creditAmount,
          balance: running,
        }
      })
      return {
        accountId: acc.id,
        code: acc.code,
        name: acc.name,
        accountType: acc.accountType,
        lines: rows,
        closingBalance: running,
      }
    })
    .filter((s) => !!accountId || s.lines.length > 0)

  const report: GLReportData = {
    generatedAt: new Date().toISOString(),
    branchName: branch?.name ?? null,
    fromDate: fromDate || null,
    toDate: toDate || null,
    accounts: accountSections,
    totals: { debit: grandDebit, credit: grandCredit },
  }

  if (format === 'csv') { sendGeneralLedgerCsv(res, report); return }
  if (format === 'excel') { await sendGeneralLedgerExcel(res, report); return }
  if (format === 'pdf') { sendGeneralLedgerPdf(res, report); return }
  res.json(report)
})

export default router
