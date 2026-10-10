import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { nextNumber } from '../utils/numbering'
import { postJournalEntry, reverseJournalEntry } from '../utils/ledger'
import { logAudit } from '../utils/audit'

// Fixed-asset register with straight-line monthly depreciation.
// Depreciable amount = cost − salvage, spread evenly over usefulLifeMonths
// starting from the in-service month. Each asset-month is posted at most once
// (FixedAssetDepreciation unique [assetId, periodMonth] + journal sourceKey),
// so "Run depreciation" can be repeated safely. Assets brought in with
// accumulated depreciation already on the books (openingAccumulatedDepreciation)
// skip the months that amount already covers.

const router = Router()
router.use(authenticate)

const READ = requireAnyPermission('can_manage_accounting', 'accounts_view', 'can_post_journal', 'can_view_financial_reports')
const WRITE = requireAnyPermission('can_manage_accounting')

const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d))
const round2 = (n: number) => Math.round(n * 100) / 100
const monthKey = (d: Date) => d.toISOString().slice(0, 7)
const addMonths = (key: string, n: number) => {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return monthKey(d)
}
const monthEnd = (key: string) => {
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0, 12))
}
const monthsBetween = (from: string, to: string) => {
  const [fy, fm] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  return (ty - fy) * 12 + (tm - fm)
}

type AssetWithRows = Prisma.FixedAssetGetPayload<{ include: { depreciations: true } }>

function assetFigures(a: AssetWithRows) {
  const cost = num(a.cost)
  const depreciable = round2(cost - num(a.salvageValue))
  const monthly = a.usefulLifeMonths > 0 ? round2(depreciable / a.usefulLifeMonths) : 0
  const accumulated = num(a.accumulatedDepreciation)
  const posted = round2(a.depreciations.reduce((s, r) => s + num(r.amount), 0))
  const opening = round2(accumulated - posted)
  return { cost, depreciable, monthly, accumulated, opening, bookValue: round2(cost - accumulated), remaining: round2(depreciable - accumulated) }
}

// First month depreciation is charged in: the in-service month, pushed later
// by however many months the opening accumulated depreciation already covers.
function firstDepreciationMonth(a: AssetWithRows) {
  const f = assetFigures(a)
  const covered = f.monthly > 0 ? Math.round(f.opening / f.monthly) : 0
  return addMonths(monthKey(a.inServiceDate), covered)
}

async function defaultBranchId(orgId: string) {
  const b = await prisma.branch.findFirst({ where: { organizationId: orgId, isActive: true }, orderBy: { createdAt: 'asc' } })
  if (!b) throw new AppError('Create a branch first', 400, 'VALIDATION_ERROR')
  return b.id
}

async function loadAsset(req: Request, id: string) {
  const asset = await prisma.fixedAsset.findFirst({
    where: { id, organizationId: req.user.organizationId },
    include: { depreciations: { orderBy: { periodMonth: 'asc' } } },
  })
  if (!asset) throw new AppError('Fixed asset not found', 404, 'NOT_FOUND')
  return asset
}

async function assertPostableAccount(orgId: string, id: string, label: string) {
  const acc = await prisma.account.findFirst({ where: { id, organizationId: orgId } })
  if (!acc) throw new AppError(`${label} account not found`, 400, 'ACCOUNT_NOT_FOUND')
  if (acc.status !== 'ACTIVE') throw new AppError(`${label} account ${acc.code} is archived`, 400, 'ACCOUNT_ARCHIVED')
  if (acc.isControlAccount || !acc.allowManualPosting) {
    throw new AppError(`${label} account ${acc.code} — ${acc.name} is a control account; choose a posting account under it`, 400, 'CONTROL_ACCOUNT_POSTING')
  }
  return acc
}

function serialize(a: AssetWithRows, accounts: Map<string, { id: string; code: string; name: string }>) {
  const f = assetFigures(a)
  return {
    ...a,
    cost: f.cost,
    salvageValue: num(a.salvageValue),
    accumulatedDepreciation: f.accumulated,
    disposalProceeds: a.disposalProceeds == null ? null : num(a.disposalProceeds),
    monthlyDepreciation: f.monthly,
    openingAccumulatedDepreciation: f.opening,
    bookValue: f.bookValue,
    remainingDepreciation: Math.max(0, f.remaining),
    lastDepreciatedMonth: a.depreciations.length ? a.depreciations[a.depreciations.length - 1].periodMonth : null,
    assetAccount: accounts.get(a.assetAccountId) ?? null,
    accumulatedDepAccount: accounts.get(a.accumulatedDepAccountId) ?? null,
    depreciationExpenseAccount: accounts.get(a.depreciationExpenseAccountId) ?? null,
    depreciations: a.depreciations.map((r) => ({ ...r, amount: num(r.amount) })),
  }
}

