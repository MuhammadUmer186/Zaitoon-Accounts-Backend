import { Router, Request, Response } from 'express'
import { z } from 'zod'
import multer from 'multer'
import ExcelJS from 'exceljs'
import { prisma } from '../config'
import { AccountClass } from '../types/accounting'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { AppError } from '../middleware/error'
import { logAudit } from '../utils/audit'
import { postJournalEntry, reverseJournalEntry } from '../utils/ledger'
import { computeAccountBalances } from '../services/accountBalances'
import { fiscalYearStartFor } from '../utils/fiscalYear'
import {
  normalBalanceForClass, assertUniqueCode, assertValidParent, assertNoControlManualPostingConflict,
} from '../services/accounts'
import { tryExportRows, sendRowsCsv, sendRowsExcel, sendRowsPdf } from '../utils/genericExport'

const router = Router()
router.use(authenticate)

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

const accountClassEnum = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])

const createAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  accountClass: accountClassEnum,
  reportingGroup: z.string().optional(),
  accountSubtype: z.string().optional(),
  parentId: z.string().optional(),
  defaultTaxRateId: z.string().optional(),
  isControlAccount: z.boolean().default(false),
  allowManualPosting: z.boolean().default(true),
})

const updateAccountSchema = createAccountSchema.partial()

// ── Account Mappings & Tax Rate cross-checks ────────────────────────────────
async function assertTaxRateBelongsToOrg(organizationId: string, taxRateId: string | undefined) {
  if (!taxRateId) return
  const rate = await prisma.taxRate.findFirst({ where: { id: taxRateId, organizationId } })
  if (!rate) throw new AppError('Tax rate not found', 404, 'TAX_RATE_NOT_FOUND')
}

function accountSummaryShape<T extends { id: string; code: string; accountClass: string }>(a: T) {
  return a
}

// ── Export (must come before /:id) ─────────────────────────────────────────
async function fetchAllForExport(organizationId: string, filters: Record<string, unknown>) {
  return prisma.account.findMany({
    where: { organizationId, ...filters },
    orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
    include: { taxRate: { select: { name: true, rate: true } } },
  })
}

router.get('/export/:format', requirePermission('accounts_export'), async (req: Request, res: Response) => {
  const { format } = req.params
  const { accountClass, status } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const filters: Record<string, unknown> = {}
  if (accountClass) filters.accountClass = accountClass
  if (status) filters.status = status

  const accounts = await fetchAllForExport(orgId, filters)
  const accountIds = accounts.map((a) => a.id)
  const balances = await computeAccountBalances(prisma, orgId, accountIds)

  const rows = accounts.map((a) => ({
    code: a.code,
    name: a.name,
    accountClass: a.accountClass,
    reportingGroup: a.reportingGroup ?? '',
    taxRate: a.taxRate ? `${a.taxRate.name} (${a.taxRate.rate}%)` : '',
    balance: (balances.get(a.id)?.balance ?? 0).toFixed(2),
    status: a.status,
  }))

  await logAudit(prisma, { req, action: 'accounts.exported', module: 'accounts', resourceType: 'account_export', newData: { format, count: rows.length } })

  if (format === 'csv') { sendRowsCsv(res, rows, 'chart-of-accounts'); return }
  if (format === 'xlsx') { await sendRowsExcel(res, rows, 'chart-of-accounts', 'Chart of Accounts'); return }
  if (format === 'pdf') { sendRowsPdf(res, rows, 'chart-of-accounts', 'Chart of Accounts'); return }
  throw new AppError('Unsupported export format', 400, 'VALIDATION_ERROR')
})

// ── Import (must come before /:id) ─────────────────────────────────────────
const IMPORT_COLUMNS = ['code', 'name', 'description', 'accountClass', 'reportingGroup', 'parentCode', 'defaultTaxCode', 'isControlAccount', 'allowManualPosting']

