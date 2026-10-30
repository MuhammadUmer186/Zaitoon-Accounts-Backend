import crypto from 'node:crypto'
import { Request } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { currentShift, ensureShifts, nextOrderNo, recalcOrderTotals } from '../utils/menu'
import { logAudit } from '../utils/audit'
import { priceLines, lineSelectionSchema } from './menuOptions'
import { deliveryQuote, normalizePhone } from './deliveryPricing'
import { orderInclude } from '../routes/orders'

export const callOrderSchema = z.object({
  requestId: z.string().uuid(), branchId: z.string().min(1).optional(), orderType: z.enum(['delivery', 'takeaway']),
  customerName: z.string().trim().min(1).max(60), customerPhone: z.string().trim().min(7).max(30).regex(/^\+?[0-9 ()-]+$/),
  deliveryAddress: z.string().trim().max(300).optional(), deliveryZoneId: z.string().min(1).optional(), deliveryArea: z.string().trim().max(80).optional(),
  deliveryPaymentMode: z.enum(['cod', 'prepaid']).default('prepaid'), notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({ dishId: z.string().min(1), quantity: z.number().int().min(1).max(99), notes: z.string().trim().max(200).optional(), ...lineSelectionSchema })).min(1).max(100),
}).superRefine((b, c) => {
  if (b.orderType === 'delivery' && (!b.deliveryZoneId || (b.deliveryAddress?.length ?? 0) < 5)) c.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a zone and enter the delivery address', path: ['deliveryZoneId'] })
  if (b.orderType === 'takeaway' && (!b.branchId || b.deliveryZoneId)) c.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose a pickup branch, without a delivery zone', path: ['branchId'] })
})

export async function createCallOrder(req: Request, input: z.infer<typeof callOrderSchema>) {
  const orgId = req.user.organizationId
  const zone = input.deliveryZoneId ? await prisma.deliveryZone.findFirst({ where: { id: input.deliveryZoneId, organizationId: orgId } }) : null
  const branchId = zone?.branchId ?? input.branchId
  if (!branchId || input.branchId && input.branchId !== branchId) throw new AppError('The delivery zone belongs to another branch', 400, 'DELIVERY_BRANCH_MISMATCH')
  await assertBranchAccess(req, branchId)
  const org = await prisma.organization.findFirst({ where: { id: orgId, isActive: true } })
  if (!org || !await prisma.user.count({ where: { id: req.user.id, organizationId: orgId, isActive: true } })) throw new AppError('Account is inactive', 403, 'FORBIDDEN')
  const phone = normalizePhone(input.customerPhone, org.country)
  const hash = crypto.createHash('sha256').update(JSON.stringify({ ...input, customerPhone: phone, branchId })).digest('hex')
  for (let attempt = 0; ; attempt++) {
    try { return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`call-order:${orgId}`}))`
    const previous = await tx.customerOrder.findUnique({ where: { organizationId_intakeRequestId: { organizationId: orgId, intakeRequestId: input.requestId } }, include: orderInclude })
    if (previous) {
      if (previous.intakeRequestHash !== hash) throw new AppError('This request ID already belongs to a different order', 409, 'INTAKE_REQUEST_CONFLICT')
      return { order: previous, duplicate: true }
    }
    const branch = await tx.branch.findFirst({ where: { id: branchId, organizationId: orgId, isActive: true } })
    if (!branch) throw new AppError('Branch is unavailable', 404, 'NOT_FOUND')
    const priced = await priceLines(tx, { organizationId: orgId, branchId, items: input.items })
    if (priced.unavailable.length) throw new AppError('A dish is unavailable in this branch', 409, 'DISH_UNAVAILABLE')
    const quote = await deliveryQuote(tx, orgId, branch, input.orderType, input.deliveryZoneId, input.deliveryArea, true)
    // Phone identity is locked across all intake requests to avoid lost addresses.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:${orgId}:${phone}`}))`
    const existing = await tx.customer.findUnique({ where: { organizationId_phone: { organizationId: orgId, phone } } })
    const addresses = Array.isArray(existing?.addresses) ? existing.addresses.filter((a): a is string => typeof a === 'string') : []
    if (input.orderType === 'delivery' && input.deliveryAddress && !addresses.includes(input.deliveryAddress)) addresses.unshift(input.deliveryAddress)
    const customer = await tx.customer.upsert({ where: { organizationId_phone: { organizationId: orgId, phone } }, create: { organizationId: orgId, phone, name: input.customerName, addresses: addresses.slice(0, 10) }, update: { name: input.customerName, addresses: addresses.slice(0, 10) } })
    const shift = currentShift(await ensureShifts(tx, orgId), org.timezone)
    const order = await tx.customerOrder.create({ data: {
      organizationId: orgId, branchId, orderNo: await nextOrderNo(tx, orgId, branchId), source: 'call_center', status: 'open', orderType: input.orderType,
      intakeRequestId: input.requestId, intakeRequestHash: hash, customerId: customer.id, customerName: input.customerName, customerPhone: phone,
      deliveryAddress: input.orderType === 'delivery' ? input.deliveryAddress : null, ...quote,
      deliveryPaymentMode: input.orderType === 'delivery' ? 'prepaid' : null,
      shiftId: shift?.id, createdBy: req.user.id, notes: input.notes, items: { create: priced.lines },
    } })
    await recalcOrderTotals(tx, order.id, { enforceMinimum: true })
    await logAudit(tx, { req, action: 'call_center_order', module: 'call_center', branchId, resourceId: order.id, resourceRef: String(order.orderNo), newData: { customerId: customer.id, zoneId: input.deliveryZoneId, paymentMode: input.orderType === 'delivery' ? 'prepaid' : null } })
    return { order: await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude }), duplicate: false }
    }) } catch (e) { if ((e as { code?: string }).code === 'P2002' && attempt < 4) continue; throw e }
  }
}
