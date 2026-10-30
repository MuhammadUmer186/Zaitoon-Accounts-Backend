import { moneyTolerance as regionalMoneyTolerance } from '../utils/money'
import { validMoneyPrecision } from '../utils/money'
import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { Request } from 'express'
import { z } from 'zod'
import { prisma, config } from '../config'
import { AppError } from '../middleware/error'
import { getUserPermissions } from '../utils/permissions'
import { logAudit } from '../utils/audit'
import { currentShift, ensureShifts, nextOrderNo, recalcOrderTotals } from '../utils/menu'
import { lineSelectionSchema, priceLines } from './menuOptions'
import { completeOrderInTransaction, completeOrderSchema, orderInclude } from '../routes/orders'
import { deliveryQuote } from './deliveryPricing'

export const OFFLINE_HOURS = 24
const key = () => `${config.jwtSecret}:pos-offline`
const money = z.number().finite().min(0).max(100000000).refine((n) => validMoneyPrecision(n), "Use the selected currency decimal precision")
export const offlineOrderSchema = z.object({
  counterCode: z.string().trim().regex(/^[a-zA-Z0-9_-]{1,30}$/).optional(),
  clientUuid: z.string().uuid(), deviceId: z.string().uuid(), sequence: z.number().int().min(1).max(999999999),
  lease: z.string().min(1).max(4096), createdAt: z.string().datetime(),
  orderType: z.enum(['dine_in', 'takeaway', 'delivery']), tableId: z.string().min(1).optional().nullable(),
  customerName: z.string().trim().max(60).optional().nullable(), customerPhone: z.string().trim().max(30).optional().nullable(), deliveryAddress: z.string().trim().max(300).optional().nullable(),
  deliveryZoneId: z.string().min(1).optional().nullable(), deliveryArea: z.string().trim().max(80).optional().nullable(),
  // the delivery charge tax printed on the offline receipt (zone orders only)
  deliveryFeeVatRate: z.number().min(0).max(100).optional().nullable(), deliveryFeeTaxCategory: z.enum(['S', 'Z', 'E', 'O']).optional().nullable(),
  items: z.array(z.object({ dishId: z.string().min(1), quantity: z.number().int().min(1).max(99), course: z.number().int().min(1).max(5).default(1), notes: z.string().trim().max(200).optional().nullable(), ...lineSelectionSchema })).min(1).max(100),
  expectedTotal: money, vatRate: z.number().min(0).max(100),
  payment: z.object({ paidAt: z.string().datetime(), payments: z.array(z.object({ method: z.enum(['cash', 'card', 'mada', 'bank_transfer', 'other']), amount: money })).min(1).max(6), amountTendered: money.optional().nullable() }).optional(),
}).superRefine((b, ctx) => {
  if (b.orderType === 'dine_in' && !b.tableId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tableId'], message: 'Choose a table' })
  if (b.orderType === 'delivery' && (b.deliveryAddress?.length ?? 0) < 5) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryAddress'], message: 'Enter the delivery address' })
  if (b.deliveryZoneId && (b.deliveryFeeVatRate == null || !b.deliveryFeeTaxCategory)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryFeeVatRate'], message: 'Record the delivery charge tax shown on the receipt' })
  if (b.expectedTotal > 0 && b.payment?.payments.some((p) => p.amount === 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payment', 'payments'], message: 'Payment parts must be positive' })
  if (b.expectedTotal === 0 && b.payment?.payments.some((p) => p.amount > 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['payment', 'payments'], message: 'A free order cannot have a positive payment' })
})
export type OfflineOrderInput = z.infer<typeof offlineOrderSchema>
interface Lease { purpose: string; organizationId: string; branchId: string; userId: string; deviceId: string; tillSessionId: string | null; authorizedAt?: number; iat: number; exp: number }

export function makeLease(req: Request, deviceId: string, branchId: string, tillSessionId: string | null, authorizedAt = Date.now()) {
  return jwt.sign({ purpose: 'pos-offline', organizationId: req.user.organizationId, branchId, userId: req.user.id, deviceId, tillSessionId, authorizedAt }, key(), { expiresIn: `${OFFLINE_HOURS}h`, audience: 'pos-offline' })
}

function verifyLease(req: Request, input: OfflineOrderInput): Lease {
  let lease: Lease
  // An expired lease may sync a sale genuinely recorded during its validity.
  try { lease = jwt.verify(input.lease, key(), { audience: 'pos-offline', ignoreExpiration: true }) as Lease } catch { throw new AppError('Offline authorization is invalid', 403, 'OFFLINE_LEASE_INVALID') }
  if (lease.purpose !== 'pos-offline' || lease.organizationId !== req.user.organizationId || lease.userId !== req.user.id || lease.deviceId !== input.deviceId) throw new AppError('Sign in as the cashier who recorded this offline order', 403, 'OFFLINE_OWNER')
  const created = Date.parse(input.createdAt), paid = input.payment ? Date.parse(input.payment.paidAt) : created
  if (!Number.isFinite(lease.iat) || !Number.isFinite(lease.exp) || lease.exp - lease.iat > OFFLINE_HOURS * 3600 + 1 || created < lease.iat * 1000 - 300000 || paid < created || paid > lease.exp * 1000 || paid > Date.now() + 300000) throw new AppError('Offline timestamps fall outside the device authorization window', 409, 'OFFLINE_TIME_CONFLICT')
  return lease
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const hash = (v: unknown) => crypto.createHash('sha256').update(canonical(v)).digest('hex')

export async function syncOfflineOrder(req: Request, input: OfflineOrderInput) {
  const lease = verifyLease(req, input)
  const { lease: _lease, payment, expectedTotal, vatRate, ...base } = input
  const baseHash = hash(base), paymentHash = payment ? hash({ payment, expectedTotal, vatRate }) : null
  const permissions = await getUserPermissions(prisma, req.user.id)
  if (!permissions.permissions.has('can_use_pos') || (payment && !permissions.permissions.has('can_manage_orders'))) throw new AppError('Your current permissions do not allow syncing this sale', 403, 'FORBIDDEN')
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${req.user.organizationId} FOR SHARE`
        const policy = await tx.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { offlinePosEnabled: true, offlinePosDisabledAt: true, offlinePosRevokedAt: true } })
        const cutoff = policy.offlinePosDisabledAt?.getTime()
        const issued = lease.authorizedAt ?? lease.iat * 1000
        // Recover receipts genuinely captured before the switch was turned off.
        // Old leases cannot authorize new orders/payments after that cutoff,
        // including after the feature has subsequently been re-enabled.
        const recordedAt = Math.max(Date.parse(input.createdAt), payment ? Date.parse(payment.paidAt) : 0)
        const revocations = [...policy.offlinePosRevokedAt.map(at => at.getTime()), ...(cutoff ? [cutoff] : [])]
        if ((!policy.offlinePosEnabled && !cutoff) || revocations.some(at => issued <= at && recordedAt > at)) {
          throw new AppError('Offline functionality was disabled before this order or payment was recorded. Review this saved ticket online.', 409, 'OFFLINE_DISABLED')
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`offline:${req.user.organizationId}:${input.clientUuid}`}))`
        const device = await tx.posOfflineDevice.findFirst({ where: { id: input.deviceId, organizationId: req.user.organizationId, branchId: lease.branchId, isActive: true } })
        if (!device) throw new AppError('Offline device is disabled or belongs to another branch', 409, 'OFFLINE_DEVICE_INVALID')
        const user = await tx.user.findFirst({ where: { id: req.user.id, isActive: true, organizationId: req.user.organizationId, organization: { isActive: true } } })
        const branch = await tx.branch.findFirst({ where: { id: device.branchId, organizationId: req.user.organizationId, isActive: true } })
        if (!user || !branch) throw new AppError('Cashier or branch is inactive', 403, 'FORBIDDEN')
        const previous = await tx.offlineOrderSync.findUnique({ where: { organizationId_clientUuid: { organizationId: req.user.organizationId, clientUuid: input.clientUuid } } })
        if (previous && (previous.baseHash !== baseHash || previous.userId !== req.user.id)) throw new AppError('This client UUID already belongs to a different order', 409, 'OFFLINE_ID_CONFLICT')
        if (previous && payment && previous.paymentHash && previous.paymentHash !== paymentHash) throw new AppError('This order already has a different recorded payment', 409, 'OFFLINE_PAYMENT_CONFLICT')
        if (previous && (!payment || previous.paymentHash)) {
          const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: previous.orderId }, include: orderInclude })
          return { order, duplicate: true }
        }
        if (Math.abs((branch.vatEnabled ? branch.vatRate : 0) - vatRate) > 0.00001) throw new AppError('The branch tax rate changed; review this receipt before syncing', 409, 'OFFLINE_TAX_CHANGED')
        let orderId = previous?.orderId
        if (!previous) {
          if (await tx.offlineOrderSync.findUnique({ where: { deviceId_sequence: { deviceId: device.id, sequence: input.sequence } } })) throw new AppError('This device order number is already in use', 409, 'OFFLINE_NUMBER_CONFLICT')
          const priced = await priceLines(tx, { organizationId: req.user.organizationId, branchId: device.branchId, items: input.items })
          if (priced.unavailable.length) throw new AppError('A dish is unavailable; review the queued order', 409, 'DISH_UNAVAILABLE')
          if (input.orderType === 'dine_in') {
            const table = await tx.diningTable.findFirst({ where: { id: input.tableId!, organizationId: req.user.organizationId, branchId: device.branchId, isActive: true } })
            if (!table) throw new AppError('This table is unavailable', 409, 'OFFLINE_TABLE_CONFLICT')
            await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${table.id} FOR UPDATE`
            if (await tx.customerOrder.count({ where: { tableId: table.id, status: 'open' } })) throw new AppError('This table has another open order; review before syncing', 409, 'OFFLINE_TABLE_CONFLICT')
            const seated = await tx.diningTable.findUniqueOrThrow({ where: { id: table.id } })
            await tx.diningTable.update({ where: { id: table.id }, data: { needsClearing: false, seatedAt: seated.needsClearing || !seated.seatedAt ? new Date(input.createdAt) : seated.seatedAt, ...(seated.needsClearing && { guestCount: null }) } })
            if (seated.needsClearing) await logAudit(tx, { req, action: 'offline_table_reused', module: 'pos', resourceType: 'dining_table', resourceId: table.id, branchId: device.branchId, newData: { clientUuid: input.clientUuid } })
          }
          const org = await tx.organization.findUniqueOrThrow({ where: { id: req.user.organizationId } })
          const shift = currentShift(await ensureShifts(tx, org.id), org.timezone, new Date(input.createdAt))
          const delivery = await deliveryQuote(tx, org.id, branch, input.orderType, input.deliveryZoneId, input.deliveryArea)
          const created = await tx.customerOrder.create({ data: {
            organizationId: org.id, branchId: device.branchId, counterCode: input.counterCode ?? 'main', orderNo: await nextOrderNo(tx, org.id, device.branchId), source: 'pos', orderType: input.orderType,
            ...delivery,
            tableId: input.orderType === 'dine_in' ? input.tableId : null, shiftId: shift?.id, customerName: input.customerName, customerPhone: input.customerPhone, deliveryAddress: input.deliveryAddress,
            createdBy: req.user.id, createdAt: new Date(input.createdAt), offlineOrderNo: `D${device.number}-${String(input.sequence).padStart(6, '0')}`, offlineSyncedAt: new Date(),
            items: { create: priced.lines.map((l, i) => ({ ...l, course: input.items[i].course, held: input.items[i].course > Math.min(...input.items.map((x) => x.course)), createdAt: new Date(input.createdAt) })) },
          } })
          orderId = created.id
          await recalcOrderTotals(tx, orderId, { enforceMinimum: true })
        }
        let order = await tx.customerOrder.findUniqueOrThrow({ where: { id: orderId! }, include: orderInclude })
        if (Math.abs(order.totalAmount - expectedTotal) > regionalMoneyTolerance()) throw new AppError(`Current total ${order.totalAmount} differs from recorded total ${expectedTotal}; review payment`, 409, 'OFFLINE_PRICE_CHANGED')
        // Same total but a different fee tax (e.g. standard to zero-rated) would
        // make the printed receipt's VAT split wrong
        if (input.deliveryZoneId && (Math.abs((order.deliveryFeeVatRate ?? 0) - input.deliveryFeeVatRate!) > 0.00001 || order.deliveryFeeTaxCategory !== input.deliveryFeeTaxCategory)) throw new AppError('The delivery charge tax changed; review this receipt before syncing', 409, 'OFFLINE_TAX_CHANGED')
        if (payment) {
          const body = completeOrderSchema.parse({ payments: expectedTotal === 0 ? undefined : payment.payments, paymentMethod: payment.payments[0].method, amountTendered: payment.amountTendered })
          const result = await completeOrderInTransaction(tx, req, order, body, new Date(payment.paidAt), lease.tillSessionId)
          order = result.updated
        }
        if (previous) await tx.offlineOrderSync.update({ where: { id: previous.id }, data: { paymentHash, syncedAt: new Date() } })
        else await tx.offlineOrderSync.create({ data: { organizationId: req.user.organizationId, clientUuid: input.clientUuid, deviceId: device.id, sequence: input.sequence, userId: req.user.id, baseHash, paymentHash, orderId: order.id, clientCreatedAt: new Date(input.createdAt) } })
        await tx.posOfflineDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        await logAudit(tx, { req, action: 'offline_sync', module: 'pos', resourceType: 'customer_order', resourceId: order.id, branchId: device.branchId, newData: { clientUuid: input.clientUuid, deviceId: device.id, offlineOrderNo: order.offlineOrderNo, paid: !!payment, originalCreatedAt: input.createdAt, originalPaidAt: payment?.paidAt } })
        return { order, duplicate: false }
      })
    } catch (e) { if ((e as { code?: string }).code === 'P2002' && attempt < 3) continue; throw e }
  }
}
