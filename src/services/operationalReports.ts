import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { currentFormat, momentRange, todayInZone, zonedParts } from '../utils/reportFormat'
import { CellFormat, ReportColumn, ReportKpi, ReportRow, ReportSection, TableSection, pct, round2 } from '../utils/proReport'

export const operationalReportNames = {
  'menu-performance': 'Menu Performance',
  'hourly-sales': 'Hourly Sales and Peak Times',
  'discounts-voids-refunds': 'Discounts, Voids and Refunds',
  'ingredient-variance': 'Ingredient Usage Variance',
  'kitchen-performance': 'Kitchen Performance',
  'delivery-profitability': 'Delivery Profitability',
  'supplier-price-changes': 'Supplier Price Changes',
  'customer-retention': 'Customer Retention',
  'table-performance': 'Table and Service Performance',
  'branch-targets': 'Branch Target Achievement',
  'stock-replenishment': 'Stock Replenishment',
  'payment-reconciliation': 'Payment Reconciliation',
} as const
export type OperationalReportKey = keyof typeof operationalReportNames
export interface ReportFilters { organizationId: string; branchId?: string; fromDate?: string; toDate?: string }
interface Result { kpis: ReportKpi[]; sections: ReportSection[] }
const col = (key: string, label: string, format: CellFormat = 'text'): ReportColumn => ({ key, label, format })
const table = (id: string, title: string, columns: ReportColumn[], rows: ReportRow[], subtitle?: string): TableSection => ({ type: 'table', id, title, columns, rows, subtitle, register: true, primary: id === 'summary' })
const note = (text: string): ReportSection => ({ type: 'note', id: 'method', title: 'Basis and data coverage', text })
const kpi = (label: string, value: number | string, format: CellFormat = 'money'): ReportKpi => ({ label, value: typeof value === 'number' ? round2(value) : value, format })
const sum = <T>(rows: T[], pick: (r: T) => number) => rows.reduce((s, r) => s + pick(r), 0)
const n = (r: ReportRow, key: string) => Number(r[key] ?? 0)
const qty = (value: number) => Math.round(value * 10000) / 10000
const calendar = (f: ReportFilters) => ({ ...(f.fromDate && { gte: new Date(f.fromDate) }), ...(f.toDate && { lt: new Date(Date.parse(f.toDate) + 86400000) }) })
const scope = (f: ReportFilters) => ({ organizationId: f.organizationId, ...(f.branchId && { branchId: f.branchId }) })
const orderInclude = { branch: { select: { name: true } }, table: { select: { name: true } }, items: { include: { dish: { select: { prepMinutes: true } }, station: { select: { name: true } } } } } satisfies Prisma.CustomerOrderInclude
type Order = Prisma.CustomerOrderGetPayload<{ include: typeof orderInclude }>
const netSales = (o: Order) => o.totalAmount - o.vatAmount
const orderRows = (orders: Order[]) => orders.map(o => ({ _sourceOrderId: o.id, id: o.id, order: `#${o.orderNo}`, branch: o.branch.name, date: o.closedAt?.toISOString(), status: o.status, sales: round2(netSales(o)), cost: o.foodCost, source: o.source }))
const orderColumns = [col('order', 'Order'), col('branch', 'Branch'), col('date', 'Paid at', 'datetime'), col('status', 'Status', 'status'), col('sales', 'Net sales', 'money'), col('cost', 'Food cost', 'money'), col('source', 'Source')]
const register = (orders: Order[]) => table('orders', 'Source orders', orderColumns, orderRows(orders), 'Search by order number or branch to inspect the source transactions.')
async function paidOrders(f: ReportFilters, db: Prisma.TransactionClient) {
  return db.customerOrder.findMany({ where: { ...scope(f), status: 'completed', closedAt: momentRange(f.fromDate, f.toDate) }, include: orderInclude, orderBy: [{ closedAt: 'asc' }, { id: 'asc' }] })
}

