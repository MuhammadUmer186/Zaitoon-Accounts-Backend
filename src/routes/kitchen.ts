import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission, requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { ensureShifts, currentShift } from '../utils/menu'
import { dishImageUrl } from './menu'
import { orderInclude, publishOrder, lockOrder } from './orders'
import { publish } from '../utils/liveEvents'
import crypto from 'node:crypto'
import { readKitchenPrinters, automaticKitchenStations } from '../services/kitchenPrinting'
import { readCloudKitchenPrinters } from '../services/cloudKitchenPrinting'

const router = Router()

router.use(authenticate)

const canKitchen = requirePermission('can_manage_kitchen')
const canBoard = requireAnyPermission('can_manage_kitchen', 'can_manage_orders')
const canRoute = requirePermission('can_manage_menu')

const KITCHEN_FLOW: Record<string, string> = { pending: 'preparing', preparing: 'ready', ready: 'served' }

// Non-sensitive capability lookup for POS/waiter clients. No jobs or keys.
router.get('/print-routing', async (req: Request, res: Response) => {
  const branchId = z.string().min(1).parse(req.query.branchId)
  await assertBranchAccess(req, branchId)
  if (!await prisma.branch.count({ where: { id: branchId, organizationId: req.user.organizationId } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  res.json({ stationIds: await automaticKitchenStations(req.user.organizationId, branchId) })
})

router.get('/printers', canBoard, async (req: Request, res: Response) => {
  const branch = await branchFilter(req, String(req.query.branchId ?? '') || undefined)
  const managed = await prisma.networkKitchenPrinter.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }, select: { id: true, stationId: true, branchId: true, enabled: true } })
  await prisma.kitchenPrintJob.updateMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }), state: 'sending', updatedAt: { lt: new Date(Date.now() - 60000) } }, data: { state: 'uncertain', lastError: 'Print connection interrupted; check paper output before reviewing this job' } })
  const jobs = await prisma.kitchenPrintJob.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }, orderBy: { sequence: 'desc' }, take: 100, select: { id: true, sequence: true, branchId: true, printerId: true, orderId: true, kind: true, state: true, attempts: true, lastError: true, createdAt: true } })
  const scope = { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }
  const held = await prisma.kitchenPrintJob.findMany({ where: { ...scope, state: { in: ['uncertain', 'blocked'] } }, take: 20, orderBy: { sequence: 'asc' }, select: { id: true, printerId: true, state: true, lastError: true } })
  const queued = await prisma.kitchenPrintJob.count({ where: { ...scope, state: 'queued' } })
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  let configured: { id: string; stationId: string; branchId: string }[] = []
  let configurationError = false
  try { configured = readKitchenPrinters().filter(p => p.organizationId === req.user.organizationId && p.branchId === runtime?.branchId && (!branch || (typeof branch === 'string' ? p.branchId === branch : branch.in.includes(p.branchId)))).map(p => ({ id: p.id, stationId: p.stationId, branchId: p.branchId })) } catch { configurationError = true }
  if (!runtime && process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') {
    try { configured = readCloudKitchenPrinters().filter(p => p.organizationId === req.user.organizationId && (!branch || (typeof branch === 'string' ? p.branchId === branch : branch.in.includes(p.branchId)))).map(p => ({ id: p.id, stationId: p.stationId, branchId: p.branchId })) } catch { configurationError = true }
  }
  configured = configured.filter(p => !managed.some(m => m.branchId === p.branchId && m.stationId === p.stationId))
  configured.push(...managed.filter(p => p.enabled).map(p => ({ id: p.id, stationId: p.stationId, branchId: p.branchId })))
  if (configured.length) {
    const stations = await prisma.kitchenStation.findMany({ where: { organizationId: req.user.organizationId, id: { in: configured.map(p => p.stationId).filter(id => id !== 'none') }, isActive: true }, select: { id: true } })
    if (configured.some(p => !['none', 'cashier'].includes(p.stationId) && !stations.some(s => s.id === p.stationId))) configurationError = true
  }
  res.json({ configured, configurationError, held, queued, jobs: jobs.map(j => ({ ...j, sequence: j.sequence.toString() })) })
})