router.get('/import/template', requirePermission('accounts_import'), async (req: Request, res: Response) => {
  sendRowsCsv(res, [Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, '']))], 'chart-of-accounts-import-template')
})

async function parseImportFile(file: Express.Multer.File): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook()
  const isCsv = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')

  if (isCsv) {
    const { Readable } = await import('stream')
    await wb.csv.read(Readable.from(file.buffer))
  } else {
    await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer)
  }

  const ws = wb.worksheets[0]
  if (!ws) return []

  const headerRow = ws.getRow(1).values as unknown[]
  const headers = headerRow.slice(1).map((h) => String(h ?? '').trim())

  const rows: Record<string, string>[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const values = row.values as unknown[]
    const record: Record<string, string> = {}
    headers.forEach((h, i) => { record[h] = String(values[i + 1] ?? '').trim() })
    if (Object.values(record).some((v) => v !== '')) rows.push(record)
  })
  return rows
}

interface ImportRowResult {
  row: number
  data: Record<string, string>
  errors: string[]
}

async function validateImportRows(organizationId: string, rows: Record<string, string>[]): Promise<ImportRowResult[]> {
  const existingCodes = new Set((await prisma.account.findMany({ where: { organizationId }, select: { code: true } })).map((a) => a.code))
  const existingTaxCodes = new Set((await prisma.taxRate.findMany({ where: { organizationId }, select: { code: true } })).map((t) => t.code))
  const seenCodes = new Set<string>()
  const validClasses = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'])

  return rows.map((data, i) => {
    const errors: string[] = []
    const code = data.code?.trim()
    const name = data.name?.trim()
    const accountClass = data.accountClass?.trim().toUpperCase()

    if (!code) errors.push('code is required')
    else if (existingCodes.has(code)) errors.push(`code "${code}" already exists in this organization`)
    else if (seenCodes.has(code)) errors.push(`code "${code}" is duplicated within this import`)
    if (code) seenCodes.add(code)

    if (!name) errors.push('name is required')
    if (!accountClass) errors.push('accountClass is required')
    else if (!validClasses.has(accountClass)) errors.push(`accountClass "${data.accountClass}" is invalid — must be one of ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE`)

    const parentCode = data.parentCode?.trim()
    if (parentCode && !existingCodes.has(parentCode) && !seenCodes.has(parentCode)) {
      errors.push(`parentCode "${parentCode}" was not found among existing or imported accounts`)
    }

    const taxCode = data.defaultTaxCode?.trim()
    if (taxCode && !existingTaxCodes.has(taxCode)) errors.push(`defaultTaxCode "${taxCode}" was not found`)

    return { row: i + 2, data, errors }
  })
}

router.post('/import/validate', requirePermission('accounts_import'), memoryUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('A CSV or Excel file is required', 400, 'VALIDATION_ERROR')
  const rows = await parseImportFile(req.file)
  const results = await validateImportRows(req.user.organizationId, rows)
  res.json({
    totalRows: results.length,
    validRows: results.filter((r) => r.errors.length === 0).length,
    invalidRows: results.filter((r) => r.errors.length > 0).length,
    rows: results,
  })
})

