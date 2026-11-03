import { publicRegion } from '../utils/regions'
import { runWithCurrency } from '../utils/money'
import { Router } from 'express'
import { z } from 'zod'
import { loadDishOptions, menuOptionsPayload } from '../services/menuOptions'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { rateLimit } from '../middleware/rateLimit'
import { ensureShifts, currentShift, nextShift } from '../utils/menu'
import { enabledOnlineOrderTypes, onlineTrackingCode, parseOnlineTrackingCode } from '../utils/onlineOrder'
import { dishImageUrl } from './menu'
import { brandingLogoUrl } from './orgs'
import { publicOrder } from './public'
import { branchUnavailable } from '../services/branchMenu'
import { createIntent, publicIntent } from '../services/payments'
import { assertReadyForPayment } from '../services/orderPaymentPolicy'
import { queueOnlineOrder, remoteOnlineTracking } from '../services/branchOnline'
import { relayedPaymentOrder } from '../services/branchPayments'
import { brandOrg, publicBranch, onlineOrderSchema, placeOnlineOrder, trackedOnlineOrder, onlineOrderView } from '../services/onlinePlacement'

const router = Router()
router.use(async (_req, _res, next) => { const org = await brandOrg(); runWithCurrency(org?.currency || 'PKR', () => next()) })
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
router.get('/branches', rateLimit('online-branches', 120, 60_000), async (_req, res) => {
  const org = await brandOrg()
  const branches = org ? await prisma.branch.findMany({
    where: { organizationId: org.id, isActive: true }, orderBy: { name: 'asc' },
    select: { id: true, name: true, address: true, city: true, phone: true },
  }) : []
  res.json({ orderTypes: org ? enabledOnlineOrderTypes(org) : [], multiBranch: org?.multiBranch !== false, restaurantName: org?.tradeName || org?.name || 'Restaurant', branches: branches.map(b => ({ ...b, name: org?.multiBranch === false ? org.tradeName || org.name : b.name })) })
})
router.get('/branches/:branchId/menu', rateLimit('online-menu', 120, 60_000), async (req, res) => {
  const { org, branch } = await publicBranch(req.params.branchId)
  const shifts = await ensureShifts(prisma, org.id)
  const shift = currentShift(shifts, org.timezone)
  const { menu, off } = await branchUnavailable(prisma, org.id, branch.id)
  const categories = shift ? await prisma.menuCategory.findMany({
    where: { organizationId: org.id, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { dishes: {
      where: { isActive: true, shifts: { some: { shiftId: shift.id } }, outOfStock: { none: { branchId: branch.id } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    } },
  }) : []
  const upcoming = shift ? null : nextShift(shifts, org.timezone)
  const [options, outOfStock] = await Promise.all([
    loadDishOptions(prisma, categories.flatMap((c) => c.dishes.map((d) => d.id)), branch.id),
    prisma.dishOutOfStock.findMany({ where: { branchId: branch.id }, select: { dishId: true } }),
  ])
  for (const o of outOfStock) off.add(o.dishId)
  for (const c of categories) c.dishes = c.dishes.filter(d => !off.has(d.id))
  res.json({
    restaurant: { name: org.tradeName || org.name, ...publicRegion(org), logoUrl: brandingLogoUrl(org), multiBranch: org.multiBranch },
    branch: { id: branch.id, name: org.multiBranch ? branch.name : org.tradeName || org.name, address: branch.address, phone: branch.phone },
    vat: { enabled: branch.vatEnabled, rate: branch.vatRate },
    deliveryZones: await prisma.deliveryZone.findMany({ where: { organizationId: org.id, branchId: branch.id, isActive: true }, orderBy: { name: 'asc' } }),
    orderTypes: enabledOnlineOrderTypes(org),
    shift: shift && { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime },
    nextShift: upcoming && { name: upcoming.name, startTime: upcoming.startTime, endTime: upcoming.endTime },
    categories: categories.filter((c) => c.dishes.length).map((c) => ({
      id: c.id, name: c.name, description: c.description,
      dishes: c.dishes.map((d) => ({ id: d.id, name: d.name, description: d.description, price: menu.get(d.id)!.price, imageUrl: dishImageUrl(d), ...menuOptionsPayload(options.get(d.id), off) })),
    })),
  })
})
// Response contract: { trackingCode, state, order? }. `order` is present only
// once a database that owns the branch has committed it. A 202 means the
// request is queued for the branch PC: nothing is accepted or paid yet.
router.post('/branches/:branchId/orders', rateLimit('online-place', 10, 60_000), async (req, res) => {
  const body = onlineOrderSchema.parse(req.body)
  const { org, branch } = await publicBranch(req.params.branchId)
  const remote = await queueOnlineOrder(org.id, branch.id, body)
  if (remote) { res.status(remote.order ? 200 : 202).json(remote); return }
  const { created, order } = await placeOnlineOrder(branch.id, body)
  res.status(created ? 201 : 200).json({ state: 'placed', order: publicOrder(order), trackingCode: onlineTrackingCode(order.id) })
})
router.get('/orders/:code', rateLimit('online-track', 120, 60_000), async (req, res) => {
  const remote = await remoteOnlineTracking(req.params.code)
  if (remote) { res.json(remote); return }
  const order = await trackedOnlineOrder(parseOnlineTrackingCode(req.params.code))
  res.json({ state: 'placed', order: await onlineOrderView(order) })
})
router.post('/orders/:code/pay', rateLimit('online-pay', 20, 60_000), async (req, res) => {
  const { checkId } = z.object({ checkId: z.string().min(1).optional().nullable() }).parse(req.body ?? {})
  const relayedId = await relayedPaymentOrder(req.params.code)
  const order = await trackedOnlineOrder(relayedId ?? parseOnlineTrackingCode(req.params.code))
  if (!order.branch.isActive) throw new AppError('This branch is unavailable. Contact the restaurant to arrange payment.', 409, 'BRANCH_NOT_FOUND')
  assertReadyForPayment(order)
  if (checkId && !order.checks.some((check) => check.id === checkId)) throw new AppError('Check not found', 404, 'NOT_FOUND')
  const { intent, accessToken } = await createIntent({ organizationId: order.organizationId, branchId: order.branchId, orderId: order.id, checkId, channel: 'qr' })
  res.status(201).json({ ...publicIntent(intent), accessToken, payPath: `/pay/${intent.id}?t=${accessToken}` })
})
export default router
