import { Router, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { ensureShifts, currentShift, nextOrderNo, recalcOrderTotals } from '../utils/menu'
import { dishImageUrl } from './menu'
import { lineSelectionSchema, priceLines, loadDishOptions, menuOptionsPayload, resolveStations } from '../services/menuOptions'
import { orderInclude, publishOrder, lockOrder, assertBillEditable } from './orders'
import { assertTableService } from '../utils/tableService'
import { makeReviewCode } from '../utils/reviewCode'
import { deliveryQuote } from '../services/deliveryPricing'
import { linkCustomer } from '../services/customers'
import { branchUnavailable } from '../services/branchMenu'

// Point of sale: the cashier takes dine-in (table), takeaway and delivery
// (e.g. phone) orders at the counter. Orders go to the same kitchen board and order list as QR orders,
// and are paid through POST /orders/:id/complete like any other order.
const router = Router()

router.use(authenticate)
router.use(requireAnyPermission('can_use_pos', 'can_manage_orders'))

// GET /pos/menu?branchId= — every active dish, flagged with this branch's
// stock switch and whether it belongs to the shift running now
export async function posMenu(req: Request, res: Response) {
  const { branchId } = req.query as Record<string, string>
  if (!branchId) throw new AppError('Select a branch', 400, 'VALIDATION_ERROR')
  await assertBranchAccess(req, branchId)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
  const shifts = await ensureShifts(prisma, org.id)
  const shift = currentShift(shifts, org.timezone)
  const { menu, off } = await branchUnavailable(prisma, org.id, branchId)

  const [categories, outOfStock] = await Promise.all([
    prisma.menuCategory.findMany({
      where: { organizationId: org.id, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        dishes: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: { shifts: { select: { shiftId: true } } },
        },
      },
    }),
    prisma.dishOutOfStock.findMany({ where: { branchId }, select: { dishId: true } }),
  ])
  for (const c of categories) c.dishes = c.dishes.filter(d => menu.get(d.id)?.isActive)
  for (const o of outOfStock) off.add(o.dishId)
  const options = await loadDishOptions(prisma, categories.flatMap((c) => c.dishes.map((d) => d.id)), branchId)
  const stationIds = await resolveStations(prisma, org.id, categories.flatMap((c) => c.dishes.map((d) => d.id)))
  const stations = new Map((await prisma.kitchenStation.findMany({ where: { organizationId: org.id, isActive: true }, select: { id: true, name: true, printerName: true } })).map((x) => [x.id, x]))

  res.json({
    deliveryZones: await prisma.deliveryZone.findMany({ where: { organizationId: org.id, branchId, isActive: true }, orderBy: { name: 'asc' } }),
    currency: org.currency,
    currentShift: shift && { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime },
    categories: categories
      .filter((c) => c.dishes.length > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        dishes: c.dishes.map((d) => ({
          id: d.id,
          name: d.name,
          price: menu.get(d.id)!.price,
          imageUrl: dishImageUrl(d),
          available: !off.has(d.id),
          inCurrentShift: !!shift && d.shifts.some((s) => s.shiftId === shift.id),
          ...menuOptionsPayload(options.get(d.id), off),
          station: stations.get(stationIds.get(d.id) ?? '') ?? null,
        })),
      })),
  })
}
router.get('/menu', posMenu)
router.get('/counters', async (req: Request, res: Response) => {
  const branchId = z.string().min(1).parse(req.query.branchId)
  await assertBranchAccess(req, branchId)
  const devices = await prisma.zatcaDevice.findMany({ where: { branchId, organizationId: req.user.organizationId }, select: { counterCode: true, status: true }, orderBy: { counterCode: 'asc' } })
  res.json({ data: devices.length ? devices : [{ counterCode: 'main', status: 'unregistered' }] })
})

const posOrderSchema = z.object({
  branchId: z.string().min(1),
  orderType: z.enum(['dine_in', 'takeaway', 'delivery']),
  tableId: z.string().optional().nullable(),
  guestCount: z.number().int().min(1).max(100).optional(),
  // add to an existing open order (e.g. a takeaway customer adds a drink)
  orderId: z.string().optional().nullable(),
  customerName: z.string().trim().max(60).optional().nullable(),
  customerPhone: z.string().trim().max(30).optional().nullable(),
  deliveryAddress: z.string().trim().max(300).optional().nullable(),
  deliveryZoneId: z.string().min(1).optional().nullable(),
  deliveryArea: z.string().trim().max(80).optional().nullable(),
  items: z.array(z.object({
    dishId: z.string().min(1),
    quantity: z.number().int().min(1).max(99),
    notes: z.string().trim().max(200).optional().nullable(),
    ...lineSelectionSchema, // size, modifiers, combo choices
    course: z.number().int().min(1).max(5).default(1),
  })).min(1, 'Add at least one dish').max(100),
  // later courses wait (held) until the cashier fires them; false sends everything now
  holdLaterCourses: z.boolean().default(true),
}).refine((body) => body.orderType !== 'delivery' || !!body.orderId || (body.deliveryAddress ?? '').length >= 5, { message: 'Enter the full delivery address', path: ['deliveryAddress'] })