router.post('/import/commit', requirePermission('accounts_import'), memoryUpload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError('A CSV or Excel file is required', 400, 'VALIDATION_ERROR')
  const orgId = req.user.organizationId
  const rows = await parseImportFile(req.file)
  const results = await validateImportRows(orgId, rows)

  if (results.some((r) => r.errors.length > 0)) {
    throw new AppError('Import contains invalid rows — fix them or re-validate before committing', 400, 'INVALID_IMPORT')
  }
  if (results.length === 0) throw new AppError('No rows to import', 400, 'VALIDATION_ERROR')

  const taxRates = await prisma.taxRate.findMany({ where: { organizationId: orgId }, select: { id: true, code: true } })
  const taxRateByCode = new Map(taxRates.map((t) => [t.code, t.id]))

  const created = await prisma.$transaction(async (tx) => {
    const codeToId = new Map<string, string>()
    const createdAccounts = []

    // Pass 1: create every account without parentId (parents resolved after,
    // so import order doesn't need to be parent-first).
    for (const r of results) {
      const acc = await tx.account.create({
        data: {
          organizationId: orgId,
          code: r.data.code,
          name: r.data.name,
          description: r.data.description || undefined,
          accountClass: r.data.accountClass.toUpperCase() as AccountClass,
          reportingGroup: r.data.reportingGroup || undefined,
          normalBalance: normalBalanceForClass(r.data.accountClass.toUpperCase() as AccountClass),
          defaultTaxRateId: r.data.defaultTaxCode ? taxRateByCode.get(r.data.defaultTaxCode) : undefined,
          isControlAccount: r.data.isControlAccount?.toLowerCase() === 'true',
          allowManualPosting: r.data.isControlAccount?.toLowerCase() === 'true' ? false : r.data.allowManualPosting?.toLowerCase() !== 'false',
          createdById: req.user.id,
        },
      })
      codeToId.set(r.data.code, acc.id)
      createdAccounts.push(acc)
    }

    // Pass 2: wire up parentId now that every code in this batch has an id.
    for (const r of results) {
      const parentCode = r.data.parentCode?.trim()
      if (!parentCode) continue
      const parentId = codeToId.get(parentCode) ?? (await tx.account.findFirst({ where: { organizationId: orgId, code: parentCode } }))?.id
      if (parentId) await tx.account.update({ where: { id: codeToId.get(r.data.code)! }, data: { parentId } })
    }

    return createdAccounts
  })

  await logAudit(prisma, { req, action: 'accounts.imported', module: 'accounts', resourceType: 'account_import', newData: { count: created.length } })

  res.status(201).json({ imported: created.length })
})

// ── Opening Balances (must come before /:id) ────────────────────────────────
const openingBalanceLineSchema = z.object({
  accountId: z.string(),
  debit: z.number().min(0).default(0),
  credit: z.number().min(0).default(0),
})

const openingBalanceSchema = z.object({
  openingDate: z.string(),
  lines: z.array(openingBalanceLineSchema).min(1),
})

async function validateOpeningBalances(organizationId: string, body: z.infer<typeof openingBalanceSchema>) {
  const errors: string[] = []
  const accountIds = body.lines.map((l) => l.accountId)
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds }, organizationId } })
  const accountById = new Map(accounts.map((a) => [a.id, a]))

  for (const line of body.lines) {
    const account = accountById.get(line.accountId)
    if (!account) { errors.push(`Account ${line.accountId} not found`); continue }
    if (account.isControlAccount || !account.allowManualPosting) errors.push(`${account.code} — ${account.name} is a control account and cannot receive an opening balance`)
    if (account.status !== 'ACTIVE') errors.push(`${account.code} — ${account.name} is archived`)
    if (line.debit > 0 && line.credit > 0) errors.push(`${account.code}: a line cannot have both a debit and a credit`)
    if (line.debit === 0 && line.credit === 0) errors.push(`${account.code}: enter either a debit or a credit`)
  }

  const totalDebit = body.lines.reduce((s, l) => s + l.debit, 0)
  const totalCredit = body.lines.reduce((s, l) => s + l.credit, 0)
  const plug = Math.round((totalDebit - totalCredit) * 100) / 100

  const existing = await prisma.journalEntry.findFirst({
    where: { organizationId, sourceType: 'OPENING_BALANCE', entryDate: new Date(body.openingDate), reversedById: null },
  })
  if (existing) errors.push('Opening balances have already been posted for this date. Reverse the existing entry first to make corrections.')

  return { errors, totalDebit, totalCredit, plug, alreadyPosted: !!existing }
}

