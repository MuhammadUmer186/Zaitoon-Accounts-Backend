import { Router, Request, Response } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { parseImportFile } from '../utils/importFile'
import { postJournalEntry } from '../utils/ledger'
import { logAudit } from '../utils/audit'

// Bank reconciliation: import a bank statement (CSV/Excel) for a bank
// account, then match each statement line to the journal lines posted on
// that bank's ledger account. Signs: statement amount + = money in, − = money
// out; a ledger line's signed amount is debit − credit (a debit to a bank
// account is money in).

const router = Router()
router.use(authenticate)
router.use(requireAnyPermission('bank_accounts_manage', 'can_manage_accounting'))

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })
const DATE_WINDOW_DAYS = 7
const cents = (n: number) => Math.round(n * 100)
const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d))
const ymd = (d: Date) => d.toISOString().slice(0, 10)

async function loadBankAccount(req: Request, id: string) {
  const bank = await prisma.bankAccount.findFirst({
    where: { id, organizationId: req.user.organizationId },
    include: { account: { select: { id: true, code: true, name: true } } },
  })
  if (!bank) throw new AppError('Bank account not found', 404, 'NOT_FOUND')
  return bank
}

// Journal lines on the bank's ledger account that count for reconciliation:
// posted entries, excluding reversal pairs (an entry and its reversal cancel
// out and never appear on a bank statement).
const reconcilableLineWhere = (accountId: string, organizationId: string): Prisma.JournalLineWhereInput => ({
  accountId,
  journalEntry: { organizationId, status: 'posted', reversedById: null, reversalOfId: null },
})

function ledgerLineView(l: {
  id: string; debitAmount: Prisma.Decimal; creditAmount: Prisma.Decimal; description: string | null; statementLineId: string | null
  journalEntry: { entryNo: string; entryDate: Date; description: string }
}) {
  return {
    id: l.id,
    date: l.journalEntry.entryDate.toISOString(),
    entryNo: l.journalEntry.entryNo,
    description: l.description || l.journalEntry.description,
    amount: Math.round((num(l.debitAmount) - num(l.creditAmount)) * 100) / 100,
    statementLineId: l.statementLineId,
  }
}

// GET /bank-reconciliation/:bankAccountId — everything the page needs
router.get('/:bankAccountId', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const orgId = req.user.organizationId

  const [statementLines, unreconciled, totals] = await Promise.all([
    prisma.bankStatementLine.findMany({
      where: { bankAccountId: bank.id },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
      include: { journalLines: { include: { journalEntry: { select: { entryNo: true, entryDate: true, description: true } } } } },
    }),
    prisma.journalLine.findMany({
      where: { ...reconcilableLineWhere(bank.accountId, orgId), statementLineId: null },
      include: { journalEntry: { select: { entryNo: true, entryDate: true, description: true } } },
      orderBy: { journalEntry: { entryDate: 'desc' } },
      take: 1000,
    }),
    prisma.journalLine.aggregate({
      where: { accountId: bank.accountId, journalEntry: { organizationId: orgId, status: 'posted' } },
      _sum: { debitAmount: true, creditAmount: true },
    }),
  ])

  const bookBalance = Math.round((num(totals._sum.debitAmount) - num(totals._sum.creditAmount)) * 100) / 100
  const withBalance = statementLines.find((l) => l.balance != null) // newest line that carries a running balance
  const statementBalance = withBalance ? num(withBalance.balance) : null
  const sum = (xs: number[]) => Math.round(xs.reduce((s, n) => s + n, 0) * 100) / 100

  const ledger = unreconciled.map(ledgerLineView)
  const unmatchedStatement = statementLines.filter((l) => l.status === 'unmatched')
  const excludedStatement = statementLines.filter((l) => l.status === 'excluded')

  // Book balance should equal: statement balance − statement items not in the
  // books (unmatched + excluded) + book items not yet on the statement.
  const statementNotInBooks = sum([...unmatchedStatement, ...excludedStatement].map((l) => num(l.amount)))
  const booksNotOnStatement = sum(ledger.map((l) => l.amount))
  const adjustedStatement = statementBalance == null ? null : Math.round((statementBalance - statementNotInBooks + booksNotOnStatement) * 100) / 100

  res.json({
    bankAccount: { id: bank.id, bankName: bank.bankName, accountTitle: bank.accountTitle, accountNumberLast4: bank.accountNumberLast4, currency: bank.currency, ledgerAccount: bank.account },
    summary: {
      bookBalance,
      statementBalance,
      statementBalanceDate: withBalance ? withBalance.date.toISOString() : null,
      unmatchedCount: unmatchedStatement.length,
      unmatchedAmount: sum(unmatchedStatement.map((l) => num(l.amount))),
      excludedCount: excludedStatement.length,
      unreconciledDeposits: sum(ledger.filter((l) => l.amount > 0).map((l) => l.amount)),
      unreconciledPayments: sum(ledger.filter((l) => l.amount < 0).map((l) => l.amount)),
      unreconciledCount: ledger.length,
      adjustedStatementBalance: adjustedStatement,
      difference: adjustedStatement == null ? null : Math.round((bookBalance - adjustedStatement) * 100) / 100,
      lastImportAt: statementLines.reduce<Date | null>((m, l) => (!m || l.createdAt > m ? l.createdAt : m), null)?.toISOString() ?? null,
    },
    statementLines: statementLines.map((l) => ({
      id: l.id,
      date: l.date.toISOString(),
      description: l.description,
      reference: l.reference,
      amount: num(l.amount),
      balance: l.balance == null ? null : num(l.balance),
      status: l.status,
      importBatch: l.importBatch,
      matchedLines: l.journalLines.map((jl) => ledgerLineView({ ...jl, journalEntry: jl.journalEntry })),
    })),
    ledgerLines: ledger,
  })
})

