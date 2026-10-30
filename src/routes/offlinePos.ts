import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { assertBranchAccess } from '../utils/branchScope'
import { AppError } from '../middleware/error'
import { makeLease, OFFLINE_HOURS, offlineOrderSchema, syncOfflineOrder } from '../services/offlinePos'
import { publishOrder, orderInclude } from './orders'
import { issueForOrder } from '../services/zatca'
import { publish } from '../utils/liveEvents'
import { makeReviewCode } from '../utils/reviewCode'

const router = Router()

router.post('/offline/bootstrap', authenticate, requirePermission('can_use_pos'), async (req, res) => {
  const b = z.object({ deviceId: z.string().uuid(), branchId: z.string().min(1), name: z.string().trim().min(1).max(80) }).parse(req.body)
  await assertBranchAccess(req, b.branchId)
  const user = await prisma.user.findFirst({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true } })
  if (!user) throw new AppError('Cashier is inactive', 403, 'FORBIDDEN')
  const branch = await prisma.branch.findFirst({ where: { id: b.branchId, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })
  if (!branch) throw new AppError('Branch is unavailable', 404, 'NOT_FOUND')
  const bootstrap = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${req.user.organizationId} FOR UPDATE`
    const org = await tx.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { offlinePosEnabled: true, offlinePosDisabledAt: true } })
    if (!org.offlinePosEnabled) throw new AppError('Offline functionality is disabled in Settings', 403, 'OFFLINE_DISABLED')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offline-device:${req.user.organizationId}`}))`
    const existing = await tx.posOfflineDevice.findUnique({ where: { id: b.deviceId } })
    let device = existing
    if (existing) {
      if (existing.organizationId !== req.user.organizationId || existing.branchId !== branch.id || !existing.isActive) throw new AppError('Device registration does not match this branch', 409, 'OFFLINE_DEVICE_INVALID')
    } else {
      const last = await tx.posOfflineDevice.aggregate({ where: { organizationId: req.user.organizationId }, _max: { number: true } })
      device = await tx.posOfflineDevice.create({ data: { id: b.deviceId, organizationId: req.user.organizationId, branchId: branch.id, number: (last._max.number ?? 0) + 1, name: b.name } })
    }
    const till = await tx.tillSession.findFirst({ where: { organizationId: req.user.organizationId, branchId: branch.id, userId: req.user.id, status: 'open' }, select: { id: true, openedAt: true } })
    const authorizedAt = Math.max(Date.now(), (org.offlinePosDisabledAt?.getTime() ?? 0) + 1)
    return { deviceId: device!.id, prefix: `D${device!.number}`, branchId: branch.id, till, vatRate: branch.vatEnabled ? branch.vatRate : 0,
      lease: makeLease(req, device!.id, branch.id, till?.id ?? null, authorizedAt), authorizedAt: new Date(authorizedAt).toISOString(),
      expiresAt: new Date(authorizedAt + OFFLINE_HOURS * 3600000).toISOString(), serverTime: new Date(authorizedAt).toISOString() }
  })
  res.json(bootstrap)
})

router.post('/orders/sync', authenticate, requirePermission('can_use_pos'), async (req, res) => {
  const body = z.object({ orders: z.array(offlineOrderSchema).min(1).max(20) }).parse(req.body)
  const results = []
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { zatcaEnabled: true } })
  for (const input of body.orders) {
    try {
      // Branch scope is checked from the registered device, never from client metadata.
      const device = await prisma.posOfflineDevice.findFirst({ where: { id: input.deviceId, organizationId: req.user.organizationId } })
      if (!device) throw new AppError('Device not found', 404, 'OFFLINE_DEVICE_INVALID')
      await assertBranchAccess(req, device.branchId)
      const result = await syncOfflineOrder(req, input)
      if (!result.duplicate) {
        publishOrder(result.order, result.order.status === 'completed' ? 'completed' : 'created')
        if (result.order.status === 'completed') publish({ topic: 'sale', action: 'updated', organizationId: req.user.organizationId, branchId: device.branchId })
      }
      if (result.order.status === 'completed') await issueForOrder(result.order.id, 'invoice').catch((e) => console.error('[offline] invoice issuance pending', result.order.id, e))
      const order = await prisma.customerOrder.findUniqueOrThrow({ where: { id: result.order.id }, include: orderInclude })
      results.push({ clientUuid: input.clientUuid, status: 'synced', duplicate: result.duplicate, fiscalPending: org.zatcaEnabled && order.status === 'completed' && !order.zatcaDocuments.some((d) => d.type === 'invoice'), order: { ...order, reviewCode: makeReviewCode(order.id) } })
    } catch (e) {
      if (!(e instanceof AppError)) throw e
      results.push({ clientUuid: input.clientUuid, status: 'conflict', code: e.code, message: e.message })
    }
  }
  res.json({ results })
})

export default router