router.get('/opening-balances', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const accounts = await prisma.account.findMany({
    where: { organizationId: orgId, status: 'ACTIVE', allowManualPosting: true, isControlAccount: false },
    orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, name: true, accountClass: true, normalBalance: true },
  })
  const postedEntries = await prisma.journalEntry.findMany({
    where: { organizationId: orgId, sourceType: 'OPENING_BALANCE' },
    orderBy: { entryDate: 'desc' },
    select: { id: true, entryDate: true, entryNo: true, reversedById: true },
  })
  res.json({ accounts, postedEntries })
})

router.post('/opening-balances/validate', requirePermission('opening_balances_post'), async (req: Request, res: Response) => {
  const body = openingBalanceSchema.parse(req.body)
  const result = await validateOpeningBalances(req.user.organizationId, body)
  res.json({ valid: result.errors.length === 0, ...result })
})

router.post('/opening-balances/post', requirePermission('opening_balances_post'), async (req: Request, res: Response) => {
  const body = openingBalanceSchema.parse(req.body)
  const orgId = req.user.organizationId
  const result = await validateOpeningBalances(orgId, body)
  if (result.errors.length > 0) throw new AppError(result.errors[0], 400, 'INVALID_OPENING_BALANCE')

  const je = await prisma.$transaction(async (tx) => {
    const lines = body.lines.map((l) => ({ accountId: l.accountId, description: 'Opening balance', debitAmount: l.debit, creditAmount: l.credit }))

    if (Math.abs(result.plug) > 0.005) {
      const obeMapping = await tx.accountingMapping.findUnique({
        where: { organizationId_key: { organizationId: orgId, key: 'OPENING_BALANCE_EQUITY' } },
        include: { account: true },
      })
      if (!obeMapping) {
        throw new AppError('Opening Balance Equity account is not configured. Configure it under Accounts > Settings before posting opening balances.', 400, 'MAPPING_NOT_CONFIGURED')
      }
      lines.push({
        accountId: obeMapping.accountId,
        description: 'Opening balance plug',
        debitAmount: result.plug < 0 ? Math.abs(result.plug) : 0,
        creditAmount: result.plug > 0 ? result.plug : 0,
      })
    }

    return postJournalEntry(tx as unknown as typeof prisma, {
      organizationId: orgId,
      branchId: (await tx.branch.findFirstOrThrow({ where: { organizationId: orgId } })).id,
      entryDate: new Date(body.openingDate),
      referenceType: 'opening_balance',
      referenceId: orgId,
      sourceType: 'OPENING_BALANCE',
      sourceKey: `OPENING_BALANCE:${orgId}:${body.openingDate}`,
      description: `Opening balances as of ${body.openingDate}`,
      createdBy: req.user.id,
      lines,
    })
  })

  await logAudit(prisma, { req, action: 'opening_balances.posted', module: 'accounts', resourceType: 'journal_entry', resourceId: je?.id, newData: { openingDate: body.openingDate, lineCount: body.lines.length } })

  res.status(201).json(je)
})

// ── Bulk actions (must come before /:id) ────────────────────────────────────
const bulkIdsSchema = z.object({ accountIds: z.array(z.string()).min(1) })

router.post('/bulk/archive', requirePermission('accounts_archive'), async (req: Request, res: Response) => {
  const { accountIds } = bulkIdsSchema.parse(req.body)
  const orgId = req.user.organizationId

  const mapped = await prisma.accountingMapping.findMany({ where: { organizationId: orgId, accountId: { in: accountIds } }, include: { account: true } })
  if (mapped.length > 0) {
    throw new AppError(`${mapped[0].account.code} is used in Account Mappings — update the mapping before archiving`, 400, 'ACCOUNT_MAPPED')
  }

  const result = await prisma.account.updateMany({
    where: { id: { in: accountIds }, organizationId: orgId, isSystem: false },
    data: { status: 'ARCHIVED', archivedAt: new Date(), archivedById: req.user.id },
  })

  await logAudit(prisma, { req, action: 'accounts.bulk_archived', module: 'accounts', resourceType: 'account_bulk', newData: { accountIds, count: result.count } })
  res.json({ archived: result.count })
})