// ── Import ──────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const HEADERS = {
  date: ['date', 'transactiondate', 'valuedate', 'postingdate', 'txndate', 'bookingdate'],
  description: ['description', 'details', 'narration', 'particulars', 'memo', 'transactiondetails', 'remarks', 'transactiondescription'],
  reference: ['reference', 'ref', 'referenceno', 'referencenumber', 'chequeno', 'cheque', 'transactionid', 'transactionref'],
  amount: ['amount', 'transactionamount', 'amountsar'],
  out: ['debit', 'withdrawal', 'withdrawals', 'moneyout', 'paidout', 'dr', 'debitamount', 'debitsar'],
  in: ['credit', 'deposit', 'deposits', 'moneyin', 'paidin', 'cr', 'creditamount', 'creditsar'],
  balance: ['balance', 'runningbalance', 'closingbalance', 'availablebalance', 'balancesar'],
}

function findColumn(headers: string[], names: string[]) {
  return headers.find((h) => names.includes(norm(h)))
}

function parseAmount(raw: string | undefined): number | null {
  if (raw == null) return null
  let s = String(raw).trim()
  if (!s) return null
  const negative = /^\(.*\)$/.test(s) || /-/.test(s.replace(/^[^0-9-]*/, '').slice(0, 1)) || /\bdr\b/i.test(s)
  s = s.replace(/[^0-9.]/g, '')
  if (!s) return null
  const n = Number(s)
  if (isNaN(n)) return null
  return negative ? -n : n
}

// Accepts ISO dates, dd/mm/yyyy (Saudi bank exports), and Excel date cells
function parseDate(raw: string | undefined): Date | null {
  if (!raw) return null
  const s = String(raw).trim()
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (dmy) {
    let [, d, m, y] = dmy.map(Number) as unknown as [number, number, number, number]
    if (y < 100) y += 2000
    if (m > 12 && d <= 12) [d, m] = [m, d] // clearly mm/dd
    const dt = new Date(Date.UTC(y, m - 1, d))
    return isNaN(dt.getTime()) ? null : dt
  }
  const t = Date.parse(s)
  if (isNaN(t)) return null
  const local = new Date(t)
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
}

