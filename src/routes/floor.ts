import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { recalcOrderTotals } from '../utils/menu'
import { lockOrder, orderInclude, publishOrder, assertBillEditable } from './orders'
import { payCheck, payCheckSchema, splitOrder, splitSchema, refundChecks } from '../services/orderChecks'
import { issueForOrder } from '../services/zatca'
import { publish } from '../utils/liveEvents'
import { tableStatus } from '../utils/tableStatus'
import { assertTableService } from '../utils/tableService'
import { posMenu, sendPosOrder } from './pos'
import { formatContextFor, withReportFormat } from '../utils/reportFormat'
import { getUserPermissions } from '../utils/permissions'
import { sendProReport } from '../utils/proReport'
import { cancelOpenIntents, refundIntentsForOrder } from '../services/payments'

const view = requireAnyPermission('can_take_orders', 'can_manage_orders', 'can_manage_menu')
const cashier = requirePermission('can_manage_orders')
async function activeAccount(req: Request, _res: Response, next: NextFunction) {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
}
export const floorRouter = Router()
// floor operations need floor/cashier/menu permission; the covers report
// below needs report permission only
floorRouter.use(authenticate, activeAccount)

floorRouter.get('/', view, async (req: Request, res: Response) => {
  const branch = await branchFilter(req, String(req.query.branchId ?? ''))
  const tables = await prisma.diningTable.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }), isActive: true },
    include: { branch: { select: { id: true, name: true } }, orders: { where: { status: 'open' }, select: { id: true, orderNo: true, totalAmount: true, guestCount: true, createdAt: true, billRequestedAt: true, _count: { select: { checks: true } } }, orderBy: { createdAt: 'asc' } } }, orderBy: [{ section: 'asc' }, { name: 'asc' }] })
  res.json({ data: tables.map(({ orders, ...t }) => ({ ...t, openOrder: orders[0] ?? null, floorStatus: tableStatus(t, orders[0] ?? null) })) })
})

floorRouter.put('/layout', view, requirePermission('can_manage_menu'), async (req: Request, res: Response) => {
  const body = z.object({ branchId: z.string().min(1), tables: z.array(z.object({ id: z.string().min(1), section: z.string().trim().min(1).max(50), x: z.number().finite().min(0).max(100), y: z.number().finite().min(0).max(100), shape: z.enum(['rectangle', 'round']), seats: z.number().int().min(1).max(100).nullable() })).max(200) }).parse(req.body)
  await assertBranchAccess(req, body.branchId)
  if (new Set(body.tables.map((t) => t.id)).size !== body.tables.length) throw new AppError('Each table must appear once', 400, 'VALIDATION_ERROR')
  await prisma.$transaction(async (tx) => {
    const rows = await tx.diningTable.findMany({ where: { id: { in: body.tables.map((t) => t.id) }, organizationId: req.user.organizationId, branchId: body.branchId } })
    if (rows.length !== body.tables.length) throw new AppError('A table is outside this branch', 404, 'NOT_FOUND')
    for (const { id, ...data } of body.tables) await tx.diningTable.update({ where: { id }, data })
    await logAudit(tx, { req, action: 'floor_layout', module: 'menu', branchId: body.branchId, newData: body })
  })
  publish({ topic: 'table', action: 'changed', organizationId: req.user.organizationId, branchId: body.branchId })
  res.json({ saved: true })
})

