import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { Prisma, PrismaClient, RecurringJournal } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { postJournalEntry } from '../utils/ledger'
import { logAudit } from '../utils/audit'

// Recurring journal templates (rent, salary accruals, prepaid amortisation…).
// Occurrence n falls on startDate + n × frequency; occurrences that are due
// are posted automatically by the hourly runner (startRecurringJournalRunner)
// or straight away with "Post now". Each occurrence has sourceKey
// RECURRING:{id}:{YYYY-MM-DD}, so a retry or two servers racing can never
// post the same occurrence twice.

const router = Router()
router.use(authenticate)

const READ = requireAnyPermission('can_manage_accounting', 'accounts_view', 'can_post_journal', 'can_view_financial_reports')
const WRITE = requireAnyPermission('can_manage_accounting')

const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const
type Frequency = (typeof FREQUENCIES)[number]
const MAX_CATCH_UP = 36 // occurrences posted per template per run
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const round2 = (n: number) => Math.round(n * 100) / 100

interface TemplateLine { accountId: string; description?: string; debitAmount: number; creditAmount: number }

// Monthly-type steps keep the start date's day, clamped to short months
// (31 Jan → 28/29 Feb → 31 Mar).
export function occurrenceDate(start: Date, frequency: Frequency, n: number) {
  if (frequency === 'weekly') return new Date(start.getTime() + n * 7 * 86400000)
  const months = n * (frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12)
  const y = start.getUTCFullYear()
  const m = start.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(start.getUTCDate(), lastDay), 12))
}

// Posts one occurrence (the template's nextRunDate) and advances the template.
async function postOccurrence(db: PrismaClient, t: RecurringJournal, userId: string, entryDate?: Date) {
  const scheduled = t.nextRunDate
  const lines = t.lines as unknown as TemplateLine[]
  const je = await db.$transaction(async (tx) => {
    const entry = await postJournalEntry(tx as unknown as PrismaClient, {
      organizationId: t.organizationId,
      branchId: t.branchId,
      entryDate: entryDate ?? scheduled,
      description: t.description,
      referenceType: 'recurring_journal',
      referenceId: t.id,
      sourceType: 'RECURRING',
      sourceKey: `RECURRING:${t.id}:${ymd(scheduled)}`,
      createdBy: userId,
      lines: lines.map((l) => ({ accountId: l.accountId, description: l.description, debitAmount: l.debitAmount, creditAmount: l.creditAmount })),
    })
    const runCount = t.runCount + 1
    const next = occurrenceDate(t.startDate, t.frequency as Frequency, runCount)
    const finished = !!t.endDate && next > t.endDate
    await tx.recurringJournal.update({
      where: { id: t.id },
      data: { runCount, nextRunDate: next, lastRunAt: new Date(), lastError: null, ...(finished && { isActive: false }) },
    })
    return entry
  })
  return { scheduled, entryNo: je?.entryNo ?? null, journalEntryId: je?.id ?? null }
}

// Posts every due occurrence for every active template (optionally one org).
// A failing template (locked period, archived account) records lastError and
// is retried on the next run.
export async function runDueRecurringJournals(db: PrismaClient = prisma, organizationId?: string) {
  const now = new Date()
  const due = await db.recurringJournal.findMany({
    where: { isActive: true, nextRunDate: { lte: now }, ...(organizationId && { organizationId }) },
  })
  let posted = 0
  const failed: { id: string; name: string; message: string }[] = []
  for (let t of due) {
    for (let i = 0; i < MAX_CATCH_UP && t.isActive && t.nextRunDate <= now; i++) {
      if (t.endDate && t.nextRunDate > t.endDate) {
        await db.recurringJournal.update({ where: { id: t.id }, data: { isActive: false } })
        break
      }
      try {
        await postOccurrence(db, t, t.createdBy)
        posted++
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Posting failed'
        await db.recurringJournal.update({ where: { id: t.id }, data: { lastError: message } })
        failed.push({ id: t.id, name: t.name, message })
        break
      }
      const fresh = await db.recurringJournal.findUnique({ where: { id: t.id } })
      if (!fresh) break
      t = fresh
    }
  }
  return { posted, failed }
}

let runnerStarted = false
export function startRecurringJournalRunner() {
  if (runnerStarted) return
  runnerStarted = true
  const run = () => runDueRecurringJournals().then(
    (r) => { if (r.posted || r.failed.length) console.log(`[recurring journals] posted ${r.posted}, failed ${r.failed.length}`) },
    (err) => console.error('[recurring journals] run failed:', err)
  )
  setTimeout(run, 30_000).unref()
  setInterval(run, 60 * 60 * 1000).unref()
}