async function accountMap(orgId: string, assets: AssetWithRows[]) {
  const ids = [...new Set(assets.flatMap((a) => [a.assetAccountId, a.accumulatedDepAccountId, a.depreciationExpenseAccountId]))]
  const accs = await prisma.account.findMany({ where: { organizationId: orgId, id: { in: ids } }, select: { id: true, code: true, name: true } })
  return new Map(accs.map((x) => [x.id, x]))
}

// ── List ───────────────────────────────────────────────────────────────
router.get('/', READ, async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined
  const assets = await prisma.fixedAsset.findMany({
    where: { organizationId: orgId, ...(status && { status }) },
    include: { depreciations: { orderBy: { periodMonth: 'asc' } } },
    orderBy: { assetNo: 'asc' },
  })
  const accounts = await accountMap(orgId, assets)
  const data = assets.map((a) => serialize(a, accounts))
  const live = data.filter((a) => a.status !== 'disposed')
  res.json({
    data,
    summary: {
      count: live.length,
      cost: round2(live.reduce((s, a) => s + a.cost, 0)),
      accumulatedDepreciation: round2(live.reduce((s, a) => s + a.accumulatedDepreciation, 0)),
      bookValue: round2(live.reduce((s, a) => s + a.bookValue, 0)),
      monthlyDepreciation: round2(live.filter((a) => a.status === 'active').reduce((s, a) => s + a.monthlyDepreciation, 0)),
    },
  })
})

router.get('/:id', READ, async (req: Request, res: Response) => {
  const asset = await loadAsset(req, req.params.id)
  const accounts = await accountMap(req.user.organizationId, [asset])
  res.json(serialize(asset, accounts))
})

// ── Create ─────────────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).optional().nullable(),
  branchId: z.string().optional().nullable(),
  purchaseDate: z.coerce.date(),
  inServiceDate: z.coerce.date().optional(),
  cost: z.number().positive(),
  salvageValue: z.number().min(0).default(0),
  usefulLifeMonths: z.number().int().min(1).max(600),
  assetAccountId: z.string().min(1),
  accumulatedDepAccountId: z.string().min(1),
  depreciationExpenseAccountId: z.string().min(1),
  // Existing asset already partly depreciated in the books before this register
  openingAccumulatedDepreciation: z.number().min(0).default(0),
  // Optional: also post the purchase (Dr asset account / Cr this account,
  // e.g. bank or accounts payable). Leave empty when the purchase was already
  // recorded through Purchasing/Expenses.
  acquisitionCreditAccountId: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
})

router.post('/', WRITE, async (req: Request, res: Response) => {
  const body = createSchema.parse(req.body)
  const orgId = req.user.organizationId
  if (body.salvageValue >= body.cost) throw new AppError('Salvage value must be less than the cost', 400, 'VALIDATION_ERROR')
  if (body.openingAccumulatedDepreciation > body.cost - body.salvageValue + 0.001) {
    throw new AppError('Opening accumulated depreciation cannot exceed cost minus salvage value', 400, 'VALIDATION_ERROR')
  }
  await assertPostableAccount(orgId, body.assetAccountId, 'Asset')
  await assertPostableAccount(orgId, body.accumulatedDepAccountId, 'Accumulated depreciation')
  await assertPostableAccount(orgId, body.depreciationExpenseAccountId, 'Depreciation expense')
  if (body.acquisitionCreditAccountId) await assertPostableAccount(orgId, body.acquisitionCreditAccountId, 'Paid-from')
  if (body.branchId) {
    const b = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: orgId } })
    if (!b) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  }

  const fullyDepreciated = Math.abs(body.cost - body.salvageValue - body.openingAccumulatedDepreciation) < 0.005
  const asset = await prisma.$transaction(async (tx) => {
    const assetNo = await nextNumber(tx as unknown as typeof prisma, 'fixedAsset', 'assetNo', 'FA', orgId)
    const created = await tx.fixedAsset.create({
      data: {
        organizationId: orgId,
        branchId: body.branchId || null,
        assetNo,
        name: body.name,
        category: body.category || null,
        purchaseDate: body.purchaseDate,
        inServiceDate: body.inServiceDate ?? body.purchaseDate,
        cost: body.cost,
        salvageValue: body.salvageValue,
        usefulLifeMonths: body.usefulLifeMonths,
        assetAccountId: body.assetAccountId,
        accumulatedDepAccountId: body.accumulatedDepAccountId,
        depreciationExpenseAccountId: body.depreciationExpenseAccountId,
        accumulatedDepreciation: body.openingAccumulatedDepreciation,
        status: fullyDepreciated ? 'fully_depreciated' : 'active',
        notes: body.notes || null,
        createdBy: req.user.id,
      },
    })
    if (body.acquisitionCreditAccountId) {
      const je = await postJournalEntry(tx as unknown as typeof prisma, {
        organizationId: orgId,
        branchId: body.branchId || (await defaultBranchId(orgId)),
        entryDate: body.purchaseDate,
        description: `Fixed asset purchase: ${assetNo} ${body.name}`,
        referenceType: 'fixed_asset',
        referenceId: created.id,
        sourceType: 'FIXED_ASSET',
        sourceKey: `FIXED_ASSET:${created.id}:ACQUISITION`,
        createdBy: req.user.id,
        lines: [
          { accountId: body.assetAccountId, description: body.name, debitAmount: body.cost },
          { accountId: body.acquisitionCreditAccountId, description: body.name, creditAmount: body.cost },
        ],
      })
      if (je) await tx.fixedAsset.update({ where: { id: created.id }, data: { acquisitionJournalEntryId: je.id } })
    }
    return created
  })

  await logAudit(prisma, { req, action: 'fixed_asset.created', module: 'accounts', resourceType: 'FixedAsset', resourceId: asset.id, resourceRef: asset.assetNo, newData: body })
  const full = await loadAsset(req, asset.id)
  res.status(201).json(serialize(full, await accountMap(orgId, [full])))
})