router.post('/:bankAccountId/import', memoryUpload.single('file'), async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  if (!req.file) throw new AppError('Choose a bank statement file (CSV or Excel)', 400, 'VALIDATION_ERROR')
  const rows = await parseImportFile(req.file)
  if (rows.length === 0) throw new AppError('The statement file has no rows', 400, 'VALIDATION_ERROR')

  const headers = Object.keys(rows[0])
  const col = {
    date: findColumn(headers, HEADERS.date),
    description: findColumn(headers, HEADERS.description),
    reference: findColumn(headers, HEADERS.reference),
    amount: findColumn(headers, HEADERS.amount),
    out: findColumn(headers, HEADERS.out),
    in: findColumn(headers, HEADERS.in),
    balance: findColumn(headers, HEADERS.balance),
  }
  if (!col.date || (!col.amount && !col.out && !col.in)) {
    throw new AppError(
      `Couldn't find the columns. The file needs a Date column and either an Amount column or Debit/Credit (Withdrawal/Deposit) columns. Found: ${headers.join(', ')}`,
      400, 'INVALID_IMPORT'
    )
  }

  const existing = await prisma.bankStatementLine.findMany({
    where: { bankAccountId: bank.id },
    select: { date: true, amount: true, description: true, reference: true },
  })
  const key = (d: Date, amount: number, desc: string, ref: string | null) => `${ymd(d)}|${cents(amount)}|${desc.trim().toLowerCase()}|${(ref ?? '').trim().toLowerCase()}`
  const seen = new Set(existing.map((e) => key(e.date, num(e.amount), e.description, e.reference)))

  const batch = `${req.file.originalname} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
  const toCreate: Prisma.BankStatementLineCreateManyInput[] = []
  const problems: string[] = []
  let duplicates = 0

  rows.forEach((r, i) => {
    const rowNo = i + 2
    const date = parseDate(r[col.date!])
    if (!date) { problems.push(`Row ${rowNo}: unreadable date "${r[col.date!]}"`); return }
    let amount: number | null
    if (col.amount) amount = parseAmount(r[col.amount])
    else {
      const out = parseAmount(r[col.out!]) ?? 0
      const inn = parseAmount(r[col.in!]) ?? 0
      amount = Math.abs(inn) - Math.abs(out)
    }
    if (amount == null || cents(amount) === 0) { problems.push(`Row ${rowNo}: no amount`); return }
    const description = (col.description ? r[col.description] : '') || '(no description)'
    const reference = col.reference ? r[col.reference] || null : null
    const k = key(date, amount, description, reference)
    if (seen.has(k)) { duplicates++; return }
    seen.add(k)
    const balance = col.balance ? parseAmount(r[col.balance]) : null
    toCreate.push({
      organizationId: req.user.organizationId, bankAccountId: bank.id, importBatch: batch, date,
      description: description.slice(0, 500), reference, amount: Math.round(amount * 100) / 100,
      balance: balance == null ? null : Math.round(balance * 100) / 100,
    })
  })

  if (toCreate.length > 0) await prisma.bankStatementLine.createMany({ data: toCreate })
  await logAudit(prisma, { req, action: 'bank_statement.imported', module: 'accounts', resourceType: 'bank_account', resourceId: bank.id, newData: { batch, imported: toCreate.length, duplicates } })

  res.status(201).json({ imported: toCreate.length, duplicates, skipped: problems.length, problems: problems.slice(0, 10), batch })
})

// DELETE /bank-reconciliation/:bankAccountId/batch?name= — undo an import
// (only lines that haven't been matched yet).
router.delete('/:bankAccountId/batch', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const name = String(req.query.name ?? '')
  if (!name) throw new AppError('Import batch name is required', 400, 'VALIDATION_ERROR')
  const { count } = await prisma.bankStatementLine.deleteMany({ where: { bankAccountId: bank.id, importBatch: name, status: { not: 'matched' } } })
  const kept = await prisma.bankStatementLine.count({ where: { bankAccountId: bank.id, importBatch: name } })
  res.json({ deleted: count, keptMatched: kept })
})

// ── Matching ────────────────────────────────────────────────────────────────

router.post('/:bankAccountId/auto-match', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const [lines, ledgerRaw] = await Promise.all([
    prisma.bankStatementLine.findMany({ where: { bankAccountId: bank.id, status: 'unmatched' }, orderBy: { date: 'asc' } }),
    prisma.journalLine.findMany({
      where: { ...reconcilableLineWhere(bank.accountId, req.user.organizationId), statementLineId: null },
      include: { journalEntry: { select: { entryNo: true, entryDate: true, description: true } } },
    }),
  ])
  const ledger = ledgerRaw.map(ledgerLineView)
  const claimed = new Set<string>()
  const pairs: { statementLineId: string; journalLineId: string }[] = []

  for (const sl of lines) {
    const amt = cents(num(sl.amount))
    const candidates = ledger.filter((l) => !claimed.has(l.id) && cents(l.amount) === amt &&
      Math.abs(new Date(l.date).getTime() - sl.date.getTime()) <= DATE_WINDOW_DAYS * 86_400_000)
    if (candidates.length !== 1) continue // ambiguous or nothing — leave for manual matching
    // the ledger line must not be an equally good fit for another statement line
    const rivals = lines.filter((o) => o.id !== sl.id && o.status === 'unmatched' && cents(num(o.amount)) === amt &&
      Math.abs(new Date(candidates[0].date).getTime() - o.date.getTime()) <= DATE_WINDOW_DAYS * 86_400_000 &&
      !pairs.some((p) => p.statementLineId === o.id))
    if (rivals.length > 0) continue
    claimed.add(candidates[0].id)
    pairs.push({ statementLineId: sl.id, journalLineId: candidates[0].id })
  }

  await prisma.$transaction(async (tx) => {
    for (const p of pairs) {
      await tx.journalLine.update({ where: { id: p.journalLineId }, data: { statementLineId: p.statementLineId } })
      await tx.bankStatementLine.update({ where: { id: p.statementLineId }, data: { status: 'matched', matchedAt: new Date(), matchedBy: req.user.id } })
    }
  })
  res.json({ matched: pairs.length, remaining: lines.length - pairs.length })
})

const matchSchema = z.object({ statementLineId: z.string(), journalLineIds: z.array(z.string()).min(1) })

router.post('/:bankAccountId/match', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const body = matchSchema.parse(req.body)
  const sl = await prisma.bankStatementLine.findFirst({ where: { id: body.statementLineId, bankAccountId: bank.id } })
  if (!sl) throw new AppError('Statement line not found', 404, 'NOT_FOUND')
  if (sl.status !== 'unmatched') throw new AppError('This statement line is already matched or excluded', 400, 'INVALID_STATUS')

  const jls = await prisma.journalLine.findMany({
    where: { id: { in: body.journalLineIds }, ...reconcilableLineWhere(bank.accountId, req.user.organizationId), statementLineId: null },
  })
  if (jls.length !== body.journalLineIds.length) throw new AppError('Some selected book transactions are not available to match', 400, 'VALIDATION_ERROR')
  const total = jls.reduce((s, l) => s + num(l.debitAmount) - num(l.creditAmount), 0)
  if (cents(total) !== cents(num(sl.amount))) {
    throw new AppError(`Amounts don't agree: statement ${num(sl.amount).toFixed(2)} vs selected ${total.toFixed(2)}`, 400, 'AMOUNT_MISMATCH')
  }

  await prisma.$transaction([
    prisma.journalLine.updateMany({ where: { id: { in: body.journalLineIds } }, data: { statementLineId: sl.id } }),
    prisma.bankStatementLine.update({ where: { id: sl.id }, data: { status: 'matched', matchedAt: new Date(), matchedBy: req.user.id } }),
  ])
  res.json({ ok: true })
})

