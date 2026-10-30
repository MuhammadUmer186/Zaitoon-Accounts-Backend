import { Router, Request, Response } from 'express'
import crypto from 'node:crypto'
import { z } from 'zod'
import { prisma, config } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { loyaltyConfig } from '../services/tenders'
import { paymentStatus } from '../services/payments'
import { adapterFor } from '../services/payments/adapters'

const router = Router()
router.use(authenticate, requirePermission('can_manage_settings'))
const schema = z.object({
  loyaltyEarnPerUnit: z.number().finite().min(0).max(1000000),
  loyaltyPointValue: z.number().finite().min(0).max(1000000),
  promotionsStack: z.boolean(),
  providerName: z.string().trim().max(80),
  paymentEnvironment: z.enum(['sandbox', 'production']),
  merchantId: z.string().trim().max(200),
  publicKey: z.string().trim().max(2000),
  // none, or a registered integration (services/payments/adapters)
  paymentAdapter: z.string().trim().max(40).default('none'),
  secret: z.string().trim().max(4000).optional(),
  clearSecret: z.boolean().optional(),
})
const publicSettings = (row: Awaited<ReturnType<typeof prisma.commerceSettings.findUnique>>) => ({
  loyaltyEarnPerUnit: row?.loyaltyEarnPerUnit ?? 0, loyaltyPointValue: row?.loyaltyPointValue ?? 0, promotionsStack: row?.promotionsStack ?? false,
  providerName: row?.providerName ?? '', paymentEnvironment: row?.paymentEnvironment ?? 'sandbox', merchantId: row?.merchantId ?? '', publicKey: row?.publicKey ?? '', hasSecret: !!row?.secretSealed,
  paymentAdapter: row?.paymentAdapter ?? 'none',
})
// loyalty runs only with both rates set and the liability account mapped
async function withStatus(organizationId: string, row: Awaited<ReturnType<typeof prisma.commerceSettings.findUnique>>) {
  const config = await loyaltyConfig(prisma as never, organizationId)
  const payments = await paymentStatus(prisma, organizationId)
  // adapter_required: nothing collects money · sandbox_only: the simulator, no real money · active: a real integration
  const paymentState = !payments.active ? 'adapter_required' : payments.live ? 'active' : 'sandbox_only'
  return { ...publicSettings(row), paymentStatus: paymentState, paymentStatusReason: payments.reason, loyaltyStatus: config.active ? 'active' : !(config.earnPerUnit > 0 && config.pointValue > 0) ? 'off' : 'needs_mapping' }
}
router.use(async (req, _res, next) => {
  if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } })) throw new AppError('Account inactive', 401, 'TOKEN_INVALID')
  next()
})
router.get('/', async (req: Request, res: Response) => res.json(await withStatus(req.user.organizationId, await prisma.commerceSettings.findUnique({ where: { organizationId: req.user.organizationId } }))))
router.put('/', async (req: Request, res: Response) => {
  const { secret, clearSecret, ...values } = schema.parse(req.body)
  if (secret && clearSecret) throw new AppError('Replace or clear the secret, not both', 400, 'VALIDATION_ERROR')
  const adapter = values.paymentAdapter === 'none' ? null : adapterFor(values.paymentAdapter)
  if (values.paymentAdapter !== 'none' && !adapter) throw new AppError('Unknown payment integration', 400, 'VALIDATION_ERROR')
  if (adapter?.sandboxOnly && values.paymentEnvironment !== 'sandbox') throw new AppError(`${adapter.label} can only be used with the sandbox environment`, 400, 'SANDBOX_ONLY')
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`commerce-settings:${req.user.organizationId}`}))`
    const current = await tx.commerceSettings.findUnique({ where: { organizationId: req.user.organizationId } })
    let secretSealed = current?.secretSealed ?? null
    // A secret belongs to a provider, merchant and environment. Switching any
    // of them must not silently carry the former credentials into production.
    if (clearSecret || (current && (values.paymentAdapter !== current.paymentAdapter || values.providerName !== current.providerName || values.merchantId !== current.merchantId || values.paymentEnvironment !== current.paymentEnvironment))) secretSealed = null
    if (secret) {
      const key = crypto.createHash('sha256').update(process.env.PAYMENT_ENCRYPTION_KEY || `payments:${config.jwtSecret}`).digest()
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      secretSealed = [iv, cipher.getAuthTag(), encrypted].map((v) => v.toString('base64')).join('.')
    }
    const row = await tx.commerceSettings.upsert({ where: { organizationId: req.user.organizationId }, create: { ...values, secretSealed, organizationId: req.user.organizationId, updatedBy: req.user.id }, update: { ...values, secretSealed, updatedBy: req.user.id } })
    await logAudit(tx, { req, action: 'commerce_settings', module: 'settings', newData: { ...values, hasSecret: !!secretSealed } })
    return row
  })
  res.json(await withStatus(req.user.organizationId, result))
})
export default router