// ── Update ─────────────────────────────────────────────────────────────
// Descriptive fields can always change; the depreciation basis only until the
// first month has been posted (after that, dispose and re-register instead).
const updateSchema = createSchema.omit({ acquisitionCreditAccountId: true }).partial()

router.put('/:id', WRITE, async (req: Request, res: Response) => {
  const asset = await loadAsset(req, req.params.id)
  const body = updateSchema.parse(req.body)
  const orgId = req.user.organizationId
  if (asset.status === 'disposed') throw new AppError('A disposed asset cannot be edited', 400, 'INVALID_STATUS')

  const basisKeys = ['purchaseDate', 'inServiceDate', 'cost', 'salvageValue', 'usefulLifeMonths', 'assetAccountId', 'accumulatedDepAccountId', 'depreciationExpenseAccountId', 'openingAccumulatedDepreciation'] as const
  const changesBasis = basisKeys.some((k) => body[k] !== undefined)
  if (changesBasis && asset.depreciations.length > 0) {
    throw new AppError('Depreciation has already been posted for this asset, so its cost, life, dates and accounts are locked', 400, 'ASSET_LOCKED')
  }
  if (changesBasis && asset.acquisitionJournalEntryId && (body.cost !== undefined || body.assetAccountId !== undefined || body.purchaseDate !== undefined)) {
    throw new AppError('The purchase was posted to the ledger, so cost, purchase date and asset account are locked', 400, 'ASSET_LOCKED')
  }
  for (const [k, label] of [['assetAccountId', 'Asset'], ['accumulatedDepAccountId', 'Accumulated depreciation'], ['depreciationExpenseAccountId', 'Depreciation expense']] as const) {
    if (body[k]) await assertPostableAccount(orgId, body[k] as string, label)
  }
  const cost = body.cost ?? num(asset.cost)
  const salvage = body.salvageValue ?? num(asset.salvageValue)
  const opening = body.openingAccumulatedDepreciation ?? num(asset.accumulatedDepreciation)
  if (salvage >= cost) throw new AppError('Salvage value must be less than the cost', 400, 'VALIDATION_ERROR')
  if (opening > cost - salvage + 0.001) throw new AppError('Opening accumulated depreciation cannot exceed cost minus salvage value', 400, 'VALIDATION_ERROR')

  const { openingAccumulatedDepreciation, ...rest } = body
  const updated = await prisma.fixedAsset.update({
    where: { id: asset.id },
    data: {
      ...rest,
      branchId: body.branchId === undefined ? undefined : body.branchId || null,
      ...(openingAccumulatedDepreciation !== undefined && { accumulatedDepreciation: openingAccumulatedDepreciation }),
      ...(changesBasis && { status: Math.abs(cost - salvage - opening) < 0.005 ? 'fully_depreciated' : 'active' }),
    },
  })
  await logAudit(prisma, { req, action: 'fixed_asset.updated', module: 'accounts', resourceType: 'FixedAsset', resourceId: asset.id, resourceRef: asset.assetNo, newData: body })
  const full = await loadAsset(req, updated.id)
  res.json(serialize(full, await accountMap(orgId, [full])))
})

