import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const accountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  accountType: z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
  accountSubtype: z.string().optional(),
  parentId: z.string().optional(),
  isHeader: z.boolean().default(false),
  normalBalance: z.enum(['debit', 'credit']).default('debit'),
  description: z.string().optional(),
  branchId: z.string().optional(),
})

const journalLineSchema = z.object({
  accountId: z.string(),
  description: z.string().optional(),
  debitAmount: z.number().default(0),
  creditAmount: z.number().default(0),
  lineOrder: z.number().default(0),
})

const journalEntrySchema = z.object({
  branchId: z.string(),
  entryDate: z.string().or(z.date()),
  description: z.string().min(1),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  lines: z.array(journalLineSchema).min(2),
})

// GET /accounting/accounts
router.get('/accounts', async (req: Request, res: Response) => {
  const { accountType, branchId } = req.query as Record<string, string>

  const where: Record<string, unknown> = {
    organizationId: req.user.organizationId,
    isActive: true,
  }
  if (accountType) where.accountType = accountType
  if (branchId) where.branchId = branchId

  const accounts = await prisma.account.findMany({
    where,
    orderBy: [{ accountType: 'asc' }, { code: 'asc' }],
    include: { children: { select: { id: true, code: true, name: true } } },
  })

  res.json({ data: accounts })
})

// POST /accounting/accounts
router.post('/accounts', async (req: Request, res: Response) => {
  const body = accountSchema.parse(req.body)
  const account = await prisma.account.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(account)
})

// GET /accounting/accounts/:id
router.get('/accounts/:id', async (req: Request, res: Response) => {
  const account = await prisma.account.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: {
      children: true,
      parent: { select: { id: true, code: true, name: true } },
    },
  })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')
  res.json(account)
})

// PUT /accounting/accounts/:id
router.put('/accounts/:id', async (req: Request, res: Response) => {
  const account = await prisma.account.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')

  const body = accountSchema.partial().parse(req.body)
  const updated = await prisma.account.update({ where: { id: req.params.id }, data: body })
  res.json(updated)
})

// DELETE /accounting/accounts/:id
router.delete('/accounts/:id', async (req: Request, res: Response) => {
  const account = await prisma.account.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')

  const hasChildren = await prisma.account.count({ where: { parentId: req.params.id } })
  if (hasChildren > 0) throw new AppError('Cannot delete account with sub-accounts', 400, 'HAS_CHILDREN')

  const hasLines = await prisma.journalLine.count({ where: { accountId: req.params.id } })
  if (hasLines > 0) {
    await prisma.account.update({ where: { id: req.params.id }, data: { isActive: false } })
    return res.json({ message: 'Account deactivated (has journal entries)' })
  }

  await prisma.account.delete({ where: { id: req.params.id } })
  res.json({ message: 'Account deleted' })
})

// GET /accounting/journals
router.get('/journals', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const { branchId, fromDate, toDate, status } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (status) where.status = status
  if (fromDate || toDate) {
    where.entryDate = {
      ...(fromDate && { gte: new Date(fromDate) }),
      ...(toDate && { lte: new Date(toDate) }),
    }
  }

  const [entries, total] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { entryDate: 'desc' },
      include: {
        branch: { select: { id: true, name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.journalEntry.count({ where }),
  ])

  res.json(paginatedResponse(entries, total, page, limit))
})

// POST /accounting/journals
router.post('/journals', async (req: Request, res: Response) => {
  const body = journalEntrySchema.parse(req.body)

  const branch = await prisma.branch.findFirst({
    where: { id: body.branchId, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const totalDebit = body.lines.reduce((s, l) => s + l.debitAmount, 0)
  const totalCredit = body.lines.reduce((s, l) => s + l.creditAmount, 0)
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01

  const year = new Date().getFullYear()
  const jeCount = await prisma.journalEntry.count({
    where: { organizationId: req.user.organizationId, entryNo: { startsWith: `JE-${year}-` } },
  })
  const entryNo = `JE-${year}-${(jeCount + 1).toString().padStart(4, '0')}`

  const { lines, ...entryData } = body

  const entry = await prisma.journalEntry.create({
    data: {
      ...entryData,
      entryNo,
      entryDate: new Date(entryData.entryDate),
      organizationId: req.user.organizationId,
      totalDebit,
      totalCredit,
      isBalanced,
      createdBy: req.user.id,
      lines: { create: lines },
    },
    include: { lines: { include: { account: true } }, branch: true },
  })

  res.status(201).json(entry)
})

// GET /accounting/journals/:id
router.get('/journals/:id', async (req: Request, res: Response) => {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
    include: {
      lines: {
        include: { account: { select: { id: true, code: true, name: true } } },
        orderBy: { lineOrder: 'asc' },
      },
      branch: true,
    },
  })
  if (!entry) throw new AppError('Journal entry not found', 404, 'NOT_FOUND')
  res.json(entry)
})

// PUT /accounting/journals/:id
router.put('/journals/:id', async (req: Request, res: Response) => {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!entry) throw new AppError('Journal entry not found', 404, 'NOT_FOUND')
  if (entry.status !== 'draft') throw new AppError('Only draft entries can be edited', 400, 'INVALID_STATUS')

  const body = journalEntrySchema.partial().parse(req.body)
  const { lines, ...entryData } = body

  if (lines !== undefined) {
    await prisma.journalLine.deleteMany({ where: { journalEntryId: req.params.id } })
    if (lines.length > 0) {
      const totalDebit = lines.reduce((s, l) => s + l.debitAmount, 0)
      const totalCredit = lines.reduce((s, l) => s + l.creditAmount, 0)

      await prisma.journalEntry.update({
        where: { id: req.params.id },
        data: {
          totalDebit,
          totalCredit,
          isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
          lines: { create: lines },
        },
      })
    }
  }

  const updated = await prisma.journalEntry.update({
    where: { id: req.params.id },
    data: {
      ...entryData,
      ...(entryData.entryDate && { entryDate: new Date(entryData.entryDate) }),
    },
    include: { lines: { include: { account: true } }, branch: true },
  })

  res.json(updated)
})

// POST /accounting/journals/:id/post
router.post('/journals/:id/post', async (req: Request, res: Response) => {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!entry) throw new AppError('Journal entry not found', 404, 'NOT_FOUND')
  if (entry.status !== 'draft') throw new AppError('Only draft entries can be posted', 400, 'INVALID_STATUS')
  if (!entry.isBalanced) throw new AppError('Journal entry is not balanced (debit ≠ credit)', 400, 'UNBALANCED_ENTRY')

  const updated = await prisma.journalEntry.update({
    where: { id: req.params.id },
    data: { status: 'posted', postedBy: req.user.id, postedAt: new Date() },
  })
  res.json(updated)
})

// POST /accounting/journals/:id/void
router.post('/journals/:id/void', async (req: Request, res: Response) => {
  const { voidReason } = req.body
  if (!voidReason) throw new AppError('Void reason is required', 400, 'VALIDATION_ERROR')

  const entry = await prisma.journalEntry.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!entry) throw new AppError('Journal entry not found', 404, 'NOT_FOUND')
  if (entry.status === 'void') throw new AppError('Entry is already voided', 400, 'INVALID_STATUS')

  const updated = await prisma.journalEntry.update({
    where: { id: req.params.id },
    data: { status: 'void', voidReason },
  })
  res.json(updated)
})

export default router