router.post('/bulk/restore', requirePermission('accounts_archive'), async (req: Request, res: Response) => {
  const { accountIds } = bulkIdsSchema.parse(req.body)
  const orgId = req.user.organizationId

  const result = await prisma.account.updateMany({
    where: { id: { in: accountIds }, organizationId: orgId },
    data: { status: 'ACTIVE', archivedAt: null, archivedById: null },
  })

  await logAudit(prisma, { req, action: 'accounts.bulk_restored', module: 'accounts', resourceType: 'account_bulk', newData: { accountIds, count: result.count } })
  res.json({ restored: result.count })
})

const bulkTaxRateSchema = z.object({ accountIds: z.array(z.string()).min(1), taxRateId: z.string().nullable() })

router.post('/bulk/tax-rate', requirePermission('accounts_edit'), async (req: Request, res: Response) => {
  const body = bulkTaxRateSchema.parse(req.body)
  const orgId = req.user.organizationId
  await assertTaxRateBelongsToOrg(orgId, body.taxRateId ?? undefined)

  const result = await prisma.account.updateMany({
    where: { id: { in: body.accountIds }, organizationId: orgId },
    data: { defaultTaxRateId: body.taxRateId },
  })

  await logAudit(prisma, { req, action: 'accounts.bulk_tax_rate_changed', module: 'accounts', resourceType: 'account_bulk', newData: { accountIds: body.accountIds, taxRateId: body.taxRateId, count: result.count } })
  res.json({ updated: result.count })
})

// ── Tree & Summary ──────────────────────────────────────────────────────────
router.get('/tree', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const { includeArchived, branchId, asOfDate } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const accounts = await prisma.account.findMany({
    where: { organizationId: orgId, ...(includeArchived === 'true' ? {} : { status: 'ACTIVE' }) },
    orderBy: [{ accountClass: 'asc' }, { code: 'asc' }],
  })
  const balances = await computeAccountBalances(prisma, orgId, accounts.map((a) => a.id), {
    branchId: branchId || undefined,
    toDate: asOfDate ? new Date(asOfDate) : undefined,
  })

  const byId = new Map(accounts.map((a) => [a.id, { ...a, balance: balances.get(a.id)?.balance ?? 0, children: [] as unknown[] }]))
  const roots: unknown[] = []
  for (const a of byId.values()) {
    if (a.parentId && byId.has(a.parentId)) (byId.get(a.parentId)!.children as unknown[]).push(a)
    else roots.push(a)
  }
  res.json({ data: roots })
})