// ── Delete ─────────────────────────────────────────────────────────────
// Only a register mistake: no depreciation posted yet. A posted purchase
// entry is reversed rather than deleted.
router.delete('/:id', WRITE, async (req: Request, res: Response) => {
  const asset = await loadAsset(req, req.params.id)
  if (asset.depreciations.length > 0) throw new AppError('Depreciation has been posted for this asset — dispose of it instead', 400, 'ASSET_LOCKED')
  if (asset.status === 'disposed') throw new AppError('A disposed asset cannot be deleted', 400, 'INVALID_STATUS')
  if (asset.acquisitionJournalEntryId) {
    const je = await prisma.journalEntry.findUnique({ where: { id: asset.acquisitionJournalEntryId } })
    if (je && !je.reversedById) await reverseJournalEntry(prisma, je.id, req.user.id, `Fixed asset ${asset.assetNo} deleted`)
  }
  await prisma.fixedAsset.delete({ where: { id: asset.id } })
  await logAudit(prisma, { req, action: 'fixed_asset.deleted', module: 'accounts', resourceType: 'FixedAsset', resourceId: asset.id, resourceRef: asset.assetNo })
  res.json({ success: true })
})

// ── Run depreciation ───────────────────────────────────────────────────
// Posts every not-yet-posted month up to and including `throughMonth` for
// all active assets (or one asset). One journal entry per asset-month, dated
// the last day of that month.
const runSchema = z.object({
  throughMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
  assetId: z.string().optional(),
})

router.post('/depreciation/run', WRITE, async (req: Request, res: Response) => {
  const body = runSchema.parse(req.body)
  const orgId = req.user.organizationId
  if (body.throughMonth > monthKey(new Date())) throw new AppError('Depreciation cannot be posted for a future month', 400, 'VALIDATION_ERROR')

  const assets = await prisma.fixedAsset.findMany({
    where: { organizationId: orgId, status: 'active', ...(body.assetId && { id: body.assetId }) },
    include: { depreciations: { orderBy: { periodMonth: 'asc' } } },
    orderBy: { assetNo: 'asc' },
  })
  const fallbackBranch = assets.some((a) => !a.branchId) ? await defaultBranchId(orgId) : null

  const posted: { assetNo: string; month: string; amount: number; entryNo: string }[] = []
  const errors: { assetNo: string; month: string; message: string }[] = []

  for (const asset of assets) {
    const done = new Set(asset.depreciations.map((d) => d.periodMonth))
    const f = assetFigures(asset)
    let accumulated = f.accumulated
    let month = firstDepreciationMonth(asset)
    const lastLifeMonth = addMonths(monthKey(asset.inServiceDate), asset.usefulLifeMonths - 1)
    const span = monthsBetween(month, body.throughMonth)

    for (let i = 0; i <= span && accumulated < f.depreciable - 0.004; i++, month = addMonths(month, 1)) {
      if (done.has(month)) continue
      const remaining = round2(f.depreciable - accumulated)
      // Final month (end of life, or rounding left less than a month) takes the remainder
      const amount = month >= lastLifeMonth || remaining <= f.monthly + 0.004 ? remaining : f.monthly
      if (amount <= 0) break
      try {
        const je = await prisma.$transaction(async (tx) => {
          const entry = await postJournalEntry(tx as unknown as typeof prisma, {
            organizationId: orgId,
            branchId: asset.branchId ?? fallbackBranch!,
            entryDate: monthEnd(month),
            description: `Depreciation ${month}: ${asset.assetNo} ${asset.name}`,
            referenceType: 'fixed_asset',
            referenceId: asset.id,
            sourceType: 'DEPRECIATION',
            sourceKey: `DEPRECIATION:${asset.id}:${month}`,
            createdBy: req.user.id,
            lines: [
              { accountId: asset.depreciationExpenseAccountId, description: `${asset.assetNo} ${month}`, debitAmount: amount },
              { accountId: asset.accumulatedDepAccountId, description: `${asset.assetNo} ${month}`, creditAmount: amount },
            ],
          })
          await tx.fixedAssetDepreciation.create({ data: { assetId: asset.id, periodMonth: month, amount, journalEntryId: entry?.id } })
          const newAccumulated = round2(accumulated + amount)
          await tx.fixedAsset.update({
            where: { id: asset.id },
            data: { accumulatedDepreciation: newAccumulated, ...(newAccumulated >= f.depreciable - 0.004 && { status: 'fully_depreciated' }) },
          })
          return entry
        })
        accumulated = round2(accumulated + amount)
        posted.push({ assetNo: asset.assetNo, month, amount, entryNo: je?.entryNo ?? '' })
      } catch (err) {
        // e.g. a locked period — stop this asset here so months stay in order
        errors.push({ assetNo: asset.assetNo, month, message: err instanceof Error ? err.message : 'Failed' })
        break
      }
    }
  }

  if (posted.length) {
    await logAudit(prisma, { req, action: 'fixed_asset.depreciation_run', module: 'accounts', resourceType: 'FixedAsset', resourceRef: body.throughMonth, newData: { entries: posted.length, total: round2(posted.reduce((s, p) => s + p.amount, 0)) } })
  }
  res.json({ posted, errors, total: round2(posted.reduce((s, p) => s + p.amount, 0)) })
})