export async function buildOperationalReport(key: OperationalReportKey, f: ReportFilters, db: Prisma.TransactionClient = prisma): Promise<Result> {
  if (key === 'menu-performance') {
    const orders = await paidOrders(f, db)
    const groups = new Map<string, ReportRow>()
    let missing = 0
    for (const o of orders) {
      const lines = o.items.filter(i => i.status !== 'cancelled')
      const gross = sum(lines, i => i.lineTotal)
      const foodNet = netSales(o) - (o.deliveryFee - o.deliveryFeeVatAmount)
      for (const i of lines) {
        const r = groups.get(i.dishId) ?? { dish: i.dishName, quantity: 0, sales: 0, cost: 0, uncosted: 0 }
        r.quantity = n(r, 'quantity') + i.quantity
        r.sales = n(r, 'sales') + (gross > 0 ? foodNet * i.lineTotal / gross : 0)
        r.cost = n(r, 'cost') + i.unitCost * i.quantity
        if (i.recipeUsage === null || (Array.isArray(i.recipeUsage) && !i.recipeUsage.length)) { missing++; r.uncosted = n(r, 'uncosted') + i.quantity }
        groups.set(i.dishId, r)
      }
    }
    const rows = [...groups.values()].map(r => ({ ...r, sales: round2(n(r, 'sales')), cost: round2(n(r, 'cost')), contribution: round2(n(r, 'sales') - n(r, 'cost')), margin: pct(n(r, 'sales') - n(r, 'cost'), n(r, 'sales')) })).sort((a, b) => b.sales - a.sales)
    const sales = sum(rows, r => r.sales), cost = sum(rows, r => r.cost)
    return { kpis: [kpi('Net food sales', sales), kpi('Recorded food cost', cost), kpi('Contribution', sales - cost), kpi('Lines without recipe snapshots', missing, 'integer')], sections: [table('summary', 'Dish performance', [col('dish', 'Dish'), col('quantity', 'Sold', 'integer'), col('sales', 'Net sales', 'money'), col('cost', 'Food cost', 'money'), col('contribution', 'Contribution', 'money'), col('margin', 'Margin', 'percent'), col('uncosted', 'Unverified portions', 'integer')], rows), register(orders), note('Completed orders only. Food revenue excludes delivery fees and tax; order discounts are allocated by line value. Cost is the portion cost stored at payment. Contribution excludes labor and overhead. Unverified portions have missing or empty recipe snapshots; a zero cost does not establish profitability.')] }
  }

  if (key === 'hourly-sales') {
    const orders = await paidOrders(f, db)
    const rows: ReportRow[] = Array.from({ length: 7 * 24 }, (_, index) => ({ weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][Math.floor(index / 24)], hour: `${String(index % 24).padStart(2, '0')}:00`, orders: 0, sales: 0, average: 0 }))
    for (const o of orders) {
      const p = zonedParts(o.closedAt!, currentFormat().timezone)
      const day = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()
      const r = rows[day * 24 + p.hh]; r.orders = n(r, 'orders') + 1; r.sales = n(r, 'sales') + netSales(o)
    }
    for (const r of rows) { r.average = n(r, 'orders') ? round2(n(r, 'sales') / n(r, 'orders')) : null; r.sales = round2(n(r, 'sales')) }
    const sales = sum(orders, netSales)
    const busiest = [...rows].sort((a, b) => n(b, 'orders') - n(a, 'orders'))[0]
    return { kpis: [kpi('Orders', orders.length, 'integer'), kpi('Net sales', sales), kpi('Average order value', orders.length ? sales / orders.length : 0), kpi('Busiest slot', orders.length ? `${busiest.weekday} ${busiest.hour}` : 'No paid orders', 'text')], sections: [table('summary', 'Weekday and hour', [col('weekday', 'Weekday'), col('hour', 'Hour'), col('orders', 'Orders', 'integer'), col('sales', 'Net sales', 'money'), col('average', 'Average order', 'money')], rows), register(orders), note(`Grouped by payment completion time in ${currentFormat().timezone}. Includes delivery fees; excludes tax. All 168 weekly slots are shown, including zero activity.`)] }
  }

  if (key === 'discounts-voids-refunds') {
    const audits = await db.auditLog.findMany({ where: { ...scope(f), module: 'orders', action: { in: ['complete', 'pay_check', 'cancel', 'cancel_item', 'refund', 'refund_checks'] }, createdAt: momentRange(f.fromDate, f.toDate) }, orderBy: { createdAt: 'asc' } })
    const [orders, refunds, users] = await Promise.all([
      db.customerOrder.findMany({ where: { ...scope(f), OR: [{ id: { in: audits.flatMap(a => a.resourceType === 'customer_order' && a.resourceId ? [a.resourceId] : []) } }, { closedAt: momentRange(f.fromDate, f.toDate), discountAmount: { gt: 0 } }, { closedAt: momentRange(f.fromDate, f.toDate), promotionAmount: { gt: 0 } }, { status: 'cancelled', updatedAt: momentRange(f.fromDate, f.toDate) }, { items: { some: { status: 'cancelled', updatedAt: momentRange(f.fromDate, f.toDate) } } }] }, include: orderInclude }),
      db.tillPayment.findMany({ where: { ...scope(f), type: 'refund', createdAt: momentRange(f.fromDate, f.toDate) } }),
      db.user.findMany({ where: { organizationId: f.organizationId }, select: { id: true, firstName: true, lastName: true } }),
    ])
    const names = new Map(users.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]))
    const rows: ReportRow[] = []
    const within = (d: Date) => { const r = momentRange(f.fromDate, f.toDate); return (!r?.gte || d >= r.gte) && (!r?.lt || d < r.lt) }
    const actor = (id: string | null) => id ? names.get(id) ?? id : 'Not recorded'
    const add = (o: typeof orders[number], type: string, amount: number, date: Date, reason: string | null, user: string | null) => {
      const action = type === 'Refund' ? ['refund', 'refund_checks'] : type === 'Void' ? ['cancel'] : type === 'Item void' ? ['cancel_item'] : ['complete']
      const audit = audits.filter(a => a.resourceId === o.id && action.includes(a.action) && Math.abs(a.createdAt.getTime() - date.getTime()) < 60000).sort((a, b) => Math.abs(a.createdAt.getTime() - date.getTime()) - Math.abs(b.createdAt.getTime() - date.getTime()))[0]
      const metadata = audit?.newData as { approvedBy?: string } | null
      rows.push({ _sourceOrderId: o.id, id: o.id, order: `#${o.orderNo}`, branch: o.branch.name, type, amount: round2(amount), date: date.toISOString(), reason: reason || 'Not recorded', employee: actor(audit?.userId ?? user), approver: metadata?.approvedBy ? actor(metadata.approvedBy) : 'Not recorded' })
    }

    for (const o of orders) {
      if (o.closedAt && within(o.closedAt) && ['completed', 'refunded'].includes(o.status)) {
        if (o.discountAmount > 0) add(o, 'Discount', o.discountAmount, o.closedAt, o.discountReason, o.closedBy)
        if (o.promotionAmount > 0) add(o, 'Promotion', o.promotionAmount, o.closedAt, o.couponCode || 'Automatic promotion', o.closedBy)
      }
      const cancellations = audits.filter(a => a.resourceId === o.id && a.action === 'cancel')
      if (cancellations.length) {
        for (const event of cancellations) { const data = event.newData as { reason?: string } | null; add(o, 'Void', o.totalAmount, event.createdAt, data?.reason ?? o.cancelReason, event.userId) }
      } else if (o.status === 'cancelled' && within(o.updatedAt)) add(o, 'Void', o.totalAmount, o.updatedAt, o.cancelReason, o.closedBy)
      for (const i of o.items.filter(i => i.status === 'cancelled')) {
        const event = audits.find(a => a.resourceId === o.id && a.action === 'cancel_item' && (a.newData as { itemId?: string } | null)?.itemId === i.id)
        if (event || (o.status !== 'cancelled' && within(i.updatedAt))) add(o, 'Item void', i.lineTotal, event?.createdAt ?? i.updatedAt, i.cancelReason || i.rejectReason, i.cancelledBy)
      }
    }
    const refundOrders = await db.customerOrder.findMany({ where: { ...scope(f), id: { in: [...new Set(refunds.map(p => p.orderId))] } }, include: orderInclude })
    for (const p of refunds) { const o = refundOrders.find(o => o.id === p.orderId); if (o) add(o, 'Refund', Math.abs(p.amount), p.createdAt, o.cancelReason, p.userId) }
    return { kpis: [kpi('Discounts and promotions', sum(rows.filter(r => ['Discount', 'Promotion'].includes(String(r.type))), r => n(r, 'amount'))), kpi('Voided value', sum(rows.filter(r => ['Void', 'Item void'].includes(String(r.type))), r => n(r, 'amount'))), kpi('Refund payments', sum(refunds, p => Math.abs(p.amount))), kpi('Events', rows.length, 'integer')], sections: [table('summary', 'Exception register', [col('order', 'Order'), col('branch', 'Branch'), col('date', 'Date', 'datetime'), col('type', 'Event'), col('amount', 'Value', 'money'), col('reason', 'Reason'), col('employee', 'Employee'), col('approver', 'Approver')], rows), note('Values include tax where applicable. Refunds use immutable payment events, including later refunds of earlier sales. Split refund payment methods are separate rows. Void dates on older records use last update time. Approvers and employees come from the matching action audit snapshot when available; unavailable approvals remain blank rather than inferred. Audit cancellation dates take precedence over mutable row timestamps. Void values are potential sales, not cash losses.')] }
  }

  if (key === 'ingredient-variance') {
    const [orders, moves, items] = await Promise.all([paidOrders(f, db), db.stockMovement.findMany({ where: { ...scope(f), createdAt: momentRange(f.fromDate, f.toDate), movementType: { in: ['sale', 'sale_return', 'stock_out', 'wastage'] } }, include: { branch: { select: { name: true } }, item: { select: { name: true, unit: true } } } }), db.item.findMany({ where: { organizationId: f.organizationId } })])
    const groups = new Map<string, ReportRow>(); let missing = 0
    const get = (branchId: string, branch: string, itemId: string) => { const key = `${branchId}:${itemId}`; let r = groups.get(key); if (!r) { const item = items.find(i => i.id === itemId); r = { branch, item: item?.name ?? itemId, unit: item?.unit ?? '', expected: 0, actual: 0, waste: 0, actualCost: 0, expectedCost: 0 }; groups.set(key, r) } return r }
    for (const o of orders) for (const i of o.items.filter(i => i.status !== 'cancelled')) {
      if (!Array.isArray(i.recipeUsage)) { missing++; continue }
      for (const entry of i.recipeUsage) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
        const g = entry as { itemId?: string; quantity?: number; unitCost?: number }
        if (!g.itemId || typeof g.quantity !== 'number') continue
        const r = get(o.branchId, o.branch.name, g.itemId); r.expected = n(r, 'expected') + g.quantity * i.quantity; r.expectedCost = n(r, 'expectedCost') + g.quantity * i.quantity * (g.unitCost ?? 0)
      }
    }
    for (const m of moves) { const r = get(m.branchId, m.branch.name, m.itemId); if (m.movementType === 'wastage') r.waste = n(r, 'waste') - m.quantity; else { r.actual = n(r, 'actual') - m.quantity; r.actualCost = n(r, 'actualCost') - m.quantity * m.unitCost } }
    const rows = [...groups.values()].map(r => ({ ...r, expected: qty(n(r, 'expected')), actual: qty(n(r, 'actual')), waste: qty(n(r, 'waste')), variance: qty(n(r, 'actual') - n(r, 'expected')), costVariance: round2(n(r, 'actualCost') - n(r, 'expectedCost')) }))
    return { kpis: [kpi('Expected ingredient cost', sum(rows, r => n(r, 'expectedCost'))), kpi('Recorded usage cost', sum(rows, r => n(r, 'actualCost'))), kpi('Usage cost variance', sum(rows, r => r.costVariance)), kpi('Lines without snapshots', missing, 'integer')], sections: [table('summary', 'Usage by ingredient and branch', [col('branch', 'Branch'), col('item', 'Ingredient'), col('unit', 'Unit'), col('expected', 'Expected', 'number'), col('actual', 'Recorded usage', 'number'), col('variance', 'Usage variance', 'number'), col('waste', 'Waste (separate)', 'number'), col('costVariance', 'Cost variance', 'money')], rows), table('movements', 'Source stock movements', [col('date', 'Date', 'datetime'), col('branch', 'Branch'), col('item', 'Ingredient'), col('type', 'Type'), col('quantity', 'Signed quantity', 'number'), col('reference', 'Source reference')], moves.map(m => ({ date: m.createdAt.toISOString(), branch: m.branch.name, item: m.item.name, type: m.movementType, quantity: m.quantity, reference: `${m.referenceType ?? ''} ${m.referenceId ?? ''}` }))), register(orders), note('Expected quantities use immutable recipes captured at payment, including sizes, modifiers, combos and waste allowances. Older orders without snapshots are excluded from expected quantities and counted above. Recorded usage = sale + kitchen stock issues - sale returns; transfers are excluded and waste is shown separately. Stock issues measure kitchen supply, not measured consumption. Timing, refunds and missing snapshots can cause differences; these are not automatically unexplained losses.')] }
  }

  if (key === 'kitchen-performance') {
    const orders = await db.customerOrder.findMany({ where: { ...scope(f), status: { in: ['completed', 'refunded'] }, closedAt: momentRange(f.fromDate, f.toDate) }, include: orderInclude })
    const now = new Date(); const rows: ReportRow[] = []
    for (const o of orders) for (const i of o.items.filter(i => i.status !== 'cancelled' && !i.held)) {
      const start = new Date(Math.max(o.closedAt?.getTime() ?? i.createdAt.getTime(), i.createdAt.getTime(), i.firedAt?.getTime() ?? 0))
      const elapsed = Math.max(0, ((i.readyAt ?? now).getTime() - start.getTime()) / 60000)
      rows.push({ _sourceOrderId: o.id, order: `#${o.orderNo}`, branch: o.branch.name, dish: i.dishName, station: i.station?.name ?? 'Unassigned', status: i.status, date: start.toISOString(), ready: i.readyAt?.toISOString(), minutes: i.readyAt ? round2(elapsed) : null, target: i.dish.prepMinutes, late: i.dish.prepMinutes && (i.readyAt || ['pending', 'preparing'].includes(i.status)) ? (elapsed > i.dish.prepMinutes ? 'Yes' : 'No') : 'Unknown', activeAge: ['pending', 'preparing'].includes(i.status) ? round2(elapsed) : null })
    }
    const measured = rows.filter(r => r.ready)
    const stations = new Map<string, ReportRow>()
    for (const r of rows) { const key = `${r.branch}:${r.station}`; const g = stations.get(key) ?? { branch: r.branch, station: r.station, tickets: 0, measured: 0, minutes: 0, late: 0 }; g.tickets = n(g, 'tickets') + 1; if (r.ready) { g.measured = n(g, 'measured') + 1; g.minutes = n(g, 'minutes') + n(r, 'minutes') } if (r.late === 'Yes') g.late = n(g, 'late') + 1; stations.set(key, g) }
    return { kpis: [kpi('Kitchen lines', rows.length, 'integer'), kpi('Measured ready times', measured.length, 'integer'), kpi('Average minutes to ready', measured.length ? sum(measured, r => n(r, 'minutes')) / measured.length : 'Not available', measured.length ? 'number' : 'text'), kpi('Late lines', rows.filter(r => r.late === 'Yes').length, 'integer')], sections: [table('summary', 'Station performance', [col('branch', 'Branch'), col('station', 'Station'), col('tickets', 'Lines', 'integer'), col('measured', 'Measured', 'integer'), col('average', 'Avg minutes', 'number'), col('late', 'Late lines', 'integer')], [...stations.values()].map(r => ({ ...r, average: n(r, 'measured') ? round2(n(r, 'minutes') / n(r, 'measured')) : null }))), table('lines', 'Kitchen line register', [col('order', 'Order'), col('branch', 'Branch'), col('dish', 'Dish'), col('station', 'Station'), col('status', 'Status', 'status'), col('date', 'Released', 'datetime'), col('ready', 'Ready', 'datetime'), col('minutes', 'Minutes', 'number'), col('target', 'Target minutes', 'integer'), col('late', 'Late'), col('activeAge', 'Active age', 'number')], rows), note('Time to ready starts when a paid line is released, or when a held course is fired. Historical lines without recorded ready times are not estimated from updatedAt. Targets reflect the current dish setting. Active ages are live; comparative completed-time averages exclude unmeasured lines.')] }
  }

  if (key === 'delivery-profitability') {
    const [all, breakdown] = await Promise.all([paidOrders(f, db), db.deliveryBreakdown.findMany({ where: { dailySale: { ...scope(f), status: { not: 'void' }, saleDate: calendar(f) } }, include: { dailySale: { include: { branch: { select: { name: true } } } } } })])
    const orders = all.filter(o => o.orderType === 'delivery'); const groups = new Map<string, ReportRow>()
    for (const o of orders) { const key = `${o.branchId}:${o.source}`; const r = groups.get(key) ?? { branch: o.branch.name, channel: o.source, orders: 0, sales: 0, cost: 0, discounts: 0 }; r.orders = n(r, 'orders') + 1; r.sales = n(r, 'sales') + netSales(o); r.cost = n(r, 'cost') + o.foodCost; r.discounts = n(r, 'discounts') + o.discountAmount + o.promotionAmount; groups.set(key, r) }
    const sales = sum(orders, netSales), cost = sum(orders, o => o.foodCost)
    return { kpis: [kpi('Delivery net sales', sales), kpi('Recorded food cost', cost), kpi('Contribution before delivery costs', sales - cost), kpi('Recorded platform commissions', sum(breakdown, b => b.commission))], sections: [table('summary', 'Order channel contribution', [col('branch', 'Branch'), col('channel', 'Channel'), col('orders', 'Orders', 'integer'), col('sales', 'Net sales', 'money'), col('discounts', 'Discounts incl. tax', 'money'), col('cost', 'Food cost', 'money'), col('contribution', 'Before delivery costs', 'money')], [...groups.values()].map(r => ({ ...r, sales: round2(n(r, 'sales')), cost: round2(n(r, 'cost')), contribution: round2(n(r, 'sales') - n(r, 'cost')) }))), table('platforms', 'Platform statements recorded in Daily Sales', [col('sale', 'Sale'), col('branch', 'Branch'), col('date', 'Sale date', 'date'), col('platform', 'Platform'), col('sales', 'Statement sales', 'money'), col('commission', 'Commission', 'money'), col('settlement', 'Net proceeds', 'money')], breakdown.map(b => ({ sale: b.dailySale.saleNo, branch: b.dailySale.branch.name, date: b.dailySale.saleDate.toISOString(), platform: b.platform, sales: b.amount, commission: b.commission, settlement: b.netAmount }))), register(orders), note('Order contribution includes delivery-fee revenue and already deducts discounts and tax. Platform statement totals are shown separately because statements are not linked to individual orders and may overlap them. Rider costs, payment fees and platform-to-order attribution are not recorded: final delivery profit is unavailable. Never subtract the platform table from the order table as though coverage were identical.')] }
  }

  if (key === 'supplier-price-changes') {
    const bills = await db.bill.findMany({ where: { ...scope(f), status: { in: ['approved', 'partial', 'paid'] }, ...(f.toDate && { billDate: { lt: new Date(Date.parse(f.toDate) + 86400000) } }) }, include: { supplier: { select: { name: true } }, branch: { select: { name: true } }, items: true }, orderBy: [{ billDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
    const items = await db.item.findMany({ where: { organizationId: f.organizationId } }); const previous = new Map<string, { price: number; date: string; bill: string }>(); const rows: ReportRow[] = []
    for (const b of bills) {
      const combined = new Map<string, { quantity: number; amount: number }>()
      for (const i of b.items) if (i.itemId && i.quantity > 0) { const g = combined.get(i.itemId) ?? { quantity: 0, amount: 0 }; g.quantity += i.quantity; g.amount += i.quantity * i.unitPrice; combined.set(i.itemId, g) }
      for (const [itemId, g] of combined) {
        const key = `${b.branchId}:${b.supplierId}:${itemId}`; const old = previous.get(key); const price = g.amount / g.quantity; const item = items.find(i => i.id === itemId)
        if (!f.fromDate || b.billDate >= new Date(f.fromDate)) rows.push({ bill: b.billNo, branch: b.branch.name, supplier: b.supplier.name, item: item?.name ?? itemId, unit: item?.unit ?? '', date: b.billDate.toISOString(), previousBill: old?.bill, previous: old?.price, price: round2(price), change: old ? round2(price - old.price) : null, changePct: old && old.price > 0 ? round2((price - old.price) / old.price * 100) : null, quantity: g.quantity, impact: old ? round2((price - old.price) * g.quantity) : null })
        previous.set(key, { price, date: b.billDate.toISOString(), bill: b.billNo })
      }
    }
    return { kpis: [kpi('Purchase item observations', rows.length, 'integer'), kpi('Price increases', rows.filter(r => n(r, 'change') > 0).length, 'integer'), kpi('Price decreases', rows.filter(r => n(r, 'change') < 0).length, 'integer'), kpi('Spending impact vs prior prices', sum(rows, r => n(r, 'impact')))], sections: [table('summary', 'Purchase price history', [col('bill', 'Bill'), col('branch', 'Branch'), col('supplier', 'Supplier'), col('item', 'Item'), col('unit', 'Unit'), col('date', 'Bill date', 'date'), col('previousBill', 'Previous bill'), col('previous', 'Prior unit price', 'money'), col('price', 'Unit price', 'money'), col('changePct', 'Change', 'percent'), col('quantity', 'Purchased', 'number'), col('impact', 'Spending impact', 'money')], rows), note('Compares consecutive approved purchases for the same branch, supplier and inventory item, including the last purchase before the selected period. Same-bill lines are quantity-weighted. Prices exclude tax and document-level discounts; all quantities use the item unit. Unlinked bill descriptions are excluded. First observations have no prior price and no change percentage.')] }
  }

  if (key === 'customer-retention') {
    const history = await db.customerOrder.findMany({ where: { ...scope(f), status: 'completed', customerId: { not: null }, ...(f.toDate && { closedAt: { lt: momentRange(undefined, f.toDate)!.lt } }) }, include: orderInclude, orderBy: [{ closedAt: 'asc' }, { id: 'asc' }] })
    const range = momentRange(f.fromDate, f.toDate); const groups = new Map<string, Order[]>()
    for (const o of history) groups.set(o.customerId!, [...(groups.get(o.customerId!) ?? []), o])
    const end = range?.lt ?? new Date(); const rows: ReportRow[] = []; let newCount = 0, returning = 0, repeat = 0, sales = 0, visits = 0
    for (const [id, orders] of groups) {
      const inPeriod = orders.filter(o => !range?.gte || o.closedAt! >= range.gte); const first = orders[0], last = orders[orders.length - 1]; const days = Math.max(0, Math.floor((end.getTime() - last.closedAt!.getTime()) / 86400000)); const isNew = !range?.gte || first.closedAt! >= range.gte
      if (inPeriod.length) { if (isNew) newCount++; else returning++; if (inPeriod.length >= 2) repeat++; sales += sum(inPeriod, netSales); visits += inPeriod.length }
      rows.push({ customer: last.customerName || `Customer ${id}`, customerId: id, cohort: inPeriod.length ? (isNew ? 'New' : 'Returning') : 'Inactive in period', visits: inPeriod.length, lifetimeVisits: orders.length, spend: round2(sum(inPeriod, netSales)), first: first.closedAt!.toISOString(), last: last.closedAt!.toISOString(), inactiveDays: days, inactive: days >= 60 ? '60+ days' : 'Recent' })
    }
    const active = newCount + returning
    return { kpis: [kpi('New customers', newCount, 'integer'), kpi('Returning customers', returning, 'integer'), kpi('Repeat purchase rate', pct(repeat, active), 'percent'), kpi('Average identified order', visits ? sales / visits : 0)], sections: [table('summary', 'Customer cohorts and activity', [col('customer', 'Customer'), col('cohort', 'Cohort'), col('visits', 'Period visits', 'integer'), col('lifetimeVisits', 'History visits', 'integer'), col('spend', 'Period net spend', 'money'), col('first', 'First visit', 'datetime'), col('last', 'Last visit', 'datetime'), col('inactiveDays', 'Days since visit', 'integer'), col('inactive', 'Activity')], rows), register(history.filter(o => !range?.gte || o.closedAt! >= range.gte)), note('Only completed orders linked to a customer ID are included. New = first completed visit in this branch scope falls within the period; returning = visited before it. Repeat purchase rate = customers with at least two visits in the period / active identified customers. Inactivity is measured at the selected end date (or now), with a 60-day threshold. Anonymous sales and refunded orders are excluded.')] }
  }

  if (key === 'table-performance') {
    const orders = (await paidOrders(f, db)).filter(o => o.tableId && o.orderType === 'dine_in');
    const clears = await db.auditLog.findMany({ where: { ...scope(f), action: 'table_clear', createdAt: momentRange(f.fromDate, f.toDate) } });
    const occupancies: ReportRow[] = clears.flatMap(event => { const data = event.newData as { seatedAt?: string; clearedAt?: string; tableName?: string; guestCount?: number } | null; if (!data?.seatedAt || !data.clearedAt) return []; const minutes = (Date.parse(data.clearedAt) - Date.parse(data.seatedAt)) / 60000; return Number.isFinite(minutes) && minutes >= 0 ? [{ table: data.tableName ?? event.resourceId, branch: event.branchId, seated: data.seatedAt, cleared: data.clearedAt, guests: data.guestCount, minutes: round2(minutes) }] : [] }); const groups = new Map<string, ReportRow>(); const detail: ReportRow[] = []
    for (const o of orders) {
      const active = o.items.filter(i => i.status !== 'cancelled'); const served = active.length > 0 && active.every(i => i.servedAt); const end = served ? Math.max(...active.map(i => i.servedAt!.getTime())) : null; const minutes = end ? Math.max(0, (end - o.createdAt.getTime()) / 60000) : null
      const r = groups.get(o.tableId!) ?? { table: o.table?.name ?? o.tableId, branch: o.branch.name, visits: 0, guests: 0, guestVisits: 0, sales: 0, measured: 0, minutes: 0 }
      r.visits = n(r, 'visits') + 1; r.sales = n(r, 'sales') + netSales(o); if (o.guestCount != null) { r.guests = n(r, 'guests') + o.guestCount; r.guestVisits = n(r, 'guestVisits') + 1 } if (minutes !== null) { r.measured = n(r, 'measured') + 1; r.minutes = n(r, 'minutes') + minutes } groups.set(o.tableId!, r)
      detail.push({ _sourceOrderId: o.id, order: `#${o.orderNo}`, table: o.table?.name, branch: o.branch.name, guests: o.guestCount, opened: o.createdAt.toISOString(), paid: o.closedAt!.toISOString(), served: end ? new Date(end).toISOString() : null, minutes: minutes === null ? null : round2(minutes), sales: round2(netSales(o)) })
    }
    const sales = sum(orders, netSales), measured = detail.filter(r => r.minutes !== null)
    return { kpis: [kpi('Table visits', orders.length, 'integer'), kpi('Measured table turns', occupancies.length, 'integer'), kpi('Average occupancy minutes', occupancies.length ? sum(occupancies, r => n(r, 'minutes')) / occupancies.length : 'Not available', occupancies.length ? 'number' : 'text'), kpi('Recorded guests', sum(orders, o => o.guestCount ?? 0), 'integer'), kpi('Average check', orders.length ? sales / orders.length : 0), kpi('Average minutes to full service', measured.length ? sum(measured, r => n(r, 'minutes')) / measured.length : 'Not available', measured.length ? 'number' : 'text')], sections: [table('summary', 'Table performance', [col('branch', 'Branch'), col('table', 'Table'), col('visits', 'Visits', 'integer'), col('guests', 'Known guests', 'integer'), col('guestVisits', 'Visits with guest counts', 'integer'), col('sales', 'Net sales', 'money'), col('average', 'Average check', 'money'), col('service', 'Avg service minutes', 'number'), col('measured', 'Timed visits', 'integer')], [...groups.values()].map(r => ({ ...r, sales: round2(n(r, 'sales')), average: round2(n(r, 'sales') / n(r, 'visits')), service: n(r, 'measured') ? round2(n(r, 'minutes') / n(r, 'measured')) : null }))), table('visits', 'Source table visits', [col('order', 'Order'), col('branch', 'Branch'), col('table', 'Table'), col('guests', 'Guests', 'integer'), col('opened', 'Opened', 'datetime'), col('paid', 'Paid', 'datetime'), col('served', 'Fully served', 'datetime'), col('minutes', 'Service minutes', 'number'), col('sales', 'Net sales', 'money')], detail), table('turnover', 'Measured table occupancy and turns', [col('table', 'Table'), col('branch', 'Branch ID'), col('seated', 'Seated', 'datetime'), col('cleared', 'Cleared', 'datetime'), col('guests', 'Guests', 'integer'), col('minutes', 'Occupancy minutes', 'number')], occupancies), note('A completed dine-in order counts as one visit. Split checks stay one visit. Service duration runs from order creation to the last active line being served, and is unavailable without complete timestamps. Payment time is not table departure time. Measured table turns and occupancy use explicit seated/cleared timestamps captured when staff clear a table. Older clear events without these timestamps are excluded; order visits and measured table turns are different populations.')] }
  }

  if (key === 'branch-targets') {
    const [sales, targets, branches, orders] = await Promise.all([db.dailySale.findMany({ where: { ...scope(f), status: { not: 'void' }, saleDate: calendar(f) } }), db.branchTarget.findMany({ where: scope(f) }), db.branch.findMany({ where: { organizationId: f.organizationId, ...(f.branchId && { id: f.branchId }) } }), paidOrders(f, db)])
    const rows: ReportRow[] = []
    const months = new Set(sales.map(s => s.saleDate.toISOString().slice(0, 7)))
    for (const t of targets) { const month = `${t.year}-${String(t.month).padStart(2, '0')}`; if ((!f.fromDate || month >= f.fromDate.slice(0, 7)) && (!f.toDate || month <= f.toDate.slice(0, 7))) months.add(month) }
    if (f.fromDate && f.toDate) {
      const month = new Date(`${f.fromDate.slice(0, 7)}-01T00:00:00Z`)
      while (month.getTime() <= Date.parse(f.toDate)) { months.add(month.toISOString().slice(0, 7)); month.setUTCMonth(month.getUTCMonth() + 1) }
    }
    for (const b of branches) for (const month of [...months].sort()) {
      const start = new Date(`${month}-01T00:00:00Z`); const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)); const days = (end.getTime() - start.getTime()) / 86400000
      const first = Math.max(start.getTime(), f.fromDate ? Date.parse(f.fromDate) : start.getTime()); const last = Math.min(end.getTime(), f.toDate ? Date.parse(f.toDate) + 86400000 : end.getTime()); if (last <= first) continue
      const target = targets.find(t => t.branchId === b.id && t.year === start.getUTCFullYear() && t.month === start.getUTCMonth() + 1)
      const total = sum(sales.filter(s => s.branchId === b.id && s.saleDate.toISOString().startsWith(month)), s => s.netAmount)
      const prorated = target ? target.salesTarget * (last - first) / 86400000 / days : null
      const paid = orders.filter(o => { const p = zonedParts(o.closedAt!, currentFormat().timezone); return o.branchId === b.id && `${p.y}-${String(p.m).padStart(2, '0')}` === month })
      const orderSales = sum(paid, netSales), orderCost = sum(paid, o => o.foodCost)
      rows.push({ branch: b.name, month, orderSales: round2(orderSales), orderContribution: round2(orderSales - orderCost), orderMargin: orderSales > 0 ? pct(orderSales - orderCost, orderSales) : null, sales: round2(total), fullTarget: target?.salesTarget ?? null, target: prorated === null ? null : round2(prorated), variance: prorated === null ? null : round2(total - prorated), achievement: prorated && prorated > 0 ? pct(total, prorated) : null })
    }
    const actual = sum(rows, r => n(r, 'sales')), target = sum(rows, r => n(r, 'target'))
    return { kpis: [kpi('Target-basis sales', actual), kpi('Prorated configured targets', target), kpi('Achievement (configured rows)', target > 0 ? pct(sum(rows.filter(r => r.target !== null), r => n(r, 'sales')), target) : 'No positive targets', target > 0 ? 'percent' : 'text'), kpi('Rows without targets', rows.filter(r => r.target === null).length, 'integer'), kpi('Order contribution margin', pct(sum(orders, o => netSales(o) - o.foodCost), sum(orders, netSales)), 'percent')], sections: [table('summary', 'Monthly branch targets', [col('branch', 'Branch'), col('month', 'Month'), col('sales', 'Target-basis sales', 'money'), col('fullTarget', 'Full-month target', 'money'), col('target', 'Prorated target', 'money'), col('variance', 'Variance', 'money'), col('achievement', 'Achievement', 'percent'), col('orderSales', 'Order net sales excl. tax', 'money'), col('orderContribution', 'Order contribution', 'money'), col('orderMargin', 'Order margin', 'percent')], rows), table('sales', 'Source daily sales', [col('sale', 'Sale'), col('date', 'Date', 'date'), col('branch', 'Branch'), col('sales', 'Target-basis sales', 'money')], sales.map(s => ({ sale: s.saleNo, date: s.saleDate.toISOString(), branch: branches.find(b => b.id === s.branchId)?.name, sales: round2(s.netAmount) }))), note('Uses non-void Daily Sales, including manual sales. Targets use Daily Sales netAmount (including tax), matching dashboard target calculations. Partial-month targets are prorated by selected calendar days / days in month. Unconfigured targets stay blank and are excluded from achievement. Order contribution margins use completed-order revenue excluding tax less stored food cost, and exclude manual daily sales and operating expenses. Margin targets are not configured in FoodSync.')] }
  }

  if (key === 'stock-replenishment') {
    const today = todayInZone().toISOString().slice(0, 10); const end = f.toDate ?? today; const start = f.fromDate ?? new Date(Date.parse(end) - 29 * 86400000).toISOString().slice(0, 10); const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1)
    const [stocks, moves, openOrders] = await Promise.all([
      db.branchStock.findMany({ where: scope(f), include: { item: true, branch: { select: { name: true } } } }),
      db.stockMovement.findMany({ where: { ...scope(f), createdAt: momentRange(start, end), movementType: { in: ['sale', 'sale_return', 'stock_out', 'wastage'] } }, include: { item: { select: { name: true } }, branch: { select: { name: true } } } }),
      db.purchaseOrder.findMany({ where: { ...scope(f), status: 'approved', receivedAt: null }, include: { items: true, branch: { select: { name: true } } } }),
    ])
    const rows = stocks.map(s => { const used = Math.max(0, -sum(moves.filter(m => m.branchId === s.branchId && m.itemId === s.itemId), m => m.quantity)); const daily = used / days; const onOrder = sum(openOrders.filter(po => po.branchId === s.branchId).flatMap(po => po.items).filter(i => i.itemId === s.itemId), i => i.quantity); const minimum = s.reorderPoint || s.item.reorderPoint; const target = Math.max(minimum, daily * 14); return { branch: s.branch.name, item: s.item.name, unit: s.item.unit, stock: s.quantityOnHand, onOrder: qty(onOrder), used: qty(used), daily: qty(daily), daysLeft: daily > 0 ? round2(Math.max(0, s.quantityOnHand) / daily) : null, minimum, suggested: qty(Math.max(0, target - s.quantityOnHand - onOrder)), status: s.quantityOnHand <= minimum ? 'Reorder' : daily > 0 && s.quantityOnHand / daily < 7 ? 'Under 7 days' : 'Sufficient' } }).sort((a, b) => b.suggested - a.suggested)
    return { kpis: [kpi('Stock lines', rows.length, 'integer'), kpi('At or below reorder point', rows.filter(r => r.status === 'Reorder').length, 'integer'), kpi('Under 7 days of stock', rows.filter(r => r.daysLeft !== null && r.daysLeft < 7).length, 'integer'), kpi('Items without observed usage', rows.filter(r => r.daily === 0).length, 'integer')], sections: [table('summary', 'Replenishment suggestions', [col('branch', 'Branch'), col('item', 'Item'), col('unit', 'Unit'), col('stock', 'Current stock', 'number'), col('onOrder', 'On approved orders', 'number'), col('used', 'Period usage', 'number'), col('daily', 'Usage/day', 'number'), col('daysLeft', 'Days remaining', 'number'), col('minimum', 'Reorder point', 'number'), col('suggested', 'Suggested quantity', 'number'), col('status', 'Status')], rows), table('movements', 'Source usage movements', [col('branch', 'Branch'), col('item', 'Item'), col('date', 'Date', 'datetime'), col('type', 'Type'), col('quantity', 'Signed quantity', 'number')], moves.map(m => ({ branch: m.branch.name, item: m.item.name, date: m.createdAt.toISOString(), type: m.movementType, quantity: m.quantity }))), table('purchase-orders', 'Open approved purchase orders', [col('po', 'Purchase order'), col('branch', 'Branch'), col('expected', 'Expected delivery', 'date'), col('item', 'Item'), col('quantity', 'Ordered quantity', 'number')], openOrders.flatMap(po => po.items.map(i => ({ po: po.poNo, branch: po.branch.name, expected: po.expectedDeliveryDate?.toISOString(), item: i.description, quantity: i.quantity })))), note(`Current stock snapshot; demand sample ${start} through ${end} (${days} calendar days). Usage includes sales, kitchen issues and waste, less sale returns; excludes transfers. Suggested quantity deducts quantities on approved, unreceived purchase orders and brings stock to the greater of the reorder point and 14 days of observed usage. Lead times, seasonality and expiry are not modeled; confirm expected deliveries before relying on on-order quantities. No observed usage leaves days remaining blank. Prior-period comparisons reuse current stock and current open orders with the prior demand sample.`)] }
  }

  // Reconcile independent payment evidence without combining overlapping sources.
  const [payments, tills, intents, collections, settlements] = await Promise.all([
    db.tillPayment.findMany({ where: { ...scope(f), createdAt: momentRange(f.fromDate, f.toDate) } }),
    db.tillSession.findMany({ where: { ...scope(f), closedAt: { ...momentRange(f.fromDate, f.toDate), not: null } } }),
    db.paymentIntent.findMany({ where: { ...scope(f), settledAt: { ...momentRange(f.fromDate, f.toDate), not: null } } }),
    db.riderCashCollection.findMany({ where: { ...scope(f), collectedAt: momentRange(f.fromDate, f.toDate) }, include: { rider: { select: { name: true } } } }),
    db.riderSettlement.findMany({ where: { ...scope(f), settledAt: momentRange(f.fromDate, f.toDate) }, include: { rider: { select: { name: true } } } }),
  ])
  // Settlement matching must include payments outside the selected range at midnight boundaries.
  const matched = await db.tillPayment.findMany({ where: { ...scope(f), orderId: { in: [...new Set(intents.map(i => i.orderId))] } } })
  const gatewayRows = intents.map(i => { const p = matched.filter(p => p.orderId === i.orderId && (i.checkId ? p.checkId === i.checkId : !p.checkId) && ['card', 'mada'].includes(p.method)); const booked = sum(p.filter(p => p.type === 'sale'), p => Math.abs(p.amount)); const refunds = sum(p.filter(p => p.type === 'refund'), p => Math.abs(p.amount)); return { _sourceOrderId: i.orderId, intent: i.id, order: i.orderId, provider: i.providerRef, adapter: i.adapter, expected: round2(i.amount - i.refundedAmount), recorded: round2(booked - refunds), difference: round2(booked - refunds - i.amount + i.refundedAmount) } })
  const methods = [...new Set(payments.map(p => p.method))].sort().map(method => ({ method, sales: round2(sum(payments.filter(p => p.method === method && p.type === 'sale'), p => Math.abs(p.amount))), refunds: round2(sum(payments.filter(p => p.method === method && p.type === 'refund'), p => Math.abs(p.amount))), net: round2(sum(payments.filter(p => p.method === method), p => (p.type === 'refund' ? -1 : 1) * Math.abs(p.amount))) }))
  return { kpis: [kpi('Net recorded payments', sum(methods, r => r.net)), kpi('Closed till cash difference', sum(tills, t => t.difference)), kpi('Gateway booking difference', sum(gatewayRows, r => r.difference)), kpi('Unsettled rider collections', sum(collections.filter(c => !c.settlementId), c => c.amount))], sections: [table('summary', 'Payment methods', [col('method', 'Method'), col('sales', 'Receipts', 'money'), col('refunds', 'Refunds', 'money'), col('net', 'Net', 'money')], methods), table('tills', 'Closed till reconciliation', [col('till', 'Till'), col('date', 'Closed', 'datetime'), col('expected', 'Expected cash', 'money'), col('counted', 'Counted cash', 'money'), col('difference', 'Difference', 'money')], tills.map(t => ({ till: t.id, date: t.closedAt!.toISOString(), expected: t.expectedCash, counted: t.countedCash, difference: t.difference }))), table('gateway', 'Gateway intent to payment booking', [col('intent', 'Intent'), col('order', 'Order ID'), col('provider', 'Provider reference'), col('adapter', 'Adapter'), col('expected', 'Net gateway amount', 'money'), col('recorded', 'Net booked', 'money'), col('difference', 'Difference', 'money')], gatewayRows), table('riders', 'Rider collections', [col('rider', 'Rider'), col('order', 'Order ID'), col('date', 'Collected', 'datetime'), col('amount', 'Collected', 'money'), col('settlement', 'Settlement')], collections.map(c => ({ rider: c.rider.name, _sourceOrderId: c.orderId, order: c.orderId, date: c.collectedAt.toISOString(), amount: c.amount, settlement: c.settlementId ?? 'Unsettled' }))), table('settlements', 'Rider settlement differences', [col('rider', 'Rider'), col('settlement', 'Settlement'), col('expected', 'Expected', 'money'), col('counted', 'Counted', 'money'), col('difference', 'Difference', 'money')], settlements.map(s => ({ rider: s.rider.name, settlement: s.number, expected: s.expectedCash, counted: s.countedCash, difference: s.difference }))), table('payments', 'Source payment events', [col('order', 'Order ID'), col('date', 'Date', 'datetime'), col('method', 'Method'), col('type', 'Type'), col('amount', 'Amount', 'money'), col('reference', 'Reference')], payments.map(p => ({ _sourceOrderId: p.orderId, order: p.orderId, date: p.createdAt.toISOString(), method: p.method, type: p.type, amount: p.amount, reference: p.referenceKey }))), note('Payment events, closed tills, gateway intents and rider cash are independent, overlapping controls and must not be added together. Gateway comparison verifies internal booking, not bank settlement: external provider payout statements and fees are not imported. Intent rows use their full linked booking history; rider unsettled status is current.')] }
}

