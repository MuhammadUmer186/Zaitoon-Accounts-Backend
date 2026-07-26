import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { AccountingMappingKey } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { MAPPING_LABELS } from '../utils/ledger'

const router = Router()
router.use(authenticate)

const ALL_KEYS = Object.keys(MAPPING_LABELS) as AccountingMappingKey[]

const mappingsSchema = z.object({
  mappings: z.array(z.object({
    key: z.enum(ALL_KEYS as [AccountingMappingKey, ...AccountingMappingKey[]]),
    accountId: z.string().nullable(),
  })),
})

// GET /accounting-settings/mappings — every well-known posting role, whether
// it's configured, and what it's pointed at. The frontend uses `configured`
// to render "not set up" warnings without blocking unrelated modules.
router.get('/mappings', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const existing = await prisma.accountingMapping.findMany({
    where: { organizationId: orgId },
    include: { account: { select: { id: true, code: true, name: true, status: true } } },
  })
  const byKey = new Map(existing.map((m) => [m.key, m]))

  const data = ALL_KEYS.map((key) => {
    const mapping = byKey.get(key)
    return {
      key,
      label: MAPPING_LABELS[key],
      account: mapping?.account ?? null,
      configured: !!mapping && mapping.account.status === 'ACTIVE',
    }
  })

  res.json({ data })
})

router.put('/mappings', requirePermission('account_mappings_manage'), async (req: Request, res: Response) => {
  const body = mappingsSchema.parse(req.body)
  const orgId = req.user.organizationId

  const accountIds = body.mappings.filter((m) => m.accountId).map((m) => m.accountId!)
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds }, organizationId: orgId } })
  const accountById = new Map(accounts.map((a) => [a.id, a]))

  for (const m of body.mappings) {
    if (!m.accountId) continue
    const account = accountById.get(m.accountId)
    if (!account) throw new AppError(`Account for mapping ${MAPPING_LABELS[m.key]} not found in this organization`, 404, 'NOT_FOUND')
    if (account.status !== 'ACTIVE') throw new AppError(`Account for mapping ${MAPPING_LABELS[m.key]} is archived`, 400, 'ACCOUNT_ARCHIVED')
  }

  const before = await prisma.accountingMapping.findMany({ where: { organizationId: orgId } })

  await prisma.$transaction(async (tx) => {
    for (const m of body.mappings) {
      if (!m.accountId) {
        await tx.accountingMapping.deleteMany({ where: { organizationId: orgId, key: m.key } })
        continue
      }
      await tx.accountingMapping.upsert({
        where: { organizationId_key: { organizationId: orgId, key: m.key } },
        update: { accountId: m.accountId },
        create: { organizationId: orgId, key: m.key, accountId: m.accountId },
      })
    }
  })

  await logAudit(prisma, { req, action: 'account_mappings.changed', module: 'accounts', resourceType: 'accounting_mapping', oldData: before, newData: body.mappings })

  res.json({ message: 'Account mappings updated' })
})

export default router