router.get('/summary', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const { branchId, asOfDate } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const accounts = await prisma.account.findMany({ where: { organizationId: orgId, status: 'ACTIVE' }, select: { id: true, accountClass: true } })
  const balances = await computeAccountBalances(prisma, orgId, accounts.map((a) => a.id), {
    branchId: branchId || undefined,
    toDate: asOfDate ? new Date(asOfDate) : undefined,
  })

  const classes: AccountClass[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']
  const summary = classes.map((c) => {
    const inClass = accounts.filter((a) => a.accountClass === c)
    return {
      accountClass: c,
      count: inClass.length,
      totalBalance: inClass.reduce((s, a) => s + (balances.get(a.id)?.balance ?? 0), 0),
    }
  })
  res.json({ data: summary })
})

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const {
    search, accountClass, reportingGroup, status, parentId, taxRateId, canPost,
    branchId, asOfDate, sortBy, sortDir,
  } = req.query as Record<string, string>
  const orgId = req.user.organizationId

  const where: Record<string, unknown> = { organizationId: orgId }
  if (accountClass) where.accountClass = accountClass
  if (reportingGroup) where.reportingGroup = reportingGroup
  if (status) where.status = status
  if (parentId) where.parentId = parentId
  if (taxRateId) where.defaultTaxRateId = taxRateId
  if (canPost === 'true') { where.allowManualPosting = true; where.isControlAccount = false }
  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ]
  }

  const orderBy = sortBy ? { [sortBy]: sortDir === 'desc' ? 'desc' : 'asc' } : [{ accountClass: 'asc' as const }, { code: 'asc' as const }]

  const [accounts, total] = await Promise.all([
    prisma.account.findMany({
      where,
      ...paginate(page, limit),
      orderBy,
      include: {
        parent: { select: { id: true, code: true, name: true } },
        taxRate: { select: { id: true, name: true, rate: true } },
        bankAccount: { select: { id: true, bankName: true, accountNumberLast4: true } },
      },
    }),
    prisma.account.count({ where }),
  ])

  const asOf = asOfDate ? new Date(asOfDate) : undefined
  const fyStart = asOf
    ? fiscalYearStartFor(asOf, (await prisma.organization.findUnique({ where: { id: orgId }, select: { fiscalYearStart: true } }))?.fiscalYearStart ?? '01-01')
    : undefined

  const accountIds = accounts.map((a) => a.id)
  const [balances, ytdBalances] = await Promise.all([
    computeAccountBalances(prisma, orgId, accountIds, { branchId: branchId || undefined, toDate: asOf }),
    computeAccountBalances(prisma, orgId, accountIds, { branchId: branchId || undefined, fromDate: fyStart, toDate: asOf }),
  ])

  const data = accounts.map((a) => ({
    ...a,
    balance: balances.get(a.id)?.balance ?? 0,
    ytd: ytdBalances.get(a.id)?.balance ?? 0,
  }))

  res.json(paginatedResponse(data, total, page, limit))
})

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', requirePermission('accounts_create'), async (req: Request, res: Response) => {
  const body = createAccountSchema.parse(req.body)
  const orgId = req.user.organizationId

  assertNoControlManualPostingConflict(body.isControlAccount, body.allowManualPosting)
  await assertUniqueCode(prisma, orgId, body.code)
  await assertValidParent(prisma, orgId, body.parentId, body.accountClass)
  await assertTaxRateBelongsToOrg(orgId, body.defaultTaxRateId)

  const account = await prisma.account.create({
    data: {
      ...body,
      organizationId: orgId,
      normalBalance: normalBalanceForClass(body.accountClass),
      createdById: req.user.id,
    },
  })

  await logAudit(prisma, { req, action: 'account.created', module: 'accounts', resourceType: 'account', resourceId: account.id, resourceRef: account.code, newData: account })

  res.status(201).json(account)
})

// ── Single account ───────────────────────────────────────────────────────────
router.get('/:id', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const { branchId, asOfDate } = req.query as Record<string, string>

  const account = await prisma.account.findFirst({
    where: { id: req.params.id, organizationId: orgId },
    include: {
      parent: { select: { id: true, code: true, name: true } },
      children: { select: { id: true, code: true, name: true, status: true } },
      taxRate: true,
      bankAccount: true,
      mappings: true,
    },
  })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')

  const asOf = asOfDate ? new Date(asOfDate) : undefined
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { fiscalYearStart: true, currency: true } })
  const fyStart = fiscalYearStartFor(asOf ?? new Date(), org?.fiscalYearStart ?? '01-01')

  const [balance, ytd] = await Promise.all([
    computeAccountBalances(prisma, orgId, [account.id], { branchId: branchId || undefined, toDate: asOf }),
    computeAccountBalances(prisma, orgId, [account.id], { branchId: branchId || undefined, fromDate: fyStart, toDate: asOf }),
  ])

  res.json({
    ...accountSummaryShape(account),
    parent: account.parent,
    children: account.children,
    taxRate: account.taxRate,
    bankAccount: account.bankAccount,
    mappings: account.mappings,
    currency: org?.currency ?? 'SAR',
    balance: balance.get(account.id)?.balance ?? 0,
    ytdDebit: ytd.get(account.id)?.debit ?? 0,
    ytdCredit: ytd.get(account.id)?.credit ?? 0,
    ytdNet: ytd.get(account.id)?.balance ?? 0,
  })
})