// ── Dispose ────────────────────────────────────────────────────────────
// Removes the asset from the books: Dr accumulated depreciation, Dr proceeds
// account (cash/bank), Cr asset at cost; the balancing figure is the gain
// (credit) or loss (debit) on disposal.
const disposeSchema = z.object({
  disposedAt: z.coerce.date(),
  proceeds: z.number().min(0).default(0),
  proceedsAccountId: z.string().optional().nullable(),
  gainLossAccountId: z.string().min(1),
  notes: z.string().max(1000).optional().nullable(),
})

router.post('/:id/dispose', WRITE, async (req: Request, res: Response) => {
  const asset = await loadAsset(req, req.params.id)
  const body = disposeSchema.parse(req.body)
  const orgId = req.user.organizationId
  if (asset.status === 'disposed') throw new AppError('This asset is already disposed', 400, 'INVALID_STATUS')
  if (body.proceeds > 0 && !body.proceedsAccountId) throw new AppError('Choose the account the sale proceeds went to', 400, 'VALIDATION_ERROR')
  if (body.proceedsAccountId) await assertPostableAccount(orgId, body.proceedsAccountId, 'Proceeds')
  await assertPostableAccount(orgId, body.gainLossAccountId, 'Gain/loss')
  const lastPosted = asset.depreciations.length ? asset.depreciations[asset.depreciations.length - 1].periodMonth : null
  if (lastPosted && lastPosted > monthKey(body.disposedAt)) {
    throw new AppError(`Depreciation is already posted through ${lastPosted}; the disposal date cannot be earlier`, 400, 'VALIDATION_ERROR')
  }

  const f = assetFigures(asset)
  const gainLoss = round2(body.proceeds + f.accumulated - f.cost) // + gain, − loss
  const label = `${asset.assetNo} ${asset.name}`
  const lines = [
    { accountId: asset.accumulatedDepAccountId, description: `Disposal ${label}`, debitAmount: f.accumulated },
    ...(body.proceeds > 0 ? [{ accountId: body.proceedsAccountId!, description: `Sale of ${label}`, debitAmount: body.proceeds }] : []),
    { accountId: asset.assetAccountId, description: `Disposal ${label}`, creditAmount: f.cost },
    ...(gainLoss > 0 ? [{ accountId: body.gainLossAccountId, description: `Gain on disposal ${label}`, creditAmount: gainLoss }] : []),
    ...(gainLoss < 0 ? [{ accountId: body.gainLossAccountId, description: `Loss on disposal ${label}`, debitAmount: -gainLoss }] : []),
  ]

  const result = await prisma.$transaction(async (tx) => {
    const je = await postJournalEntry(tx as unknown as typeof prisma, {
      organizationId: orgId,
      branchId: asset.branchId ?? (await defaultBranchId(orgId)),
      entryDate: body.disposedAt,
      description: `Fixed asset disposal: ${label}`,
      referenceType: 'fixed_asset',
      referenceId: asset.id,
      sourceType: 'FIXED_ASSET',
      sourceKey: `FIXED_ASSET:${asset.id}:DISPOSAL`,
      createdBy: req.user.id,
      lines,
    })
    return tx.fixedAsset.update({
      where: { id: asset.id },
      data: {
        status: 'disposed',
        disposedAt: body.disposedAt,
        disposalProceeds: body.proceeds,
        disposalJournalEntryId: je?.id,
        ...(body.notes && { notes: [asset.notes, `Disposal: ${body.notes}`].filter(Boolean).join('\n') }),
      },
    })
  })
  await logAudit(prisma, { req, action: 'fixed_asset.disposed', module: 'accounts', resourceType: 'FixedAsset', resourceId: asset.id, resourceRef: asset.assetNo, newData: { ...body, gainLoss } })
  res.json({ id: result.id, gainLoss })
})

export default router