// POST /pos/orders — send a ticket to the kitchen. Dine-in tickets join the
// table's running order (the same one guests add to from the table QR).
export async function sendPosOrder(req: Request, res: Response) {
  const body = posOrderSchema.parse(req.body)
  await assertBranchAccess(req, body.branchId)
  const orgId = req.user.organizationId
  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: orgId } })
  if (!branch || !branch.isActive) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const [priced, org] = await Promise.all([
    priceLines(prisma, { organizationId: orgId, branchId: branch.id, items: body.items }),
    prisma.organization.findUniqueOrThrow({ where: { id: orgId } }),
  ])
  if (priced.unavailable.length) {
    const names = (await prisma.dish.findMany({ where: { id: { in: priced.unavailable } }, select: { name: true } })).map((d) => d.name)
    res.status(409).json({ message: `${names.join(', ') || 'A dish'} ${names.length === 1 ? 'is' : 'are'} not available — remove from the ticket`, code: 'DISH_UNAVAILABLE', unavailableDishIds: priced.unavailable })
    return
  }
  const shift = currentShift(await ensureShifts(prisma, orgId), org.timezone)
  // the first course on this send goes now; later courses are held
  const firstCourse = Math.min(...body.items.map((i) => i.course))
  const lines = priced.lines.map((l, n) => {
    const course = body.items[n].course
    return { ...l, course, held: body.holdLaterCourses && course > firstCourse }
  })

  let table: { id: string; name: string } | null = null
  // with table service off a dine-in order has no table
  if (body.orderType === 'dine_in' && !body.orderId && body.tableId) assertTableService(branch)
  if (body.orderType === 'dine_in' && !body.orderId && branch.tableOrderingEnabled) {
    if (!body.tableId) throw new AppError('Choose a table for a dine-in order', 400, 'VALIDATION_ERROR')
    table = await prisma.diningTable.findFirst({ where: { id: body.tableId, branchId: branch.id, isActive: true }, select: { id: true, name: true } })
    if (!table) throw new AppError('Table not found in this branch', 404, 'NOT_FOUND')
  }

  for (let attempt = 0; ; attempt++) {
    try {
      let isNew = false
      const order = await prisma.$transaction(async (tx) => {
        let target: { id: string; tableId: string | null } | null = null
        if (body.orderId) {
          const existing = await tx.customerOrder.findFirst({ where: { id: body.orderId, organizationId: orgId, branchId: branch.id } })
          if (!existing) throw new AppError('Order not found', 404, 'NOT_FOUND')
          await lockOrder(tx, existing)
          const fresh = await tx.customerOrder.findUniqueOrThrow({ where: { id: existing.id } })
          if (fresh.status !== 'open') throw new AppError(`Order #${fresh.orderNo} is already closed`, 400, 'INVALID_STATUS')
          await assertBillEditable(tx, fresh.id)
          if (['picked_up', 'delivered'].includes(fresh.deliveryStatus ?? '')) throw new AppError('A dispatched delivery cannot have its bill changed', 409, 'DELIVERY_LOCKED')
          target = fresh
        } else if (table) {
          await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${table.id} FOR UPDATE`
          const freshTable = await tx.diningTable.findUniqueOrThrow({ where: { id: table.id } })
          if (!freshTable.isActive || freshTable.needsClearing) throw new AppError('Clear this table before taking a new order', 409, 'TABLE_NEEDS_CLEARING')
          target = await tx.customerOrder.findFirst({ where: { tableId: table.id, status: 'open' } })
          if (target) await assertBillEditable(tx, target.id)
          await tx.diningTable.update({ where: { id: table.id }, data: { seatedAt: freshTable.seatedAt ?? new Date(), ...(body.guestCount && { guestCount: body.guestCount }) } })
        }
        if (!target) {
          isNew = true
          const delivery = await deliveryQuote(tx, orgId, branch, body.orderType, body.deliveryZoneId, body.deliveryArea)
          target = await tx.customerOrder.create({
            data: {
              organizationId: orgId,
              branchId: branch.id,
              tableId: table?.id ?? null,
              guestCount: table ? body.guestCount ?? (await tx.diningTable.findUniqueOrThrow({ where: { id: table.id } })).guestCount : null,
              orderType: body.orderType,
              source: 'pos',
              ...delivery,
              shiftId: shift?.id ?? null,
              orderNo: await nextOrderNo(tx, orgId, branch.id),
              customerName: body.customerName || null,
              customerPhone: body.customerPhone || null,
              customerId: await linkCustomer(tx, orgId, body.customerPhone, body.customerName),
              deliveryAddress: body.orderType === 'delivery' ? body.deliveryAddress || null : null,
              createdBy: req.user.id,
            },
          })
        } else if (body.customerName || body.customerPhone || body.guestCount) {
          await tx.customerOrder.update({
            where: { id: target.id },
            data: { ...(body.customerName && { customerName: body.customerName }), ...(body.customerPhone && { customerPhone: body.customerPhone, customerId: await linkCustomer(tx, orgId, body.customerPhone, body.customerName) ?? undefined }), ...(body.guestCount && target.tableId && { guestCount: body.guestCount }) },
          })
          // the open order and its table always show the same covers
          if (body.guestCount && target.tableId) await tx.diningTable.update({ where: { id: target.tableId }, data: { guestCount: body.guestCount } })
        }
        const added = lines.map((l) => ({ ...l, id: randomUUID(), orderId: target!.id }))
        await tx.customerOrderItem.createMany({ data: added })
        await tx.customerOrder.updateMany({ where: { id: target.id, billRequestedAt: { not: null } }, data: { billRequestedAt: null } })
        await recalcOrderTotals(tx, target.id, { enforceMinimum: true })
        return { ...(await tx.customerOrder.findUniqueOrThrow({ where: { id: target.id }, include: orderInclude })), sentItemIds: added.map((i) => i.id) }
      })
      publishOrder(order, isNew ? 'created' : 'items_added')
      res.status(201).json({ ...order, reviewCode: makeReviewCode(order.id) })
      return
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002' && attempt < 4) continue
      throw err
    }
  }
}
router.post('/orders', requireAnyPermission('can_use_pos', 'can_manage_orders'), sendPosOrder)

export default router
