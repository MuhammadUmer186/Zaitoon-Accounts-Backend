import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireModule } from '../middleware/authorize'
import { branchFilter } from '../utils/branchScope'
import { paginatedResponse } from '../utils/pagination'
import { paymentStatus, spendSummary, SpendRow } from '../services/spendRegister'
import { AppError } from '../middleware/error'

const router = Router()
router.use(authenticate, requireModule('expenses', 'purchasing', 'approvals'))
router.get('/', async (req: Request, res: Response) => {
  const q = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    kind: z.enum(['purchase', 'expense', 'maintenance', 'payment']).optional(),
    status: z.enum(['draft', 'submitted', 'approved', 'unpaid', 'partial', 'paid', 'void']).optional(),
    branchId: z.string().optional(), categoryId: z.string().optional(),
    fromDate: z.iso.date().optional(), toDate: z.iso.date().optional(),
  }).parse(req.query)
  const { page, limit } = q
  if (q.fromDate && q.toDate && q.fromDate > q.toDate) throw new AppError('Start date must be before end date', 400, 'VALIDATION_ERROR')
  const branchId = await branchFilter(req, q.branchId)
  const base = { organizationId: req.user.organizationId, ...(branchId && { branchId }) }
  const dates: { gte?: Date; lt?: Date } = {}
  if (q.fromDate) dates.gte = new Date(q.fromDate)
  if (q.toDate) { dates.lt = new Date(q.toDate); dates.lt.setUTCDate(dates.lt.getUTCDate() + 1) }
  if (Object.values(dates).some(d => !Number.isFinite(d.getTime()))) throw new AppError('Invalid date filter', 400, 'VALIDATION_ERROR')
  const hasDates = Object.keys(dates).length > 0
  // Maintenance entries are operating expenses; the "maintenance" filter narrows to just them.
  const expenseWhere: Prisma.ExpenseWhereInput = { ...base, source: { not: 'purchasing' }, ...(hasDates && { expenseDate: dates }), ...(q.categoryId && { categoryId: q.categoryId }) }
  const billWhere: Prisma.BillWhereInput = { ...base, source: 'purchasing', ...(hasDates && { billDate: dates }), ...(q.categoryId && { categoryId: q.categoryId }) }
  if (q.status === 'void') { expenseWhere.status = 'void'; billWhere.status = 'void' }
  else { expenseWhere.status = { not: 'void' }; billWhere.status = { not: 'void' } }
  const [billTotals, expenseTotals, paidExpenseTotals, dueExpenseTotals, maintenanceTotals] = await Promise.all([
    prisma.bill.aggregate({ where: { ...billWhere, status: { in: ['approved', 'partial', 'paid'] } }, _sum: { totalAmount: true, paidAmount: true, balanceDue: true } }),
    prisma.expense.aggregate({ where: { ...expenseWhere, status: 'approved' }, _sum: { totalAmount: true } }),
    prisma.expense.aggregate({ where: { ...expenseWhere, status: 'approved', supplierId: null }, _sum: { totalAmount: true } }),
    prisma.expense.aggregate({ where: { ...expenseWhere, status: 'approved', supplierId: { not: null } }, _sum: { totalAmount: true } }),
    prisma.expense.aggregate({ where: { ...expenseWhere, source: 'maintenance', status: 'approved' }, _sum: { totalAmount: true } }),
  ])
  const summary = spendSummary({ total: billTotals._sum.totalAmount ?? 0, paid: billTotals._sum.paidAmount ?? 0, due: billTotals._sum.balanceDue ?? 0 },
    { total: expenseTotals._sum.totalAmount ?? 0, paid: paidExpenseTotals._sum.totalAmount ?? 0, due: dueExpenseTotals._sum.totalAmount ?? 0 },
    maintenanceTotals._sum.totalAmount ?? 0)
  if (q.kind === 'maintenance') expenseWhere.source = 'maintenance'
  const take = page * limit
  if (q.kind === 'payment') {
    const voidReceipts = await prisma.expense.findMany({ where: { ...base, source: 'purchasing', status: 'void', paymentId: { not: null } }, select: { paymentId: true } })
    const where: Prisma.PaymentWhereInput = { ...base, id: { notIn: voidReceipts.map(e => e.paymentId!) }, bill: { source: 'purchasing', status: { not: 'void' }, ...(q.categoryId && { categoryId: q.categoryId }) }, ...(hasDates && { paymentDate: dates }) }
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }], include: { bill: { include: { supplier: true, branch: true, category: true } } } }),
      prisma.payment.count({ where }),
    ])
    const rows: SpendRow[] = payments.map(p => ({ id: p.id, kind: 'payment', reference: p.bill.billNo, date: p.paymentDate, branchId: p.branchId,
      branchName: p.bill.branch.name, categoryName: p.bill.category?.name ?? '', description: `${p.bill.supplier.name} · ${p.paymentMethod} · ${p.paidBy ?? ''}`,
      totalAmount: p.amount, paidAmount: p.amount, balanceDue: 0, approvalStatus: 'approved', paymentStatus: 'paid', href: `/expenses/purchases/${p.billId}` }))
    return res.json({ ...paginatedResponse(rows, total, page, limit), summary })
  }
  if (q.status && q.status !== 'void') {
    if (['draft', 'submitted'].includes(q.status)) { expenseWhere.status = q.status; billWhere.id = '__none__' }
    else if (['unpaid', 'partial', 'paid'].includes(q.status)) {
      billWhere.status = q.status === 'unpaid' ? 'approved' : q.status
      expenseWhere.status = 'approved'
      if (q.status === 'partial') expenseWhere.id = '__none__'
      else expenseWhere.supplierId = q.status === 'paid' ? null : { not: null }
    } else if (q.status === 'approved') expenseWhere.status = 'approved'
    else throw new AppError('Invalid status filter', 400, 'VALIDATION_ERROR')
  }
  const includeBills = q.kind !== 'expense' && q.kind !== 'maintenance'
  const includeExpenses = q.kind !== 'purchase'
  const [bills, expenses, billCount, expenseCount] = await Promise.all([
    includeBills ? prisma.bill.findMany({ where: billWhere, take, orderBy: [{ billDate: 'desc' }, { id: 'desc' }], include: { supplier: true, branch: true, category: true } }) : [],
    includeExpenses ? prisma.expense.findMany({ where: expenseWhere, take, orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }], include: { branch: true, category: true } }) : [],
    includeBills ? prisma.bill.count({ where: billWhere }) : 0,
    includeExpenses ? prisma.expense.count({ where: expenseWhere }) : 0,
  ])
  const rows: SpendRow[] = [
    ...bills.map(b => ({ id: b.id, kind: 'purchase' as const, reference: b.billNo, date: b.billDate, branchId: b.branchId,
      branchName: b.branch.name, categoryName: b.category?.name ?? '', description: b.supplier.name,
      totalAmount: b.totalAmount, paidAmount: b.paidAmount, balanceDue: b.balanceDue,
      approvalStatus: b.status === 'void' ? 'void' : 'approved', paymentStatus: paymentStatus(b.totalAmount, b.paidAmount), href: `/expenses/purchases/${b.id}` })),
    ...expenses.map(e => ({ id: e.id, kind: e.source === 'maintenance' ? 'maintenance' as const : 'expense' as const, reference: e.expenseNo, date: e.expenseDate, branchId: e.branchId,
      branchName: e.branch.name, categoryName: e.category.name, description: e.description,
      totalAmount: e.totalAmount, paidAmount: e.status === 'approved' && !e.supplierId ? e.totalAmount : 0,
      balanceDue: e.status === 'approved' && e.supplierId ? e.totalAmount : 0,
      approvalStatus: e.status, paymentStatus: e.status !== 'approved' ? '—' : e.supplierId ? 'unpaid' : 'paid', href: `/expenses/${e.id}` })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime() || b.id.localeCompare(a.id) || b.kind.localeCompare(a.kind))
  res.json({ ...paginatedResponse(rows.slice((page - 1) * limit, page * limit), billCount + expenseCount, page, limit), summary })
})
export default router
