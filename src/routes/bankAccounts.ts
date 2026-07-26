import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { assertUniqueCode } from '../services/accounts'
import { computeAccountBalances } from '../services/accountBalances'

const router = Router()
router.use(authenticate)

// Never accept or store a full account number/IBAN — only the last 4 digits,
// from which a masked display value is derived server-side. There is no
// application-level encryption for sensitive numbers in this system yet, so
// the safest posture is to never hold the real value at all.
const bankAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  bankName: z.string().min(1),
  accountTitle: z.string().min(1),
  accountNumberLast4: z.string().regex(/^\d{4}$/, 'Must be exactly 4 digits'),
  ibanLast4: z.string().regex(/^\d{4}$/, 'Must be exactly 4 digits').optional(),
  currency: z.string().min(1),
  branchId: z.string().optional(),
  openingDate: z.string().optional(),
  isDefault: z.boolean().default(false),
  defaultTaxRateId: z.string().optional(),
})

const updateBankAccountSchema = z.object({
  bankName: z.string().min(1).optional(),
  accountTitle: z.string().min(1).optional(),
  branchId: z.string().nullable().optional(),
  currency: z.string().min(1).optional(),
  isDefault: z.boolean().optional(),
})

function maskLast4(last4: string, groups = 4) {
  return `${'•••• '.repeat(groups - 1).trim()} ${last4}`
}

router.get('/', requirePermission('bank_accounts_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const bankAccounts = await prisma.bankAccount.findMany({
    where: { organizationId: orgId },
    include: { account: { select: { id: true, code: true, name: true, status: true } }, branch: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  })
  const balances = await computeAccountBalances(prisma, orgId, bankAccounts.map((b) => b.accountId))
  res.json({ data: bankAccounts.map((b) => ({ ...b, balance: balances.get(b.accountId)?.balance ?? 0 })) })
})

router.post('/', requirePermission('bank_accounts_manage'), async (req: Request, res: Response) => {
  const body = bankAccountSchema.parse(req.body)
  const orgId = req.user.organizationId
  await assertUniqueCode(prisma, orgId, body.code)

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: {
        organizationId: orgId,
        code: body.code,
        name: body.name,
        accountClass: 'ASSET',
        reportingGroup: 'Bank',
        normalBalance: 'DEBIT',
        allowManualPosting: true,
        isControlAccount: false,
        defaultTaxRateId: body.defaultTaxRateId,
        createdById: req.user.id,
      },
    })

    if (body.isDefault) {
      await tx.bankAccount.updateMany({ where: { organizationId: orgId, isDefault: true }, data: { isDefault: false } })
    }

    const bankAccount = await tx.bankAccount.create({
      data: {
        organizationId: orgId,
        accountId: account.id,
        branchId: body.branchId,
        bankName: body.bankName,
        accountTitle: body.accountTitle,
        accountNumberMasked: maskLast4(body.accountNumberLast4),
        accountNumberLast4: body.accountNumberLast4,
        ibanMasked: body.ibanLast4 ? maskLast4(body.ibanLast4, 2) : undefined,
        currency: body.currency,
        openingDate: body.openingDate ? new Date(body.openingDate) : undefined,
        isDefault: body.isDefault,
        createdById: req.user.id,
      },
    })

    return { account, bankAccount }
  })

  await logAudit(prisma, {
    req, action: 'bank_account.created', module: 'accounts', resourceType: 'bank_account', resourceId: result.bankAccount.id,
    resourceRef: result.account.code,
    newData: { bankName: body.bankName, accountTitle: body.accountTitle, accountNumberMasked: result.bankAccount.accountNumberMasked },
  })

  res.status(201).json(result)
})

router.get('/:id', requirePermission('bank_accounts_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const bankAccount = await prisma.bankAccount.findFirst({
    where: { id: req.params.id, organizationId: orgId },
    include: { account: true, branch: { select: { id: true, name: true } } },
  })
  if (!bankAccount) throw new AppError('Bank account not found', 404, 'NOT_FOUND')

  const balances = await computeAccountBalances(prisma, orgId, [bankAccount.accountId])
  res.json({ ...bankAccount, balance: balances.get(bankAccount.accountId)?.balance ?? 0 })
})

router.patch('/:id', requirePermission('bank_accounts_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const existing = await prisma.bankAccount.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!existing) throw new AppError('Bank account not found', 404, 'NOT_FOUND')

  const body = updateBankAccountSchema.parse(req.body)

  if (body.isDefault) {
    await prisma.bankAccount.updateMany({ where: { organizationId: orgId, isDefault: true }, data: { isDefault: false } })
  }

  const updated = await prisma.bankAccount.update({ where: { id: existing.id }, data: body })

  if (body.bankName || body.accountTitle) {
    await prisma.account.update({ where: { id: existing.accountId }, data: { name: body.accountTitle ?? undefined } })
  }

  await logAudit(prisma, { req, action: 'bank_account.edited', module: 'accounts', resourceType: 'bank_account', resourceId: updated.id, oldData: existing, newData: updated })
  res.json(updated)
})

router.post('/:id/archive', requirePermission('bank_accounts_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const bankAccount = await prisma.bankAccount.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!bankAccount) throw new AppError('Bank account not found', 404, 'NOT_FOUND')

  const [updated] = await prisma.$transaction([
    prisma.bankAccount.update({ where: { id: bankAccount.id }, data: { isActive: false } }),
    prisma.account.update({ where: { id: bankAccount.accountId }, data: { status: 'ARCHIVED', archivedAt: new Date(), archivedById: req.user.id } }),
  ])

  await logAudit(prisma, { req, action: 'bank_account.archived', module: 'accounts', resourceType: 'bank_account', resourceId: bankAccount.id })
  res.json(updated)
})

router.post('/:id/restore', requirePermission('bank_accounts_manage'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const bankAccount = await prisma.bankAccount.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!bankAccount) throw new AppError('Bank account not found', 404, 'NOT_FOUND')

  const [updated] = await prisma.$transaction([
    prisma.bankAccount.update({ where: { id: bankAccount.id }, data: { isActive: true } }),
    prisma.account.update({ where: { id: bankAccount.accountId }, data: { status: 'ACTIVE', archivedAt: null, archivedById: null } }),
  ])

  await logAudit(prisma, { req, action: 'bank_account.restored', module: 'accounts', resourceType: 'bank_account', resourceId: bankAccount.id })
  res.json(updated)
})

export default router