const lineSchema = z.object({ statementLineId: z.string() })

router.post('/:bankAccountId/unmatch', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const { statementLineId } = lineSchema.parse(req.body)
  const sl = await prisma.bankStatementLine.findFirst({ where: { id: statementLineId, bankAccountId: bank.id } })
  if (!sl) throw new AppError('Statement line not found', 404, 'NOT_FOUND')
  await prisma.$transaction([
    prisma.journalLine.updateMany({ where: { statementLineId: sl.id }, data: { statementLineId: null } }),
    prisma.bankStatementLine.update({ where: { id: sl.id }, data: { status: 'unmatched', matchedAt: null, matchedBy: null } }),
  ])
  res.json({ ok: true })
})

router.post('/:bankAccountId/exclude', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const body = lineSchema.extend({ excluded: z.boolean() }).parse(req.body)
  const sl = await prisma.bankStatementLine.findFirst({ where: { id: body.statementLineId, bankAccountId: bank.id } })
  if (!sl) throw new AppError('Statement line not found', 404, 'NOT_FOUND')
  if (sl.status === 'matched') throw new AppError('Unmatch the line before excluding it', 400, 'INVALID_STATUS')
  await prisma.bankStatementLine.update({ where: { id: sl.id }, data: { status: body.excluded ? 'excluded' : 'unmatched' } })
  res.json({ ok: true })
})