floorRouter.post('/tables/:id/:action', view, async (req: Request, res: Response) => {
  const action = z.enum(['seat', 'clear']).parse(req.params.action)
  const body = z.object({ guestCount: z.number().int().min(1).max(100).optional() }).parse(req.body ?? {})
  const table = await prisma.diningTable.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId, isActive: true, branch: { isActive: true } }, include: { branch: { select: { tableOrderingEnabled: true } } } })
  if (!table) throw new AppError('Table not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, table.branchId)
  // clearing stays possible, so tables left seated can be tidied up
  if (action === 'seat') assertTableService(table.branch)
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${table.id} FOR UPDATE`
    const fresh = await tx.diningTable.findUniqueOrThrow({ where: { id: table.id } })
    const open = await tx.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' } })
    if (action === 'clear' && open) throw new AppError('Close or cancel the running order before clearing the table', 409, 'TABLE_BUSY')
    if (action === 'seat' && fresh.needsClearing) throw new AppError('Clear the table before seating new guests', 409, 'TABLE_NEEDS_CLEARING')
    if (action === 'seat' && !body.guestCount) throw new AppError('Enter the guest count', 400, 'VALIDATION_ERROR')
    if (action === 'seat' && open) await tx.customerOrder.update({ where: { id: open.id }, data: { guestCount: body.guestCount } })
    const updated = await tx.diningTable.update({ where: { id: table.id }, data: action === 'clear' ? { seatedAt: null, guestCount: null, needsClearing: false } : { seatedAt: fresh.seatedAt ?? new Date(), guestCount: body.guestCount } })
    await logAudit(tx, { req, action: `table_${action}`, module: 'orders', resourceType: 'dining_table', resourceId: table.id, branchId: table.branchId, newData: { ...body, ...(action === 'clear' && fresh.seatedAt ? { seatedAt: fresh.seatedAt.toISOString(), clearedAt: new Date().toISOString(), guestCount: fresh.guestCount, tableName: fresh.name } : {}) } })
    return updated
  })
  publish({ topic: 'table', action, organizationId: req.user.organizationId, branchId: table.branchId, tableId: table.id })
  res.json(result)
})

floorRouter.get('/covers', requirePermission('can_view_reports'), withReportFormat, async (req: Request, res: Response) => {
  if (req.query.format && req.query.format !== 'json' && !(await getUserPermissions(prisma, req.user.id)).permissions.has('can_export_reports')) throw new AppError('Export permission required', 403, 'FORBIDDEN')
  const branch = await branchFilter(req, String(req.query.branchId ?? ''))
  const { fromDate, toDate } = z.object({ fromDate: z.string().date(), toDate: z.string().date() }).parse(req.query)
  if (fromDate > toDate) throw new AppError('Invalid date range', 400, 'VALIDATION_ERROR')
  const ctx = await formatContextFor(req.user.organizationId)
  const { momentRange } = await import('../utils/reportFormat')
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { name: true } })
  const orders = await prisma.customerOrder.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }), orderType: 'dine_in', status: 'completed', closedAt: momentRange(fromDate, toDate, ctx) }, select: { orderNo: true, guestCount: true, totalAmount: true, branch: { select: { name: true } } } })
  const covers = orders.reduce((n, o) => n + (o.guestCount ?? 0), 0), sales = orders.reduce((n, o) => n + o.totalAmount, 0)
  await sendProReport(res, String(req.query.format ?? 'json'), { key: 'covers', eyebrow: 'DINING', headline: 'Covers and spend per guest', orgName: org.name, currency: ctx.currency, scopeLabel: 'Dine-in orders', periodLabel: `${fromDate} – ${toDate}`, generatedAt: new Date().toISOString(),
    summaryLine: `${orders.filter((o) => !o.guestCount).length} orders have no guest count; spend per guest uses only counted orders.`,
    kpis: [{ label: 'Covers', value: covers, format: 'integer' }, { label: 'Sales', value: sales, format: 'money' }, { label: 'Spend per cover', value: covers ? orders.filter((o) => o.guestCount).reduce((n, o) => n + o.totalAmount, 0) / covers : 0, format: 'money' }],
    sections: [{ type: 'table', id: 'covers', title: 'Dining orders', columns: [{ key: 'orderNo', label: 'Order' }, { key: 'branch', label: 'Branch' }, { key: 'covers', label: 'Guests', format: 'integer' }, { key: 'sales', label: 'Sales', format: 'money' }], rows: orders.map((o) => ({ orderNo: o.orderNo, branch: o.branch.name, covers: o.guestCount ?? 0, sales: o.totalAmount })) }] })
})

// A separate waiter surface reuses authoritative POS pricing without granting
// the cashier's routes or exposing refunds and checkout to the waiter role.
export const waiterRouter = Router()
waiterRouter.use(authenticate, activeAccount, requirePermission('can_take_orders'))
waiterRouter.get('/menu', posMenu)
waiterRouter.post('/orders', async (req: Request, res: Response) => {
  if (req.body?.orderType !== 'dine_in' || req.body?.orderId) throw new AppError('Waiters take table orders only', 400, 'VALIDATION_ERROR')
  if (!req.body?.tableId) throw new AppError('Choose a table', 400, 'VALIDATION_ERROR')
  return sendPosOrder(req, res)
})
waiterRouter.get('/orders/:id', async (req: Request, res: Response) => {
  const order = await findOrder(req)
  if (order.orderType !== 'dine_in') throw new AppError('Table order not found', 404, 'NOT_FOUND')
  res.json(order)
})

async function findOrder(req: Request) {
  const o = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId }, include: orderInclude })
  if (!o) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, o.branchId)
  if (!await prisma.branch.count({ where: { id: o.branchId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Branch is inactive', 409, 'BRANCH_INACTIVE')
  return o
}

export const floorOrdersRouter = Router()
floorOrdersRouter.use(authenticate, activeAccount)
floorOrdersRouter.post('/:id/transfer', cashier, async (req: Request, res: Response) => {
  const { tableId } = z.object({ tableId: z.string().min(1) }).parse(req.body)
  const order = await findOrder(req)
  const table = await prisma.diningTable.findFirst({ where: { id: tableId, organizationId: req.user.organizationId, branchId: order.branchId, isActive: true }, include: { branch: { select: { tableOrderingEnabled: true } } } })
  if (!table) throw new AppError('Destination table not found in this branch', 404, 'NOT_FOUND')
  assertTableService(table.branch)
  const result = await prisma.$transaction(async (tx) => {
    for (const id of [...new Set([order.tableId, tableId].filter((id): id is string => !!id))].sort()) await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${id} FOR UPDATE`
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (fresh.status !== 'open' || fresh.orderType !== 'dine_in' || tableId === fresh.tableId) throw new AppError('Only an open dine-in order can move to another table', 409, 'INVALID_STATUS')
    await assertBillEditable(tx, order.id)
    const dest = await tx.diningTable.findUniqueOrThrow({ where: { id: tableId } })
    if (!dest.isActive || dest.needsClearing || dest.seatedAt || await tx.customerOrder.count({ where: { tableId, status: 'open' } })) throw new AppError('Destination table is occupied or needs clearing', 409, 'TABLE_BUSY')
    const source = fresh.tableId ? await tx.diningTable.findUniqueOrThrow({ where: { id: fresh.tableId } }) : null
    if (source) await tx.diningTable.update({ where: { id: source.id }, data: { seatedAt: null, guestCount: null, needsClearing: false } })
    await tx.diningTable.update({ where: { id: tableId }, data: { seatedAt: source?.seatedAt ?? fresh.createdAt, guestCount: fresh.guestCount } })
    await tx.customerOrder.update({ where: { id: fresh.id }, data: { tableId } })
    await logAudit(tx, { req, action: 'transfer_table', module: 'orders', resourceType: 'customer_order', resourceId: order.id, branchId: order.branchId, newData: { from: fresh.tableId, to: tableId } })
    return tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude })
  })
  publishOrder(order, 'transferred'); publishOrder(result, 'transferred')
  res.json(result)
})

