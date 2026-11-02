import { updateSchema } from '../utils/updateSchema'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission, requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { newTableToken } from '../utils/menu'
import { publish } from '../utils/liveEvents'
import { tableStatus } from '../utils/tableStatus'

const router = Router()

router.use(authenticate)

const canView = requireAnyPermission('can_manage_menu', 'can_manage_kitchen', 'can_manage_orders', 'can_view_reviews', 'can_take_orders')
const canManage = requirePermission('can_manage_menu')

// Table added / edited / disabled / new QR code → refresh open screens
router.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.on('finish', () => {
      if (res.statusCode < 400) {
        publish({ topic: 'table', action: 'changed', organizationId: req.user.organizationId, tableId: req.params.id ?? null })
      }
    })
  }
  next()
})

const tableSchema = z.object({
  branchId: z.string().min(1, 'Branch is required'),
  name: z.string().trim().min(1, 'Table name is required').max(40),
  seats: z.number().int().positive().max(100).optional().nullable(),
  isActive: z.boolean().optional(),
})

async function findTable(req: Request) {
  const table = await prisma.diningTable.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!table) throw new AppError('Table not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, table.branchId)
  return table
}

// GET /tables
router.get('/', canView, async (req: Request, res: Response) => {
  const { branchId } = req.query as Record<string, string>
  const branch = await branchFilter(req, branchId)
  const tables = await prisma.diningTable.findMany({
    where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) },
    include: {
      branch: { select: { id: true, name: true, code: true, tableOrderingEnabled: true } },
      orders: { where: { status: 'open' }, select: { id: true, orderNo: true, totalAmount: true, createdAt: true, billRequestedAt: true } },
    },
  })
  // Natural sort so "T2" comes before "T10"
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
  tables.sort((a, b) => collator.compare(a.branch.name, b.branch.name) || collator.compare(a.name, b.name))
  res.json({
    data: tables.map(({ orders, ...t }) => ({ ...t, openOrder: orders[0] ?? null, floorStatus: tableStatus(t, orders[0] ?? null) })),
  })
})

// POST /tables
router.post('/', canManage, async (req: Request, res: Response) => {
  const body = tableSchema.parse(req.body)
  await assertBranchAccess(req, body.branchId)
  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: req.user.organizationId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const table = await prisma.diningTable.create({
    data: {
      ...body,
      organizationId: req.user.organizationId,
      orderToken: newTableToken(),
      reviewToken: newTableToken(),
    },
  })
  await logAudit(prisma, { req, action: 'create', module: 'menu', resourceType: 'dining_table', resourceId: table.id, resourceRef: table.name, branchId: table.branchId })
  res.status(201).json(table)
})

// POST /tables/bulk — quickly register T1..Tn for a branch
router.post('/bulk', canManage, async (req: Request, res: Response) => {
  const body = z.object({
    branchId: z.string().min(1),
    prefix: z.string().trim().max(20).default('T'),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
    seats: z.number().int().positive().max(100).optional().nullable(),
  }).parse(req.body)
  if (body.to < body.from || body.to - body.from >= 200) {
    throw new AppError('Choose a range of up to 200 tables', 400, 'VALIDATION_ERROR')
  }
  await assertBranchAccess(req, body.branchId)
  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: req.user.organizationId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const names = Array.from({ length: body.to - body.from + 1 }, (_, i) => `${body.prefix}${body.from + i}`)
  const result = await prisma.diningTable.createMany({
    data: names.map((name) => ({
      organizationId: req.user.organizationId,
      branchId: body.branchId,
      name,
      seats: body.seats ?? null,
      orderToken: newTableToken(),
      reviewToken: newTableToken(),
    })),
    skipDuplicates: true,
  })
  res.status(201).json({ created: result.count, skipped: names.length - result.count })
})

// PUT /tables/:id
router.put('/:id', canManage, async (req: Request, res: Response) => {
  const table = await findTable(req)
  const body = updateSchema(tableSchema).parse(req.body)
  const moving = !!body.branchId && body.branchId !== table.branchId
  if (moving) await assertBranchAccess(req, body.branchId)
  // the same table lock as POS/QR/waiter intake, so no order can start while
  // the table is being moved to another branch or taken out of service
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${table.id} FOR UPDATE`
    const open = await tx.customerOrder.count({ where: { tableId: table.id, status: 'open' } })
    if (open > 0 && moving) throw new AppError('Close the open order on this table before moving it to another branch', 400, 'TABLE_BUSY')
    if (open > 0 && body.isActive === false) throw new AppError('Close the open order on this table before deactivating it', 400, 'TABLE_BUSY')
    // another branch: no seating, guests or position carry over from the old room
    return tx.diningTable.update({ where: { id: table.id }, data: { ...body, ...(moving && { seatedAt: null, guestCount: null, needsClearing: false, section: 'Main', x: 5, y: 5 }) } })
  })
  res.json(updated)
})

// POST /tables/:id/regenerate — issue new QR codes (the old printed codes stop working)
router.post('/:id/regenerate', canManage, async (req: Request, res: Response) => {
  const table = await findTable(req)
  const { which } = z.object({ which: z.enum(['order', 'review', 'both']).default('both') }).parse(req.body ?? {})
  const updated = await prisma.diningTable.update({
    where: { id: table.id },
    data: {
      ...(which !== 'review' && { orderToken: newTableToken() }),
      ...(which !== 'order' && { reviewToken: newTableToken() }),
    },
  })
  await logAudit(prisma, { req, action: 'regenerate_qr', module: 'menu', resourceType: 'dining_table', resourceId: table.id, resourceRef: table.name, branchId: table.branchId, newData: { which } })
  res.json(updated)
})

// DELETE /tables/:id — tables with order history are deactivated instead
router.delete('/:id', canManage, async (req: Request, res: Response) => {
  const table = await findTable(req)
  const orders = await prisma.customerOrder.count({ where: { tableId: table.id } })
  if (await prisma.customerOrder.count({ where: { tableId: table.id, status: 'open' } })) throw new AppError('Close the open order on this table before removing it', 400, 'TABLE_BUSY')
  if (orders > 0) {
    await prisma.diningTable.update({ where: { id: table.id }, data: { isActive: false } })
    res.json({ archived: true, message: 'This table has order history, so it was deactivated instead of deleted' })
    return
  }
  await prisma.diningTable.delete({ where: { id: table.id } })
  await logAudit(prisma, { req, action: 'delete', module: 'menu', resourceType: 'dining_table', resourceId: table.id, resourceRef: table.name, branchId: table.branchId })
  res.json({ archived: false, message: 'Table deleted' })
})

export default router