// Post a journal entry for a bank-only item (charges, profit, transfers)
// straight from the statement line, and match it.
const createEntrySchema = z.object({ statementLineId: z.string(), accountId: z.string(), description: z.string().optional() })

router.post('/:bankAccountId/create-entry', async (req: Request, res: Response) => {
  const bank = await loadBankAccount(req, req.params.bankAccountId)
  const body = createEntrySchema.parse(req.body)
  const orgId = req.user.organizationId
  const sl = await prisma.bankStatementLine.findFirst({ where: { id: body.statementLineId, bankAccountId: bank.id } })
  if (!sl) throw new AppError('Statement line not found', 404, 'NOT_FOUND')
  if (sl.status !== 'unmatched') throw new AppError('This statement line is already matched or excluded', 400, 'INVALID_STATUS')
  const contra = await prisma.account.findFirst({ where: { id: body.accountId, organizationId: orgId, status: 'ACTIVE' } })
  if (!contra) throw new AppError('Account not found', 404, 'NOT_FOUND')
  if (contra.id === bank.accountId) throw new AppError('Choose an account other than the bank account itself', 400, 'VALIDATION_ERROR')

  const branchId = bank.branchId ?? (await prisma.branch.findFirst({ where: { organizationId: orgId, isActive: true }, orderBy: { createdAt: 'asc' } }))?.id
  if (!branchId) throw new AppError('Create a branch first', 400, 'VALIDATION_ERROR')

  const amount = Math.abs(num(sl.amount))
  const moneyIn = num(sl.amount) > 0
  const description = body.description?.trim() || sl.description

  const entry = await prisma.$transaction(async (tx) => {
    const je = await postJournalEntry(tx as unknown as typeof prisma, {
      organizationId: orgId,
      branchId,
      entryDate: sl.date,
      referenceType: 'bank_statement_line',
      referenceId: sl.id,
      sourceType: 'BANK_REC',
      sourceKey: `BANK_REC:${sl.id}`,
      description: `Bank: ${description}`,
      createdBy: req.user.id,
      lines: moneyIn
        ? [{ accountId: bank.accountId, description, debitAmount: amount }, { accountId: contra.id, description, creditAmount: amount }]
        : [{ accountId: contra.id, description, debitAmount: amount }, { accountId: bank.accountId, description, creditAmount: amount }],
    })
    if (!je) throw new AppError('Could not post the entry', 500, 'POST_FAILED')
    await tx.journalLine.updateMany({ where: { journalEntryId: je.id, accountId: bank.accountId }, data: { statementLineId: sl.id } })
    await tx.bankStatementLine.update({ where: { id: sl.id }, data: { status: 'matched', matchedAt: new Date(), matchedBy: req.user.id } })
    return je
  })
  res.status(201).json({ journalEntryId: entry.id })
})

export default router