for (const action of ['merge', 'move-items'] as const) floorOrdersRouter.post(`/:id/${action}`, cashier, async (req: Request, res: Response) => {
  const body = z.object({ fromOrderId: z.string().optional(), toOrderId: z.string().optional(), itemIds: z.array(z.string().min(1)).min(1).max(200).optional() }).parse(req.body)
  const first = await findOrder(req)
  const otherId = action === 'merge' ? body.fromOrderId : body.toOrderId
  if (!otherId || otherId === first.id || (action === 'move-items' && !body.itemIds?.length)) throw new AppError('Choose another order and dishes to move', 400, 'VALIDATION_ERROR')
  const second = await prisma.customerOrder.findFirst({ where: { id: otherId, organizationId: req.user.organizationId, branchId: first.branchId } })
  if (!second) throw new AppError('Other order not found in this branch', 404, 'NOT_FOUND')
  const targetId = action === 'merge' ? first.id : second.id, sourceId = action === 'merge' ? second.id : first.id
  const result = await prisma.$transaction(async (tx) => {
    for (const id of [...new Set([first.tableId, second.tableId].filter((id): id is string => !!id))].sort()) await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${id} FOR UPDATE`
    for (const order of [first, second].sort((a, b) => a.id.localeCompare(b.id))) await lockOrder(tx, order)
    const orders = await tx.customerOrder.findMany({ where: { id: { in: [sourceId, targetId] } }, include: { items: true } })
    for (const o of orders) {
      if (o.status !== 'open' || o.orderType !== 'dine_in') throw new AppError('Both orders must be open dine-in orders', 409, 'INVALID_STATUS')
      await assertBillEditable(tx, o.id)
      if (o.discountAmount > 0) throw new AppError('Remove the order discount before moving dishes', 409, 'DISCOUNT_LOCKED')
    }
    const source = orders.find((o) => o.id === sourceId)!, target = orders.find((o) => o.id === targetId)!
    const moving = source.items.filter((i) => i.status !== 'cancelled' && (action === 'merge' || body.itemIds!.includes(i.id)))
    if (!moving.length || (action === 'move-items' && (new Set(body.itemIds).size !== body.itemIds!.length || moving.length !== body.itemIds!.length))) throw new AppError('Choose active dishes from the source order', 400, 'INVALID_ITEMS')
    await tx.customerOrderItem.updateMany({ where: { id: { in: moving.map((i) => i.id) } }, data: { orderId: targetId } })
    const emptied = !source.items.some((i) => i.status !== 'cancelled' && !moving.some((m) => m.id === i.id))
    if (emptied) {
      await tx.customerOrder.update({ where: { id: sourceId }, data: { status: 'cancelled', cancelReason: `Moved to #${target.orderNo}`, closedAt: new Date(), closedBy: req.user.id, billRequestedAt: null } })
      if (source.tableId) await tx.diningTable.update({ where: { id: source.tableId }, data: { seatedAt: null, guestCount: null, needsClearing: false } })
    }
    if (action === 'merge') {
      const covers = (target.guestCount ?? 0) + (source.guestCount ?? 0) || null
      await tx.customerOrder.update({ where: { id: targetId }, data: { guestCount: covers } })
      if (target.tableId) await tx.diningTable.update({ where: { id: target.tableId }, data: { guestCount: covers } })
    }
    for (const id of [sourceId, targetId]) { await recalcOrderTotals(tx, id); await tx.customerOrder.update({ where: { id }, data: { billRequestedAt: null } }) }
    await logAudit(tx, { req, action, module: 'orders', resourceType: 'customer_order', resourceId: targetId, branchId: first.branchId, newData: { sourceId, targetId, itemIds: moving.map((i) => i.id) } })
    return tx.customerOrder.findUniqueOrThrow({ where: { id: targetId }, include: orderInclude })
  })
  publishOrder(first, action); publishOrder({ ...second, orderNo: second.orderNo }, action)
  res.json(result)
})