router.post('/printers/jobs/:id/resolve', requirePermission('can_manage_settings'), async (req: Request, res: Response) => {
  const body = z.object({ decision: z.enum(['confirm_delivered', 'retry', 'discard']), reason: z.string().trim().min(20).max(500), checkedPrinter: z.literal(true) }).strict().parse(req.body)
  const found = await prisma.kitchenPrintJob.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!found) throw new AppError('Print job not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, found.branchId)
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "KitchenPrintJob" WHERE id = ${found.id} FOR UPDATE`
    const job = await tx.kitchenPrintJob.findUniqueOrThrow({ where: { id: found.id } })
    if (!['uncertain', 'blocked'].includes(job.state)) throw new AppError('Only held jobs can be resolved', 409, 'INVALID_STATUS')
    if (body.decision === 'retry' && !job.payload) throw new AppError('This ticket needs a supported text renderer before retrying', 409, 'PRINT_RENDER_BLOCKED')
    const state = body.decision === 'confirm_delivered' ? 'usb_complete' : body.decision === 'retry' ? 'superseded' : 'discarded'
    await tx.kitchenPrintJob.update({ where: { id: job.id }, data: { state, lastError: body.reason } })
    let replacementId: string | null = null
    if (body.decision === 'retry') {
      const { id, sequence, createdAt, updatedAt, ...copy } = job
      void id; void sequence; void createdAt; void updatedAt
      replacementId = (await tx.kitchenPrintJob.create({ data: { ...copy, itemIds: copy.itemIds!, eventKey: crypto.randomUUID(), state: 'queued', attempts: 0, lastError: 'Explicit operator retry after physical check' } })).id
    }
    await logAudit(tx, { req, branchId: job.branchId, action: 'resolve', module: 'kitchen', resourceType: 'kitchen_print_job', resourceId: job.id, oldData: { state: job.state }, newData: { ...body, replacementId } })
    return { state, replacementId }
  })
  res.json(result)
})

// GET /kitchen/orders?branchId=&stationId= â€” open orders that still have
// something for the kitchen (held courses don't count until fired). With a
// station, only orders with work for that station.
router.get('/orders', canBoard, async (req: Request, res: Response) => {
  const { branchId, stationId } = req.query as Record<string, string>
  const branch = await branchFilter(req, branchId)
  const orders = await prisma.customerOrder.findMany({
    where: {
      organizationId: req.user.organizationId,
      // paid takeaway orders stay on the board until their dishes are done
      status: 'completed',
      ...(branch && { branchId: branch }),
      items: { some: { status: { in: ['pending', 'preparing', 'ready'] }, held: false, ...(stationId && { stationId: stationId === 'none' ? null : stationId }) } },
    },
    include: orderInclude,
    orderBy: [{ closedAt: 'asc' }, { createdAt: 'asc' }],
  })
  // each ticket's target time: the slowest dish on it
  const dishIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.dishId)))]
  const prep = new Map((await prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, prepMinutes: true } })).map((d) => [d.id, d.prepMinutes]))
  res.json({
    data: orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i, prepMinutes: prep.get(i.dishId) ?? null })) })),
    serverTime: new Date().toISOString(),
  })
})

// â”€â”€ Stations and routing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const stationSchema = z.object({
  name: z.string().trim().min(1).max(40),
  printerName: z.string().trim().max(120).optional().nullable(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional(),
})

async function assertUniqueStation(organizationId: string, name: string, exceptId?: string) {
  const clash = await prisma.kitchenStation.findFirst({ where: { organizationId, name: { equals: name, mode: 'insensitive' }, ...(exceptId && { id: { not: exceptId } }) } })
  if (clash) throw new AppError('A station with that name exists', 409, 'DUPLICATE')
}

router.get('/stations', canBoard, async (req: Request, res: Response) => {
  res.json({ data: await prisma.kitchenStation.findMany({ where: { organizationId: req.user.organizationId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }) })
})

router.post('/stations', canRoute, async (req: Request, res: Response) => {
  const body = stationSchema.parse(req.body)
  await assertUniqueStation(req.user.organizationId, body.name)
  const station = await prisma.kitchenStation.create({ data: { ...body, printerName: body.printerName || null, organizationId: req.user.organizationId } })
  await logAudit(prisma, { req, action: 'create', module: 'menu', resourceType: 'kitchen_station', resourceId: station.id, resourceRef: station.name, newData: body })
  res.status(201).json(station)
})

router.put('/stations/:id', canRoute, async (req: Request, res: Response) => {
  const existing = await prisma.kitchenStation.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!existing) throw new AppError('Station not found', 404, 'NOT_FOUND')
  const body = updateSchema(stationSchema).parse(req.body)
  if (body.name) await assertUniqueStation(req.user.organizationId, body.name, existing.id)
  const station = await prisma.kitchenStation.update({ where: { id: existing.id }, data: { ...body, ...(body.printerName !== undefined && { printerName: body.printerName || null }) } })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'kitchen_station', resourceId: station.id, resourceRef: station.name, newData: body })
  res.json(station)
})

// deleting a station sends its categories and dishes back to "no station"
router.delete('/stations/:id', canRoute, async (req: Request, res: Response) => {
  const existing = await prisma.kitchenStation.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!existing) throw new AppError('Station not found', 404, 'NOT_FOUND')
  await prisma.$transaction(async (tx) => {
    await tx.menuCategory.updateMany({ where: { organizationId: existing.organizationId, stationId: existing.id }, data: { stationId: null } })
    await tx.dish.updateMany({ where: { organizationId: existing.organizationId, stationId: existing.id }, data: { stationId: null } })
    await tx.kitchenStation.delete({ where: { id: existing.id } })
  })
  await logAudit(prisma, { req, action: 'delete', module: 'menu', resourceType: 'kitchen_station', resourceId: existing.id, resourceRef: existing.name })
  res.json({ deleted: true })
})

// GET /kitchen/routing â€” stations, categories and dishes with their routing
router.get('/routing', canRoute, async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const [stations, categories, dishes] = await Promise.all([
    prisma.kitchenStation.findMany({ where: { organizationId: orgId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.menuCategory.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, stationId: true, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.dish.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, categoryId: true, stationId: true, prepMinutes: true, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
  ])
  res.json({ stations, categories, dishes })
})

// PUT /kitchen/routing â€” categories â†’ station; dish override and prep time
router.put('/routing', canRoute, async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const body = z.object({
    categories: z.array(z.object({ id: z.string(), stationId: z.string().nullable() })).max(500).default([]),
    dishes: z.array(z.object({ id: z.string(), stationId: z.string().nullable(), prepMinutes: z.number().int().min(1).max(240).nullable() })).max(5000).default([]),
  }).parse(req.body)
  const stationIds = new Set((await prisma.kitchenStation.findMany({ where: { organizationId: orgId }, select: { id: true } })).map((s) => s.id))
  for (const x of [...body.categories, ...body.dishes]) if (x.stationId && !stationIds.has(x.stationId)) throw new AppError('Unknown kitchen station', 400, 'VALIDATION_ERROR')
  const catIds = new Set((await prisma.menuCategory.findMany({ where: { organizationId: orgId, id: { in: body.categories.map((c) => c.id) } }, select: { id: true } })).map((c) => c.id))
  const dishIds = new Set((await prisma.dish.findMany({ where: { organizationId: orgId, id: { in: body.dishes.map((d) => d.id) } }, select: { id: true } })).map((d) => d.id))
  if (catIds.size !== body.categories.length || dishIds.size !== body.dishes.length) throw new AppError('Unknown category or dish', 400, 'VALIDATION_ERROR')
  await prisma.$transaction(async (tx) => {
    for (const c of body.categories) await tx.menuCategory.update({ where: { id: c.id }, data: { stationId: c.stationId } })
    for (const d of body.dishes) await tx.dish.update({ where: { id: d.id }, data: { stationId: d.stationId, prepMinutes: d.prepMinutes } })
  })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'kitchen_routing', resourceRef: 'Kitchen routing', newData: { categories: body.categories.length, dishes: body.dishes.length } })
  res.json({ saved: true })
})

// â”€â”€ Customer "order ready" screen â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// GET /kitchen/ready-display?branchId= â€” the screen's secret link (if made)
router.get('/ready-display', canBoard, async (req: Request, res: Response) => {
  const branchId = String(req.query.branchId || '')
  await assertBranchAccess(req, branchId)
  const branch = await prisma.branch.findFirst({ where: { id: branchId, organizationId: req.user.organizationId }, select: { readyDisplayToken: true } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  res.json({ token: branch.readyDisplayToken })
})

// POST /kitchen/ready-display { branchId } â€” create or replace the link
// (replacing it disconnects screens using the old one)
router.post('/ready-display', canRoute, async (req: Request, res: Response) => {
  const { branchId } = z.object({ branchId: z.string().min(1) }).parse(req.body)
  await assertBranchAccess(req, branchId)
  const branch = await prisma.branch.findFirst({ where: { id: branchId, organizationId: req.user.organizationId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  const updated = await prisma.branch.update({ where: { id: branch.id }, data: { readyDisplayToken: crypto.randomBytes(18).toString('base64url') } })
  await logAudit(prisma, { req, action: 'update', module: 'menu', resourceType: 'ready_display', resourceId: branch.id, resourceRef: branch.name, branchId: branch.id })
  res.json({ token: updated.readyDisplayToken })
})

// POST /kitchen/orders/:id/advance â€” move every item in one status to the next
// ("Start all new", "All ready", "All served")
router.post('/orders/:id/advance', canBoard, async (req: Request, res: Response) => {
  const { from, stationId } = z.object({ from: z.enum(['pending', 'preparing', 'ready']), stationId: z.string().optional() }).parse(req.body)
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  if (order.status === 'pending') throw new AppError('Accept this online order first', 400, 'NOT_ACCEPTED')
  if (order.status !== 'completed') throw new AppError('Full payment is required before sending an order to the kitchen', 409, 'PAYMENT_REQUIRED')

  // a station bumps only its own lines; held courses are never bumped
  const result = await prisma.$transaction(async tx => {
    await lockOrder(tx, order)
    const where = { orderId: order.id, order: { status: 'completed' }, status: from, held: false, ...(stationId && { stationId: stationId === 'none' ? null : stationId }) }
    const next = KITCHEN_FLOW[from], now = new Date()
    // Keep the original measurement when a line is recalled and bumped again.
    if (next === 'preparing') await tx.customerOrderItem.updateMany({ where: { ...where, preparingAt: null }, data: { preparingAt: now } })
    if (next === 'ready') await tx.customerOrderItem.updateMany({ where: { ...where, readyAt: null }, data: { readyAt: now } })
    if (next === 'served') await tx.customerOrderItem.updateMany({ where: { ...where, servedAt: null }, data: { servedAt: now } })
    return tx.customerOrderItem.updateMany({ where, data: { status: next, ...(next === 'ready' && { servedAt: null }) } })
  })
  if (result.count > 0) publishOrder(order, 'item_status')
  res.json({ updated: result.count })
})

// POST /kitchen/orders/:id/recall â€” bring back dishes bumped as served in the
// last 30 minutes (a mistaken "All served")
router.post('/orders/:id/recall', canBoard, async (req: Request, res: Response) => {
  const { stationId } = z.object({ stationId: z.string().optional() }).parse(req.body ?? {})
  const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!order) throw new AppError('Order not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, order.branchId)
  if (order.status !== 'completed') throw new AppError('Full payment is required before sending an order to the kitchen', 409, 'PAYMENT_REQUIRED')
  const result = await prisma.customerOrderItem.updateMany({
    where: { orderId: order.id, order: { status: 'completed' }, status: 'served', updatedAt: { gte: new Date(Date.now() - 30 * 60_000) }, ...(stationId && { stationId: stationId === 'none' ? null : stationId }) },
    data: { status: 'ready', servedAt: null },
  })
  if (result.count === 0) throw new AppError('Nothing was served in the last 30 minutes', 409, 'NOTHING_TO_RECALL')
  publishOrder(order, 'item_status')
  res.json({ recalled: result.count })
})

// GET /kitchen/availability?branchId= â€” every active dish with its stock switch for that branch
router.get('/availability', canKitchen, async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  if (!branchId) throw new AppError('Select a branch', 400, 'VALIDATION_ERROR')
  await assertBranchAccess(req, branchId)

  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const shifts = await ensureShifts(prisma, org.id)
  const [dishes, outOfStock] = await Promise.all([
    prisma.dish.findMany({
      where: { organizationId: org.id, isActive: true },
      include: {
        category: { select: { id: true, name: true, sortOrder: true } },
        shifts: { select: { shiftId: true } },
      },
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.dishOutOfStock.findMany({ where: { branchId } }),
  ])
  const off = new Map(outOfStock.map((o) => [o.dishId, o]))
  res.json({
    currentShift: currentShift(shifts, org.timezone),
    shifts: shifts.map((s) => ({ id: s.id, name: s.name })),
    data: dishes.map((d) => ({
      id: d.id,
      name: d.name,
      price: d.price,
      imageUrl: dishImageUrl(d),
      category: d.category,
      shiftIds: d.shifts.map((s) => s.shiftId),
      available: !off.has(d.id),
      outOfStockSince: off.get(d.id)?.createdAt ?? null,
    })),
  })
})

// PUT /kitchen/availability â€” { branchId, dishId, available }
router.put('/availability', canKitchen, async (req: Request, res: Response) => {
  const body = z.object({ branchId: z.string().min(1), dishId: z.string().min(1), available: z.boolean() }).parse(req.body)
  await assertBranchAccess(req, body.branchId)
  const [dish, branch] = await Promise.all([
    prisma.dish.findFirst({ where: { id: body.dishId, organizationId: req.user.organizationId } }),
    prisma.branch.findFirst({ where: { id: body.branchId, organizationId: req.user.organizationId } }),
  ])
  if (!dish || !branch) throw new AppError('Dish or branch not found', 404, 'NOT_FOUND')

  if (body.available) {
    await prisma.dishOutOfStock.deleteMany({ where: { branchId: branch.id, dishId: dish.id } })
  } else {
    await prisma.dishOutOfStock.upsert({
      where: { branchId_dishId: { branchId: branch.id, dishId: dish.id } },
      update: {},
      create: { organizationId: req.user.organizationId, branchId: branch.id, dishId: dish.id, markedBy: req.user.id },
    })
  }
  await logAudit(prisma, {
    req, action: body.available ? 'back_in_stock' : 'out_of_stock', module: 'kitchen',
    resourceType: 'dish', resourceId: dish.id, resourceRef: dish.name, branchId: branch.id,
  })
  publish({ topic: 'availability', action: body.available ? 'in_stock' : 'out_of_stock', organizationId: req.user.organizationId, branchId: branch.id })
  res.json({ dishId: dish.id, branchId: branch.id, available: body.available })
})

export default router