export async function operationalSections(key: OperationalReportKey, f: ReportFilters, db: Prisma.TransactionClient = prisma): Promise<Result> {
  const result = await buildOperationalReport(key, f, db)
  if (f.fromDate && f.toDate) {
    const days = Math.round((Date.parse(f.toDate) - Date.parse(f.fromDate)) / 86400000) + 1
    const toDate = new Date(Date.parse(f.fromDate) - 86400000).toISOString().slice(0, 10)
    const fromDate = new Date(Date.parse(f.fromDate) - days * 86400000).toISOString().slice(0, 10)
    const previous = await buildOperationalReport(key, { ...f, fromDate, toDate }, db)
    result.sections.unshift(table('comparison', 'Previous period comparison', [col('metric', 'Metric'), col('current', 'Selected period', 'number'), col('previous', 'Previous period', 'number'), col('change', 'Change', 'number'), col('changePct', 'Change', 'percent')], result.kpis.flatMap((k, i) => typeof k.value === 'number' && typeof previous.kpis[i]?.value === 'number' ? [{ metric: `${k.label}${k.format === 'money' ? ` (${currentFormat().currency})` : k.format === 'percent' ? ' (%)' : ''}`, current: k.value, previous: previous.kpis[i].value, change: round2(k.value - Number(previous.kpis[i].value)), changePct: Number(previous.kpis[i].value) !== 0 ? round2((k.value - Number(previous.kpis[i].value)) / Math.abs(Number(previous.kpis[i].value)) * 100) : null }] : []), `Compared with ${fromDate} through ${toDate}; equal calendar-day length. Percentage changes from zero are undefined.`))
  } else result.sections.unshift({ type: 'note', id: 'comparison', title: 'Period comparison', text: 'Select both a start and end date to compare with the immediately preceding period of the same length.' })
  return result
}