router.patch('/:id', requirePermission('accounts_edit'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const existing = await prisma.account.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!existing) throw new AppError('Account not found', 404, 'NOT_FOUND')

  const body = updateAccountSchema.parse(req.body)

  if (existing.isSystem && body.accountClass && body.accountClass !== existing.accountClass) {
    throw new AppError('System accounts cannot change account class', 400, 'SYSTEM_ACCOUNT_PROTECTED')
  }

  const nextClass = body.accountClass ?? (existing.accountClass as AccountClass)
  const nextControl = body.isControlAccount ?? existing.isControlAccount
  const nextManualPosting = body.allowManualPosting ?? existing.allowManualPosting
  assertNoControlManualPostingConflict(nextControl, nextManualPosting)

  if (body.code && body.code !== existing.code) await assertUniqueCode(prisma, orgId, body.code, existing.id)
  if (body.parentId !== undefined) await assertValidParent(prisma, orgId, body.parentId, nextClass, existing.id)
  if (body.defaultTaxRateId !== undefined) await assertTaxRateBelongsToOrg(orgId, body.defaultTaxRateId ?? undefined)

  const updated = await prisma.account.update({
    where: { id: existing.id },
    data: {
      ...body,
      ...(body.accountClass ? { normalBalance: normalBalanceForClass(body.accountClass) } : {}),
    },
  })

  await logAudit(prisma, { req, action: 'account.edited', module: 'accounts', resourceType: 'account', resourceId: updated.id, resourceRef: updated.code, oldData: existing, newData: updated })

  res.json(updated)
})

router.post('/:id/archive', requirePermission('accounts_archive'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const account = await prisma.account.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')
  if (account.status === 'ARCHIVED') throw new AppError('Account is already archived', 400, 'ALREADY_ARCHIVED')

  const mapped = await prisma.accountingMapping.findFirst({ where: { organizationId: orgId, accountId: account.id } })
  if (mapped) throw new AppError('This account is used in Account Mappings — update the mapping before archiving', 400, 'ACCOUNT_MAPPED')

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { status: 'ARCHIVED', archivedAt: new Date(), archivedById: req.user.id },
  })

  await logAudit(prisma, { req, action: 'account.archived', module: 'accounts', resourceType: 'account', resourceId: account.id, resourceRef: account.code })
  res.json(updated)
})

router.post('/:id/restore', requirePermission('accounts_archive'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const account = await prisma.account.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')
  if (account.status === 'ACTIVE') throw new AppError('Account is not archived', 400, 'NOT_ARCHIVED')

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { status: 'ACTIVE', archivedAt: null, archivedById: null },
  })

  await logAudit(prisma, { req, action: 'account.restored', module: 'accounts', resourceType: 'account', resourceId: account.id, resourceRef: account.code })
  res.json(updated)
})

router.delete('/:id', requirePermission('accounts_delete_unused'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const account = await prisma.account.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')
  if (account.isSystem) throw new AppError('System accounts cannot be deleted', 400, 'SYSTEM_ACCOUNT_PROTECTED')

  const [lineCount, childCount, mappingCount, bankAccount] = await Promise.all([
    prisma.journalLine.count({ where: { accountId: account.id } }),
    prisma.account.count({ where: { parentId: account.id } }),
    prisma.accountingMapping.count({ where: { accountId: account.id } }),
    prisma.bankAccount.findUnique({ where: { accountId: account.id } }),
  ])
  if (lineCount > 0) throw new AppError('This account has journal activity and cannot be deleted — archive it instead', 400, 'HAS_JOURNAL_ACTIVITY')
  if (childCount > 0) throw new AppError('This account has sub-accounts and cannot be deleted', 400, 'HAS_CHILDREN')
  if (mappingCount > 0) throw new AppError('This account is used in Account Mappings and cannot be deleted', 400, 'ACCOUNT_MAPPED')
  if (bankAccount) throw new AppError('This account is linked to a bank account and cannot be deleted', 400, 'HAS_BANK_ACCOUNT')

  await prisma.account.delete({ where: { id: account.id } })
  await logAudit(prisma, { req, action: 'account.deleted', module: 'accounts', resourceType: 'account', resourceId: account.id, resourceRef: account.code })
  res.json({ message: 'Account deleted' })
})