// ── Validation ─────────────────────────────────────────────────────────
const lineSchema = z.object({
  accountId: z.string().min(1),
  description: z.string().max(300).optional().nullable(),
  debitAmount: z.number().min(0).default(0),
  creditAmount: z.number().min(0).default(0),
})

const baseSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().min(1).max(300),
  branchId: z.string().min(1),
  frequency: z.enum(FREQUENCIES),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional().nullable(),
  lines: z.array(lineSchema).min(2),
  isActive: z.boolean().optional(),
})

async function validateTemplate(orgId: string, body: { branchId: string; lines: z.infer<typeof lineSchema>[]; startDate: Date; endDate?: Date | null }) {
  const branch = await prisma.branch.findFirst({ where: { id: body.branchId, organizationId: orgId } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (body.endDate && body.endDate < body.startDate) throw new AppError('End date must be after the start date', 400, 'VALIDATION_ERROR')

  const lines = body.lines
    .map((l) => ({ accountId: l.accountId, description: l.description?.trim() || undefined, debitAmount: round2(l.debitAmount), creditAmount: round2(l.creditAmount) }))
    .filter((l) => l.debitAmount > 0 || l.creditAmount > 0)
  if (lines.length < 2) throw new AppError('Add at least two lines with amounts', 400, 'VALIDATION_ERROR')
  if (lines.some((l) => l.debitAmount > 0 && l.creditAmount > 0)) throw new AppError('A line has either a debit or a credit, not both', 400, 'VALIDATION_ERROR')
  const dr = round2(lines.reduce((s, l) => s + l.debitAmount, 0))
  const cr = round2(lines.reduce((s, l) => s + l.creditAmount, 0))
  if (Math.abs(dr - cr) >= 0.01) throw new AppError(`Debits (${dr.toFixed(2)}) and credits (${cr.toFixed(2)}) must be equal`, 400, 'UNBALANCED_ENTRY')

  const ids = [...new Set(lines.map((l) => l.accountId))]
  const accounts = await prisma.account.findMany({ where: { organizationId: orgId, id: { in: ids } } })
  if (accounts.length !== ids.length) throw new AppError('One or more accounts were not found', 400, 'ACCOUNT_NOT_FOUND')
  const bad = accounts.find((a) => a.status !== 'ACTIVE' || a.isControlAccount || !a.allowManualPosting)
  if (bad) throw new AppError(`Account ${bad.code} — ${bad.name} cannot receive postings (archived or a control account)`, 400, 'CONTROL_ACCOUNT_POSTING')
  return { lines, total: dr }
}

async function serializeMany(orgId: string, rows: RecurringJournal[]) {
  const ids = [...new Set(rows.flatMap((r) => (r.lines as unknown as TemplateLine[]).map((l) => l.accountId)))]
  const [accounts, branches] = await Promise.all([
    prisma.account.findMany({ where: { organizationId: orgId, id: { in: ids } }, select: { id: true, code: true, name: true } }),
    prisma.branch.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } }),
  ])
  const accMap = new Map(accounts.map((a) => [a.id, a]))
  const brMap = new Map(branches.map((b) => [b.id, b]))
  return rows.map((r) => {
    const lines = (r.lines as unknown as TemplateLine[]).map((l) => ({ ...l, account: accMap.get(l.accountId) ?? null }))
    return { ...r, lines, branch: brMap.get(r.branchId) ?? null, amount: round2(lines.reduce((s, l) => s + l.debitAmount, 0)) }
  })
}

async function loadTemplate(req: Request, id: string) {
  const t = await prisma.recurringJournal.findFirst({ where: { id, organizationId: req.user.organizationId } })
  if (!t) throw new AppError('Recurring entry not found', 404, 'NOT_FOUND')
  return t
}

// ── Routes ─────────────────────────────────────────────────────────────
router.get('/', READ, async (req: Request, res: Response) => {
  const orgId = req.user.organizationId
  const rows = await prisma.recurringJournal.findMany({ where: { organizationId: orgId }, orderBy: [{ isActive: 'desc' }, { nextRunDate: 'asc' }] })
  res.json({ data: await serializeMany(orgId, rows) })
})

router.get('/:id', READ, async (req: Request, res: Response) => {
  const t = await loadTemplate(req, req.params.id)
  const [row] = await serializeMany(req.user.organizationId, [t])
  const history = await prisma.journalEntry.findMany({
    where: { organizationId: t.organizationId, sourceType: 'RECURRING', referenceId: t.id },
    select: { id: true, entryNo: true, entryDate: true, totalDebit: true, reversedById: true },
    orderBy: { entryDate: 'desc' },
    take: 50,
  })
  res.json({ ...row, history: history.map((h) => ({ ...h, totalDebit: Number(h.totalDebit) })) })
})