floorOrdersRouter.post('/:id/checks', cashier, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  const result = await splitOrder(req, order.id, splitSchema.parse(req.body))
  publishOrder(order, 'checks_created'); res.status(201).json(result)
})
floorOrdersRouter.delete('/:id/checks', cashier, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (fresh.status !== 'open' || await tx.orderCheck.count({ where: { orderId: order.id, status: { not: 'unpaid' } } })) throw new AppError('Only an entirely unpaid split can be reset', 409, 'CHECKS_LOCKED')
    await tx.orderCheck.deleteMany({ where: { orderId: order.id } }); await recalcOrderTotals(tx, order.id)
    await logAudit(tx, { req, action: 'reset_checks', module: 'orders', resourceId: order.id, branchId: order.branchId })
  })
  publishOrder(order, 'checks_reset'); res.json({ reset: true })
})
floorOrdersRouter.post('/:id/checks/:checkId/pay', cashier, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  await prisma.$transaction((tx) => payCheck(tx, req, order.id, req.params.checkId, payCheckSchema.parse(req.body)))
  await cancelOpenIntents(order.id, 'Paid at the till', req.params.checkId)
  const zatca = await issueForOrder(order.id, 'invoice', undefined, req.params.checkId).catch((e) => { console.error('[zatca] check invoice not issued', req.params.checkId, e); return null })
  publishOrder(order, 'check_paid'); publish({ topic: 'sale', action: 'updated', organizationId: order.organizationId, branchId: order.branchId })
  res.json({ ...(await findOrder(req)), checkInvoicePending: !zatca && (await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })).zatcaEnabled })
})
floorOrdersRouter.post('/:id/checks/refund', cashier, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  const { reason, approvalToken } = z.object({ reason: z.string().trim().min(3).max(500), approvalToken: z.string().optional() }).parse(req.body)
  await prisma.$transaction((tx) => refundChecks(tx, req, order.id, reason, approvalToken))
  await issueForOrder(order.id, 'credit', reason).catch((e) => console.error('[zatca] split credits not issued', order.id, e))
  await refundIntentsForOrder(order.id).catch((e) => console.error('[payments] refund not sent', order.id, e))
  publishOrder(order, 'checks_refunded'); publish({ topic: 'sale', action: 'updated', organizationId: order.organizationId, branchId: order.branchId })
  res.json(await findOrder(req))
})
floorOrdersRouter.post('/:id/prebill', requireAnyPermission('can_manage_orders', 'can_take_orders'), async (req: Request, res: Response) => {
  const order = await findOrder(req)
  // a waiter (no cashier permission) prints table bills only
  if (order.orderType !== 'dine_in' && !(await getUserPermissions(prisma, req.user.id)).permissions.has('can_manage_orders')) throw new AppError('Table order not found', 404, 'NOT_FOUND')
  const result = await prisma.$transaction(async (tx) => {
    await lockOrder(tx, order)
    const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    if (fresh.status !== 'open') throw new AppError('Pre-bills are for open orders', 409, 'INVALID_STATUS')
    const updated = await tx.customerOrder.update({ where: { id: order.id }, data: { prebillPrints: { increment: 1 }, billRequestedAt: new Date() }, include: orderInclude })
    await logAudit(tx, { req, action: 'prebill', module: 'orders', resourceId: order.id, branchId: order.branchId, newData: { copy: updated.prebillPrints } })
    return updated
  })
  publishOrder(order, 'bill_requested'); res.json(result)
})
floorOrdersRouter.post('/:id/checks/:checkId/receipt', cashier, async (req: Request, res: Response) => {
  const order = await findOrder(req)
  const check = await prisma.orderCheck.findFirst({ where: { id: req.params.checkId, orderId: order.id, status: { in: ['paid', 'refunded'] } } })
  if (!check) throw new AppError('Paid check not found', 404, 'NOT_FOUND')
  const result = await prisma.orderCheck.update({ where: { id: check.id }, data: { receiptPrints: { increment: 1 } } })
  await logAudit(prisma, { req, action: 'check_receipt', module: 'orders', resourceId: check.id, branchId: order.branchId, newData: { copy: result.receiptPrints } })
  res.json({ copy: result.receiptPrints })
})