router.get('/:id/ledger', requirePermission('accounts_view_ledger'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const { branchId, fromDate, toDate, sourceType, reference, page, limit } = req.query as Record<string, string>
  const { page: p, limit: l } = parsePageParams({ page, limit })

  const account = await prisma.account.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')

  const entryWhere: Record<string, unknown> = { organizationId: orgId, status: 'posted' }
  if (branchId) entryWhere.branchId = branchId
  if (sourceType) entryWhere.sourceType = sourceType
  if (reference) entryWhere.OR = [{ referenceId: reference }, { entryNo: { contains: reference, mode: 'insensitive' } }]
  if (fromDate || toDate) {
    entryWhere.entryDate = { ...(fromDate && { gte: new Date(fromDate) }), ...(toDate && { lte: new Date(toDate) }) }
  }

  // Running balance must reflect everything up to each page, so fetch every
  // matching line in date order rather than paginating the running-balance
  // computation itself, then slice the page after.
  const allLines = await prisma.journalLine.findMany({
    where: { accountId: account.id, journalEntry: entryWhere },
    include: {
      journalEntry: { select: { entryNo: true, entryDate: true, description: true, sourceType: true, referenceType: true, referenceId: true, branch: { select: { id: true, name: true } } } },
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
  })

  let running = 0
  const rows = allLines.map((l) => {
    const debit = Number(l.debitAmount)
    const credit = Number(l.creditAmount)
    running += account.normalBalance === 'DEBIT' ? debit - credit : credit - debit
    return {
      id: l.id,
      entryNo: l.journalEntry.entryNo,
      entryDate: l.journalEntry.entryDate,
      description: l.description || l.journalEntry.description,
      sourceType: l.journalEntry.sourceType,
      referenceType: l.journalEntry.referenceType,
      referenceId: l.journalEntry.referenceId,
      branch: l.journalEntry.branch,
      debitAmount: debit,
      creditAmount: credit,
      runningBalance: running,
    }
  })

  const total = rows.length
  const start = (p - 1) * l
  const page_rows = rows.slice(start, start + l)

  res.json({ ...paginatedResponse(page_rows, total, p, l), closingBalance: running, account })
})

router.get('/:id/balance', requirePermission('accounts_view_ledger'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const { branchId, asOfDate } = req.query as Record<string, string>

  const account = await prisma.account.findFirst({ where: { id: req.params.id, organizationId: orgId } })
  if (!account) throw new AppError('Account not found', 404, 'NOT_FOUND')

  const balances = await computeAccountBalances(prisma, orgId, [account.id], {
    branchId: branchId || undefined,
    toDate: asOfDate ? new Date(asOfDate) : undefined,
  })
  res.json(balances.get(account.id) ?? { debit: 0, credit: 0, balance: 0 })
})

router.get('/:id/audit', requirePermission('accounts_view'), async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const logs = await prisma.auditLog.findMany({
    where: { organizationId: orgId, resourceType: 'account', resourceId: req.params.id },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ data: logs })
})

router.post('/:id/reverse-journal/:journalEntryId', requirePermission('journals_reverse'), async (req: Request, res: Response) => {
  const { reason } = req.body as { reason?: string }
  if (!reason) throw new AppError('A reversal reason is required', 400, 'VALIDATION_ERROR')

  const reversal = await reverseJournalEntry(prisma, req.params.journalEntryId, req.user.id, reason)
  await logAudit(prisma, { req, action: 'journal.reversed', module: 'accounts', resourceType: 'journal_entry', resourceId: req.params.journalEntryId, newData: { reversalId: reversal.id, reason } })
  res.status(201).json(reversal)
})

export default router