router.post('/', WRITE, async (req: Request, res: Response) => {
  const body = baseSchema.parse(req.body)
  const orgId = req.user.organizationId
  const { lines } = await validateTemplate(orgId, body)
  const created = await prisma.recurringJournal.create({
    data: {
      organizationId: orgId,
      branchId: body.branchId,
      name: body.name,
      description: body.description,
      frequency: body.frequency,
      startDate: body.startDate,
      nextRunDate: body.startDate,
      endDate: body.endDate ?? null,
      lines: lines as unknown as Prisma.InputJsonValue,
      isActive: body.isActive ?? true,
      createdBy: req.user.id,
    },
  })
  await logAudit(prisma, { req, action: 'recurring_journal.created', module: 'accounting', resourceType: 'RecurringJournal', resourceId: created.id, resourceRef: created.name, newData: body })
  // A start date today or earlier is posted right away rather than waiting for the hourly run
  if (created.isActive) await runDueRecurringJournals(prisma, orgId).catch(() => undefined)
  const [row] = await serializeMany(orgId, [await loadTemplate(req, created.id)])
  res.status(201).json(row)
})

// Schedule changes apply to occurrences not yet posted: the start date can
// only move once nothing has been posted; after that the series continues
// from its current next date.
router.put('/:id', WRITE, async (req: Request, res: Response) => {
  const t = await loadTemplate(req, req.params.id)
  const body = baseSchema.parse(req.body)
  const orgId = req.user.organizationId
  const { lines } = await validateTemplate(orgId, body)
  if (t.runCount > 0 && (body.frequency !== t.frequency || ymd(body.startDate) !== ymd(t.startDate))) {
    throw new AppError('This entry has already posted, so its start date and frequency are fixed. End it and create a new one instead.', 400, 'VALIDATION_ERROR')
  }
  const updated = await prisma.recurringJournal.update({
    where: { id: t.id },
    data: {
      name: body.name,
      description: body.description,
      branchId: body.branchId,
      frequency: body.frequency,
      startDate: body.startDate,
      ...(t.runCount === 0 && { nextRunDate: body.startDate }),
      endDate: body.endDate ?? null,
      lines: lines as unknown as Prisma.InputJsonValue,
      isActive: body.isActive ?? t.isActive,
      lastError: null,
    },
  })
  await logAudit(prisma, { req, action: 'recurring_journal.updated', module: 'accounting', resourceType: 'RecurringJournal', resourceId: t.id, resourceRef: t.name, newData: body })
  const [row] = await serializeMany(orgId, [updated])
  res.json(row)
})

router.patch('/:id/active', WRITE, async (req: Request, res: Response) => {
  const t = await loadTemplate(req, req.params.id)
  const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body)
  if (isActive && t.endDate && t.nextRunDate > t.endDate) throw new AppError('This entry has passed its end date — extend the end date first', 400, 'VALIDATION_ERROR')
  await prisma.recurringJournal.update({ where: { id: t.id }, data: { isActive, ...(isActive && { lastError: null }) } })
  await logAudit(prisma, { req, action: isActive ? 'recurring_journal.resumed' : 'recurring_journal.paused', module: 'accounting', resourceType: 'RecurringJournal', resourceId: t.id, resourceRef: t.name })
  res.json({ success: true })
})

// Posts the next scheduled occurrence immediately. A future occurrence is
// dated today (posting can't be future-dated); the schedule moves on by one.
router.post('/:id/post-now', WRITE, async (req: Request, res: Response) => {
  const t = await loadTemplate(req, req.params.id)
  if (!t.isActive) throw new AppError('Resume this recurring entry first', 400, 'INVALID_STATUS')
  if (t.endDate && t.nextRunDate > t.endDate) throw new AppError('This entry has passed its end date', 400, 'INVALID_STATUS')
  const now = new Date()
  try {
    const result = await postOccurrence(prisma, t, req.user.id, t.nextRunDate > now ? now : undefined)
    await logAudit(prisma, { req, action: 'recurring_journal.posted', module: 'accounting', resourceType: 'RecurringJournal', resourceId: t.id, resourceRef: result.entryNo ?? t.name })
    res.json(result)
  } catch (err) {
    if (err instanceof AppError) await prisma.recurringJournal.update({ where: { id: t.id }, data: { lastError: err.message } })
    throw err
  }
})

// Already-posted entries stay in the ledger (reverse them from the journal if needed)
router.delete('/:id', WRITE, async (req: Request, res: Response) => {
  const t = await loadTemplate(req, req.params.id)
  await prisma.recurringJournal.delete({ where: { id: t.id } })
  await logAudit(prisma, { req, action: 'recurring_journal.deleted', module: 'accounting', resourceType: 'RecurringJournal', resourceId: t.id, resourceRef: t.name })
  res.json({ success: true })
})

export default router
