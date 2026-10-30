import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../config';
import { authenticate } from '../middleware/auth';
import { requirePermission, requireAnyPermission } from '../middleware/authorize';
import { AppError } from '../middleware/error';
import { logAudit } from '../utils/audit';
import { publish } from '../utils/liveEvents';
import { getUserPermissions } from '../utils/permissions';
import { getBranchScope } from '../utils/branchScope';
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod } from '../utils/ledger';
import { UPLOAD_ROOT } from '../middleware/upload';
import { hrRegisters, hrCatalog, registerSchema } from '../services/hrCatalog';
import { assertCodeSeries } from '../utils/branchNumbering';
import { checkedUpload, isImmutableMedia } from '../services/branchMedia';
import { HrTx, asData, attendanceSchema, employeeSchema, hrBranch, hrEmployee, hrLock, hrScope, assertHrPeriodOpen, enforceHrApproval, validateRegister, registerReference, periodRange, dateOnly, datesBetween, calculatePayroll, money, hrAccount, ledgerDb, postHrPayment, payrollRelevantKinds } from '../services/hr';
const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
router.use(authenticate, async (req, _res, next) => {
    if (!await prisma.user.count({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } } }))
        throw new AppError('Account inactive', 401, 'TOKEN_INVALID');
    next();
}, requireAnyPermission('can_view_hr', 'can_view_payroll'));
router.use((req, res, next) => {
    if (req.method !== 'GET')
        res.on('finish', () => {
            if (res.statusCode < 400)
                publish({ topic: 'hr', action: 'changed', organizationId: req.user.organizationId });
        });
    next();
});
const payrollKinds = new Set(['salary-structures', 'components', 'loans', 'reimbursements', 'benefits', 'commissions', 'settlements']);
const notes = z.string().trim().min(3).max(1000);
const employeeSelect = { id: true, code: true, firstName: true, lastName: true };
const querySchema = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(25), search: z.string().trim().max(100).optional(), status: z.string().max(40).optional(), from: z.string().date().optional(), to: z.string().date().optional() });
const pageQuery = (req: Request) => querySchema.parse(req.query);
const audit = (tx: HrTx, req: Request, action: string, resourceType: string, resourceId: string, branchId?: string) => logAudit(tx, { req, action, module: 'hr', resourceType, resourceId, branchId });
const transaction = <T>(req: Request, fn: (tx: HrTx) => Promise<T>) => prisma.$transaction(async (tx) => { await hrLock(tx, req.user.organizationId); return fn(tx); }, { timeout: 30000 });
async function demand(req: Request, permission: string) {
    if (!(await getUserPermissions(prisma, req.user.id)).permissions.has(permission))
        throw new AppError('You do not have permission for this HR operation', 403, 'FORBIDDEN');
}
async function registerFor(req: Request, write = false) {
    const r = hrCatalog.get(req.params.kind);
    if (!r)
        throw new AppError('HR register not found', 404, 'NOT_FOUND');
    await demand(req, r.key === 'approval-rules' ? 'can_configure_hr' : payrollKinds.has(r.key) ? write ? 'can_process_payroll' : 'can_view_payroll' : write ? 'can_manage_hr' : 'can_view_hr');
    return r;
}
async function recordFor(req: Request, tx: HrTx) {
    const r = await tx.hrRecord.findFirst({ where: { id: req.params.id, kind: req.params.kind, ...(await hrScope(req)) } });
    if (!r)
        throw new AppError('HR record not found', 404, 'NOT_FOUND');
    return r;
}
const optimistic = (actual: number, expected?: number) => { if (expected !== actual)
    throw new AppError('This record changed. Refresh it before saving.', 409, 'VERSION_CONFLICT'); };
const findRun = async (req: Request, tx: HrTx) => {
    const run = await tx.hrPayrollRun.findFirst({ where: { id: req.params.id, ...(await hrScope(req)) }, include: { lines: { include: { payments: true }, orderBy: { employeeCode: 'asc' } } } });
    if (!run)
        throw new AppError('Payroll run not found', 404, 'NOT_FOUND');
    return run;
};
router.get('/catalog', async (req, res) => {
    const { permissions } = await getUserPermissions(prisma, req.user.id);
    res.json({ registers: hrRegisters.filter(r => permissions.has(r.key === 'approval-rules' ? 'can_configure_hr' : payrollKinds.has(r.key) ? 'can_view_payroll' : 'can_view_hr')), permissions: [...permissions].filter(p => p.includes('hr') || p.includes('payroll') || p === 'can_pay_salaries') });
});
router.get('/lookups', async (req, res) => {
    const scope = await hrScope(req);
    const access = await getBranchScope(req);
    const { permissions } = await getUserPermissions(prisma, req.user.id);
    const [employees, records, branches, roles] = await Promise.all([
        prisma.hrEmployee.findMany({ where: scope, select: { ...employeeSelect, branchId: true, status: true }, orderBy: { code: 'asc' }, take: 2000 }),
        prisma.hrRecord.findMany({ where: { ...scope, kind: { in: ['departments', 'designations', 'shifts', 'leave-types', ...(permissions.has('can_view_payroll') ? ['salary-structures'] : [])] }, status: 'active' }, select: { id: true, kind: true, title: true, branchId: true }, orderBy: { title: 'asc' }, take: 2000 }),
        prisma.branch.findMany({ where: { organizationId: scope.organizationId, ...(access.restricted && { id: { in: access.branchIds } }), isActive: true }, select: { id: true, name: true } }),
        permissions.has('can_configure_hr') ? prisma.role.findMany({ where: { organizationId: scope.organizationId }, select: { id: true, displayName: true } }) : [],
    ]);
    res.json({ employees, records, branches, roles });
});
router.get('/overview', requirePermission('can_view_hr'), async (req, res) => {
    const scope = await hrScope(req);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { timezone: true } });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const from = new Date(today.slice(0, 7) + '-01'), to = new Date(today);
    const [employees, attendance, leavePending, recordsPending, recent, departments] = await Promise.all([
        prisma.hrEmployee.groupBy({ by: ['status'], where: scope, _count: true }),
        prisma.hrAttendance.groupBy({ by: ['status'], where: { ...scope, date: to }, _count: true }),
        prisma.hrLeaveRequest.count({ where: { ...scope, status: 'submitted' } }),
        prisma.hrRecord.count({ where: { ...scope, status: 'submitted', kind: { notIn: [...payrollKinds] } } }),
        prisma.hrEmployee.findMany({ where: scope, select: { ...employeeSelect, joiningDate: true, status: true }, orderBy: { createdAt: 'desc' }, take: 6 }),
        prisma.hrEmployee.groupBy({ by: ['departmentId'], where: { ...scope, status: { in: ['active', 'probation'] } }, _count: true }),
    ]);
    const [trend, exits, joined] = await Promise.all([
        prisma.hrAttendance.groupBy({ by: ['date', 'status'], where: { ...scope, date: { gte: from, lte: to } }, _count: true, orderBy: { date: 'asc' } }),
        prisma.hrEmployee.count({ where: { ...scope, exitDate: { gte: from, lte: to } } }),
        prisma.hrEmployee.count({ where: { ...scope, joiningDate: { gte: from, lte: to } } }),
    ]);
    const activeWhere = { ...scope, status: { in: ['active', 'probation'] }, joiningDate: { lte: to }, OR: [{ exitDate: null }, { exitDate: { gte: to } }] };
    const [serviceDates, employmentTypes, activeHeadcount, pendingRegisters] = await Promise.all([
        prisma.hrEmployee.findMany({ where: scope, select: { joiningDate: true, exitDate: true } }),
        prisma.hrEmployee.groupBy({ by: ['employmentType'], where: activeWhere, _count: true }),
        prisma.hrEmployee.count({ where: activeWhere }),
        prisma.hrRecord.groupBy({ by: ['kind'], where: { ...scope, status: 'submitted', kind: { notIn: [...payrollKinds] } }, _count: true }),
    ]);
    const annualTrend = Array.from({ length: 12 }, (_, i) => {
        const start = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11 + i, 1)), end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
        const cutoff = end > to ? to : end;
        return { month: dateOnly(start).slice(0, 7), joined: serviceDates.filter(e => e.joiningDate >= start && e.joiningDate <= cutoff).length, exited: serviceDates.filter(e => e.exitDate && e.exitDate >= start && e.exitDate <= cutoff).length, headcount: serviceDates.filter(e => e.joiningDate <= cutoff && (!e.exitDate || e.exitDate >= cutoff)).length };
    });
    res.json({ today, employees, attendance, leavePending, recordsPending, recent, departments, trend, exits, joined, annualTrend, employmentTypes, activeHeadcount, pendingRegisters });
});
router.get('/employees', requirePermission('can_view_hr'), async (req, res) => {
    const q = pageQuery(req), scope = await hrScope(req), { permissions } = await getUserPermissions(prisma, req.user.id);
    const where: Prisma.HrEmployeeWhereInput = { ...scope, ...(q.status && { status: q.status }), ...(q.search && { OR: ['code', 'firstName', 'lastName', 'email'].map(key => ({ [key]: { contains: q.search, mode: 'insensitive' } })) }) };
    const [rows, total] = await Promise.all([prisma.hrEmployee.findMany({ where, include: { branch: { select: { name: true } } }, orderBy: { code: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }), prisma.hrEmployee.count({ where })]);
    res.json({ data: rows.map(e => permissions.has('can_view_payroll') ? e : { ...e, basicSalary: undefined, salaryStructureId: undefined }), total, page: q.page, limit: q.limit });
});
async function saveEmployee(req: Request, res: Response, editing: boolean) {
    const body = employeeSchema.parse(req.body);
    const employee = await transaction(req, async (tx) => {
        await hrBranch(req, body.branchId, tx);
        const old = editing ? await hrEmployee(req, req.params.id, tx) : null;
        if (old) {
            optimistic(old.version, body.version);
            if (old.branchId !== body.branchId)
                throw new AppError('Use Employee Transfers to change branches', 400);
            if (old.status === 'exited')
                throw new AppError('Exited employees cannot be edited', 409);
        }
        const canPay = (await getUserPermissions(tx, req.user.id)).permissions.has('can_process_payroll');
        if (!canPay && ((body.basicSalary !== undefined && Number(body.basicSalary) !== Number(old?.basicSalary ?? 0)) || (body.salaryStructureId !== undefined && body.salaryStructureId !== (old?.salaryStructureId ?? null))))
            throw new AppError('Payroll permission is required to change salary details', 403);
        if (old && (old.joiningDate.toISOString().slice(0, 10) !== body.joiningDate)) {
            if (await tx.hrPayrollLine.count({ where: { employeeId: old.id } }) || await tx.hrAttendance.count({ where: { employeeId: old.id } }))
                throw new AppError('Joining date cannot change after attendance or payroll is recorded', 409);
        }
        for (const [id, kind] of [[body.departmentId, 'departments'], [body.designationId, 'designations'], [body.salaryStructureId, 'salary-structures']])
            await registerReference(tx, req, id, kind!, body.branchId);
        const { version: _version, joiningDate, ...data } = body;
        if (!canPay) {
            delete data.basicSalary;
            delete data.salaryStructureId;
        }
        if (data.code !== undefined && (!old || old.code !== data.code))
            await assertCodeSeries(tx, req.user.organizationId, String(data.code));
        const e = old ? await tx.hrEmployee.update({ where: { id: old.id }, data: { ...data, joiningDate: new Date(joiningDate), version: { increment: 1 } } }) : await tx.hrEmployee.create({ data: { ...data, joiningDate: new Date(joiningDate), organizationId: req.user.organizationId, createdBy: req.user.id } });
        await audit(tx, req, old ? 'update' : 'create', 'hr_employee', e.id, e.branchId);
        return e;
    });
    const canViewPay = (await getUserPermissions(prisma, req.user.id)).permissions.has('can_view_payroll');
    res.status(editing ? 200 : 201).json(canViewPay ? employee : { ...employee, basicSalary: undefined, salaryStructureId: undefined });
}
router.post('/employees', requirePermission('can_manage_hr'), (req, res) => saveEmployee(req, res, false));
router.put('/employees/:id', requirePermission('can_manage_hr'), (req, res) => saveEmployee(req, res, true));
router.get('/records/:kind', async (req, res) => {
    await registerFor(req);
    const q = pageQuery(req), scope = await hrScope(req);
    const where: Prisma.HrRecordWhereInput = { ...scope, kind: req.params.kind, ...(q.status && { status: q.status }), ...(q.search && { title: { contains: q.search, mode: 'insensitive' } }), ...((q.from || q.to) && { date: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }) };
    const [data, total] = await Promise.all([prisma.hrRecord.findMany({ where, include: { employee: { select: employeeSelect } }, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: [{ date: 'desc' }, { id: 'desc' }] }), prisma.hrRecord.count({ where })]);
    res.json({ data: data.map(r => ({ ...r, data: { ...asData(r.data), filePath: undefined } })), total, page: q.page, limit: q.limit });
});
async function saveRegister(req: Request, res: Response, editing: boolean) {
    const register = await registerFor(req, true), body = registerSchema(register).parse(req.body);
    const record = await transaction(req, async (tx) => {
        const old = editing ? await recordFor(req, tx) : null;
        if (old) {
            optimistic(old.version, body.version);
            if (!['draft', 'active'].includes(old.status))
                throw new AppError('Only draft or active configuration records can be edited', 409);
            if (old.branchId !== body.branchId)
                throw new AppError('Create a new register entry to change branches', 400);
            if (payrollRelevantKinds.has(register.key))
                await assertHrPeriodOpen(tx, req.user.organizationId, old.branchId, old.date, old.employeeId);
        }
        await validateRegister(tx, req, register, body, old?.id);
        if (['departments', 'designations', 'shifts', 'leave-types', 'salary-structures'].includes(register.key) && await tx.hrRecord.count({ where: { organizationId: req.user.organizationId, branchId: body.branchId, kind: register.key, title: { equals: body.title, mode: 'insensitive' }, status: { not: 'archived' }, ...(old && { id: { not: old.id } }) } }))
            throw new AppError('An active record with this name already exists', 409);
        const data = { title: body.title, branchId: body.branchId, employeeId: body.employeeId || null, date: new Date(body.date), amount: body.amount, data: { ...body.data, ...(old && asData(old.data).filePath ? { filePath: asData(old.data).filePath, fileName: asData(old.data).fileName } : {}) } as Prisma.InputJsonValue };
        const r = old ? await tx.hrRecord.update({ where: { id: old.id }, data: { ...data, version: { increment: 1 } } }) : await tx.hrRecord.create({ data: { ...data, organizationId: req.user.organizationId, kind: register.key, status: register.approval ? 'draft' : 'active', createdBy: req.user.id } });
        await audit(tx, req, old ? 'update' : 'create', `hr_${register.key}`, r.id, r.branchId);
        return { ...r, data: { ...asData(r.data), filePath: undefined } };
    });
    res.status(editing ? 200 : 201).json(record);
}
router.post('/records/:kind', (req, res) => saveRegister(req, res, false));
router.put('/records/:kind/:id', (req, res) => saveRegister(req, res, true));
router.post('/records/:kind/:id/action', async (req, res) => {
    const register = await registerFor(req);
    const body = z.object({ action: z.enum(['submit', 'approve', 'reject', 'archive', 'cancel', 'disburse', 'recover', 'stop']), version: z.number().int().positive(), reason: notes.optional(), amount: z.number().finite().positive().max(100000000).optional(), paymentDate: z.string().date().optional(), endDate: z.string().date().optional(), method: z.enum(['cash', 'bank_transfer']).optional(), reference: z.string().trim().min(1).max(200).optional() }).strict().parse(req.body);
    const approving = ['approve', 'reject'].includes(body.action);
    await demand(req, ['disburse', 'recover'].includes(body.action) ? 'can_pay_salaries' : register.key === 'approval-rules' ? 'can_configure_hr' : approving ? 'can_approve_hr' : payrollKinds.has(register.key) ? 'can_process_payroll' : 'can_manage_hr');
    const updated = await transaction(req, async (tx) => {
        const r = await recordFor(req, tx), d = asData(r.data);
        optimistic(r.version, body.version);
        if (payrollRelevantKinds.has(r.kind) && !['stop', 'recover'].includes(body.action))
            await assertHrPeriodOpen(tx, r.organizationId, r.branchId, r.date, r.employeeId);
        let status: string;
        if (body.action === 'stop' && r.status === 'approved' && d.recurrence === 'monthly') {
            if (!body.endDate || body.endDate < dateOnly(r.date))
                throw new AppError('Choose an end date on or after the effective date', 400);
            const next = new Date(+new Date(body.endDate) + 86400000);
            const sealed = await tx.hrPayrollRun.count({ where: { organizationId: r.organizationId, OR: [{ branchId: r.branchId }, ...(r.employeeId ? [{ lines: { some: { employeeId: r.employeeId } } }] : [])], status: { in: ['approved', 'paid'] }, period: { gte: dateOnly(next).slice(0, 7) } } });
            if (sealed)
                throw new AppError('This end date would change approved payroll. Choose a date after the last approved month.', 409);
            if (d.endDate && body.endDate > String(d.endDate))
                throw new AppError('A stopped component cannot be extended. Create a new component.', 400);
            await tx.hrRecord.update({ where: { id: r.id }, data: { data: { ...d, endDate: body.endDate } as Prisma.InputJsonValue } });
            status = r.status;
        }
        else if (body.action === 'recover' && r.kind === 'loans' && r.status === 'paid') {
            if (!body.amount || money(body.amount) !== body.amount || body.amount > money(Number(r.amount) - Number(r.recoveredAmount)))
                throw new AppError('Enter a repayment no larger than the remaining loan balance', 400);
            if (!body.paymentDate || new Date(body.paymentDate) < new Date(String(d.disbursedAt ?? dateOnly(r.date))) || !body.method || !body.reference)
                throw new AppError('Repayment date, method and transaction reference are required; repayment cannot precede disbursement', 400);
            const settings = await tx.hrSettings.findUnique({ where: { organizationId: r.organizationId } });
            const receivable = await hrAccount(tx, r.organizationId, settings?.employeeReceivableAccountId, 'employee receivable', 'ASSET');
            const cash = await resolveMappedAccount(ledgerDb(tx), r.organizationId, mappingKeyForPaymentMethod(body.method));
            if (cash.id === receivable.id)
                throw new AppError('Payment and receivable accounts must differ', 400);
            const entry = await postJournalEntry(ledgerDb(tx), { organizationId: r.organizationId, branchId: r.branchId, entryDate: new Date(body.paymentDate), description: `Employee loan repayment · ${r.title} · ${body.reference}`, referenceType: 'hr_loan_repayment', referenceId: r.id, sourceKey: `HR:LOAN:${r.id}:RECOVERY:${r.version}`, createdBy: req.user.id, lines: [{ accountId: cash.id, debitAmount: body.amount }, { accountId: receivable.id, creditAmount: body.amount }] });
            const repayments = Array.isArray(d.repayments) ? d.repayments : [];
            await tx.hrRecord.update({ where: { id: r.id }, data: { recoveredAmount: { increment: body.amount }, data: { ...d, repayments: [...repayments, { amount: body.amount, method: body.method, date: body.paymentDate, reference: body.reference, journalEntryId: entry?.id }] } as Prisma.InputJsonValue } });
            status = r.status;
        }
        else if (body.action === 'submit' && register.approval && r.status === 'draft')
            status = 'submitted';
        else if (approving && r.status === 'submitted' && register.approval) {
            if (body.action === 'reject' && !body.reason)
                throw new AppError('Enter a rejection reason', 400);
            await enforceHrApproval(req, tx, r.kind, r.branchId, r.createdBy, Number(r.amount));
            status = body.action === 'approve' ? 'approved' : 'rejected';
            if (status === 'approved') {
                await validateRegister(tx, req, register, { branchId: r.branchId, employeeId: r.employeeId, date: dateOnly(r.date), amount: Number(r.amount), data: d }, r.id);
                if (r.kind === 'clearance' && d.assetsReturned === 'no')
                    throw new AppError('Return outstanding assets before approving clearance', 400);
                if (r.kind === 'transfers') {
                    const employee = await hrEmployee(req, r.employeeId!, tx);
                    if (employee.branchId !== r.branchId)
                        throw new AppError('Employee has already moved. Create a new transfer.', 409);
                    const org = await tx.organization.findUniqueOrThrow({ where: { id: r.organizationId } });
                    const today = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(new Date());
                    if (dateOnly(r.date) !== today)
                        throw new AppError('Approve a transfer on its effective date', 400);
                    await hrBranch(req, String(d.destinationBranchId), tx);
                    if (d.destinationBranchId === r.branchId)
                        throw new AppError('Choose a different destination branch', 400);
                    await tx.hrRecord.update({ where: { id: r.id }, data: { data: { ...d, sourceBasicSalary: String(employee.basicSalary), sourceSalaryStructureId: employee.salaryStructureId, sourceDepartmentId: employee.departmentId, sourceDesignationId: employee.designationId } as Prisma.InputJsonValue } });
                    // Destination references belong to the destination, not the source.
                    await tx.hrEmployee.update({ where: { id: employee.id }, data: { branchId: String(d.destinationBranchId), departmentId: d.departmentId ? String(d.departmentId) : null, designationId: d.designationId ? String(d.designationId) : null, salaryStructureId: null, version: { increment: 1 } } });
                }
                if (r.kind === 'resignations') {
                    const e = await hrEmployee(req, r.employeeId!, tx);
                    if (e.status === 'exited')
                        throw new AppError('Employee is already exited', 409);
                    await tx.hrEmployee.update({ where: { id: e.id }, data: { exitDate: new Date(String(d.lastWorkingDate)), version: { increment: 1 } } });
                }
                if (r.kind === 'settlements') {
                    const e = await hrEmployee(req, r.employeeId!, tx);
                    if (!e.exitDate || e.exitDate > r.date)
                        throw new AppError('Approve resignation and reach the last working date first', 400);
                    const clear = await tx.hrRecord.findMany({ where: { organizationId: r.organizationId, employeeId: e.id, kind: 'clearance' } });
                    if (!clear.length || clear.some(c => c.status !== 'approved'))
                        throw new AppError('Complete all employee clearance approvals first', 409);
                    const loans = await tx.hrRecord.findMany({ where: { organizationId: r.organizationId, employeeId: e.id, kind: 'loans', status: 'paid' } });
                    if (loans.some(l => Number(l.recoveredAmount) < Number(l.amount)))
                        throw new AppError('Resolve outstanding loans before final settlement', 400);
                    await tx.hrEmployee.update({ where: { id: e.id }, data: { status: 'exited', version: { increment: 1 } } });
                }
            }
        }
        else if (body.action === 'archive' && r.status === 'active' && !register.approval) {
            if (r.kind === 'leave-types' && await tx.hrLeaveRequest.count({ where: { leaveTypeId: r.id, status: 'submitted' } }))
                throw new AppError('Resolve pending leave requests before archiving this leave type', 409);
            if (['departments', 'designations', 'salary-structures'].includes(r.kind) && await tx.hrEmployee.count({ where: { organizationId: r.organizationId, OR: [{ departmentId: r.id }, { designationId: r.id }, { salaryStructureId: r.id }] } }))
                throw new AppError('This record is assigned to employees. Reassign them first.', 409);
            status = 'archived';
        }
        else if (body.action === 'cancel' && ['draft', 'submitted'].includes(r.status))
            status = 'cancelled';
        else if (body.action === 'disburse' && r.kind === 'loans' && r.status === 'approved') {
            if (!body.method || !body.reference || !body.paymentDate || new Date(body.paymentDate) < r.date)
                throw new AppError('Payment method, payment date and transaction reference are required; payment cannot precede the effective date', 400);
            const settings = await tx.hrSettings.findUnique({ where: { organizationId: r.organizationId } });
            const account = await hrAccount(tx, r.organizationId, settings?.employeeReceivableAccountId, 'employee receivable', 'ASSET');
            const entry = await postHrPayment(tx, req, { branchId: r.branchId, amount: Number(r.amount), method: body.method, date: new Date(body.paymentDate), debitAccountId: account.id, referenceId: r.id, sourceKey: `HR:LOAN:${r.id}`, description: `Employee ${r.kind}: ${r.title} · ${body.reference}` });
            await tx.hrRecord.update({ where: { id: r.id }, data: { data: { ...d, disbursedAt: body.paymentDate, paymentReference: body.reference, paymentMethod: body.method, journalEntryId: entry.id } as Prisma.InputJsonValue } });
            status = 'paid';
        }
        else
            throw new AppError('This action is not allowed in the current state', 409, 'INVALID_STATUS');
        const result = await tx.hrRecord.update({ where: { id: r.id }, data: { status, version: { increment: 1 }, ...(approving && { approvedBy: req.user.id, approvedAt: new Date(), rejectionReason: body.reason ?? null }) } });
        await audit(tx, req, body.action, `hr_${r.kind}`, r.id, r.branchId);
        return { ...result, data: { ...asData(result.data), filePath: undefined } };
    });
    res.json(updated);
});
router.get('/attendance', requirePermission('can_view_hr'), async (req, res) => {
    const q = pageQuery(req), where = { ...(await hrScope(req)), ...(q.status && { status: q.status }), ...((q.from || q.to) && { date: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }), ...(q.search && { employee: { OR: [{ code: { contains: q.search, mode: 'insensitive' as const } }, { firstName: { contains: q.search, mode: 'insensitive' as const } }] } }) };
    const [data, total] = await Promise.all([prisma.hrAttendance.findMany({ where, include: { employee: { select: employeeSelect } }, orderBy: { date: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), prisma.hrAttendance.count({ where })]);
    res.json({ data, total, page: q.page, limit: q.limit });
});
async function attendanceInput(tx: HrTx, req: Request, body: z.infer<typeof attendanceSchema>, source = 'manual') {
    const e = await hrEmployee(req, body.employeeId, tx), date = new Date(body.date);
    if (date < e.joiningDate || (e.exitDate && date > e.exitDate))
        throw new AppError('Attendance date falls outside employee service', 400);
    await assertHrPeriodOpen(tx, req.user.organizationId, e.branchId, date, e.id);
    if (body.checkIn) {
        const org = await tx.organization.findUniqueOrThrow({ where: { id: req.user.organizationId }, select: { timezone: true } });
        const local = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(body.checkIn));
        if (local !== body.date)
            throw new AppError('Check-in must fall on the attendance date in the restaurant timezone', 400);
    }
    const { version: _version, checkIn, checkOut, ...data } = body;
    return { ...data, organizationId: req.user.organizationId, branchId: e.branchId, date, checkIn: checkIn ? new Date(checkIn) : null, checkOut: checkOut ? new Date(checkOut) : null, source, createdBy: req.user.id };
}
router.post('/attendance', requirePermission('can_manage_hr'), async (req, res) => {
    const body = attendanceSchema.parse(req.body);
    res.status(201).json(await transaction(req, async (tx) => {
        const a = await tx.hrAttendance.create({ data: await attendanceInput(tx, req, body) });
        await audit(tx, req, 'create', 'hr_attendance', a.id, a.branchId);
        return a;
    }));
});
router.put('/attendance/:id', requirePermission('can_manage_hr'), async (req, res) => {
    const body = attendanceSchema.parse(req.body);
    res.json(await transaction(req, async (tx) => {
        const old = await tx.hrAttendance.findFirst({ where: { id: req.params.id, ...(await hrScope(req)) } });
        if (!old)
            throw new AppError('Attendance not found', 404);
        optimistic(old.version, body.version);
        await assertHrPeriodOpen(tx, old.organizationId, old.branchId, old.date, old.employeeId);
        const data = await attendanceInput(tx, req, body);
        if (old.employeeId !== body.employeeId)
            throw new AppError('Attendance cannot be reassigned to another employee', 400);
        const a = await tx.hrAttendance.update({ where: { id: old.id }, data: { ...data, createdBy: old.createdBy, version: { increment: 1 } } });
        await audit(tx, req, 'update', 'hr_attendance', a.id, a.branchId);
        return a;
    }));
});
router.post('/attendance/import', requirePermission('can_manage_hr'), async (req, res) => {
    const body = z.object({ branchId: z.string().min(1), rows: z.array(z.object({ employeeCode: z.string().trim().min(1), date: z.string().date(), status: z.enum(['present', 'absent', 'late', 'half_day', 'holiday', 'rest_day']), checkIn: z.string().optional().nullable(), checkOut: z.string().optional().nullable() }).strict()).min(1).max(1000) }).strict().parse(req.body);
    res.json(await transaction(req, async (tx) => {
        await hrBranch(req, body.branchId, tx);
        let imported = 0, skipped = 0;
        for (const [index, row] of body.rows.entries()) {
            const e = await tx.hrEmployee.findFirst({ where: { organizationId: req.user.organizationId, branchId: body.branchId, code: row.employeeCode } });
            if (!e)
                throw new AppError(`Row ${index + 2}: employee code ${row.employeeCode} was not found in this branch`, 400);
            const b = attendanceSchema.parse({ employeeId: e.id, date: row.date, status: row.status, checkIn: row.checkIn || null, checkOut: row.checkOut || null });
            const data = await attendanceInput(tx, req, b, 'file_import');
            if (await tx.hrAttendance.count({ where: { employeeId: e.id, date: data.date } })) {
                skipped++;
                continue;
            }
            await tx.hrAttendance.create({ data });
            imported++;
        }
        await audit(tx, req, 'import', 'hr_attendance', crypto.randomUUID(), body.branchId);
        return { imported, skipped, deviceConnected: false };
    }));
});
const leaveSchema = z.object({ employeeId: z.string().min(1), leaveTypeId: z.string().min(1), startDate: z.string().date(), endDate: z.string().date(), reason: notes }).strict();
async function validateLeave(tx: HrTx, req: Request, body: z.infer<typeof leaveSchema>, ignoreId?: string) {
    const e = await hrEmployee(req, body.employeeId, tx), start = new Date(body.startDate), end = new Date(body.endDate);
    if (end < start || body.startDate.slice(0, 4) !== body.endDate.slice(0, 4))
        throw new AppError('Leave must be a valid range within one calendar year; split requests across years', 400);
    if (start < e.joiningDate || (e.exitDate && end > e.exitDate))
        throw new AppError('Leave falls outside employee service', 400);
    const type = await registerReference(tx, req, body.leaveTypeId, 'leave-types', e.branchId);
    if (!type)
        throw new AppError('Choose a leave type', 400);
    const days = datesBetween(start, end);
    for (const p of new Set(days.map(d => d.slice(0, 7))))
        await assertHrPeriodOpen(tx, req.user.organizationId, e.branchId, new Date(p + '-01'), e.id);
    if (await tx.hrLeaveRequest.count({ where: { employeeId: e.id, status: { in: ['submitted', 'approved'] }, startDate: { lte: end }, endDate: { gte: start }, ...(ignoreId && { id: { not: ignoreId } }) } }))
        throw new AppError('This employee already has overlapping leave', 409, 'LEAVE_OVERLAP');
    const used = await tx.hrLeaveRequest.aggregate({ where: { employeeId: e.id, leaveTypeId: type.id, status: { in: ['submitted', 'approved'] }, startDate: { gte: new Date(body.startDate.slice(0, 4) + '-01-01'), lte: new Date(body.startDate.slice(0, 4) + '-12-31') }, ...(ignoreId && { id: { not: ignoreId } }) }, _sum: { days: true } });
    if (Number(used._sum.days ?? 0) + days.length > Number(asData(type.data).annualDays))
        throw new AppError('Leave request exceeds the remaining annual entitlement (pending requests are reserved)', 409, 'INSUFFICIENT_LEAVE');
    return { e, days: days.length, start, end };
}
router.get('/leaves', requirePermission('can_view_hr'), async (req, res) => {
    const q = pageQuery(req), where = { ...(await hrScope(req)), ...(q.status && { status: q.status }), ...((q.from || q.to) && { startDate: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }) };
    const [data, total] = await Promise.all([prisma.hrLeaveRequest.findMany({ where, include: { employee: { select: employeeSelect } }, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), prisma.hrLeaveRequest.count({ where })]);
    res.json({ data, total, page: q.page, limit: q.limit });
});
router.post('/leaves', requirePermission('can_manage_hr'), async (req, res) => {
    const body = leaveSchema.parse(req.body);
    res.status(201).json(await transaction(req, async (tx) => {
        const { e, days, start, end } = await validateLeave(tx, req, body);
        const l = await tx.hrLeaveRequest.create({ data: { ...body, organizationId: req.user.organizationId, branchId: e.branchId, startDate: start, endDate: end, days, createdBy: req.user.id } });
        await audit(tx, req, 'submit', 'hr_leave', l.id, e.branchId);
        return l;
    }));
});
router.post('/leaves/:id/action', async (req, res) => {
    const b = z.object({ action: z.enum(['approve', 'reject', 'cancel']), version: z.number().int().positive(), reason: notes.optional() }).strict().parse(req.body);
    await demand(req, b.action === 'cancel' ? 'can_manage_hr' : 'can_approve_hr');
    res.json(await transaction(req, async (tx) => {
        const l = await tx.hrLeaveRequest.findFirst({ where: { id: req.params.id, ...(await hrScope(req)) } });
        if (!l)
            throw new AppError('Leave request not found', 404);
        optimistic(l.version, b.version);
        if (!['submitted', ...(b.action === 'cancel' ? ['approved'] : [])].includes(l.status))
            throw new AppError('Leave request is already finalized', 409);
        for (const p of new Set(datesBetween(l.startDate, l.endDate).map(d => d.slice(0, 7))))
            await assertHrPeriodOpen(tx, l.organizationId, l.branchId, new Date(p + '-01'), l.employeeId);
        if (b.action !== 'cancel')
            await enforceHrApproval(req, tx, 'leave', l.branchId, l.createdBy);
        if (b.action === 'reject' && !b.reason)
            throw new AppError('Enter a rejection reason', 400);
        if (b.action === 'approve')
            await validateLeave(tx, req, { employeeId: l.employeeId, leaveTypeId: l.leaveTypeId, startDate: dateOnly(l.startDate), endDate: dateOnly(l.endDate), reason: l.reason }, l.id);
        const result = await tx.hrLeaveRequest.update({ where: { id: l.id }, data: { status: b.action === 'approve' ? 'approved' : b.action === 'reject' ? 'rejected' : 'cancelled', approvedBy: req.user.id, approvedAt: new Date(), rejectionReason: b.reason, version: { increment: 1 } } });
        await audit(tx, req, b.action, 'hr_leave', l.id, l.branchId);
        return result;
    }));
});
router.get('/leave-balances', requirePermission('can_view_hr'), async (req, res) => {
    const year = z.coerce.number().int().min(2000).max(2200).parse(req.query.year ?? new Date().getUTCFullYear()), q = pageQuery(req), scope = await hrScope(req);
    const [employees, total, types, used] = await Promise.all([
        prisma.hrEmployee.findMany({ where: scope, select: { ...employeeSelect, branchId: true }, orderBy: { code: 'asc' }, skip: (q.page - 1) * q.limit, take: q.limit }),
        prisma.hrEmployee.count({ where: scope }),
        prisma.hrRecord.findMany({ where: { ...scope, kind: 'leave-types', status: 'active' } }),
        prisma.hrLeaveRequest.groupBy({ by: ['employeeId', 'leaveTypeId', 'status'], where: { ...scope, startDate: { gte: new Date(`${year}-01-01`), lte: new Date(`${year}-12-31`) }, status: { in: ['approved', 'submitted'] } }, _sum: { days: true } }),
    ]);
    const data = employees.flatMap(e => types.filter(t => t.branchId === e.branchId).map(t => {
        const u = used.filter(u => u.employeeId === e.id && u.leaveTypeId === t.id), approved = Number(u.find(x => x.status === 'approved')?._sum.days ?? 0), pending = Number(u.find(x => x.status === 'submitted')?._sum.days ?? 0), entitlement = Number(asData(t.data).annualDays);
        return { employee: e, leaveType: t.title, entitlement, approved, pending, available: money(entitlement - approved - pending), year };
    }));
    res.json({ data, total, page: q.page, limit: q.limit, basis: 'Calendar days; annual entitlement; pending requests reserve balance.' });
});
router.get('/payroll', requirePermission('can_view_payroll'), async (req, res) => {
    const q = pageQuery(req), where = { ...(await hrScope(req)), ...(q.status && { status: q.status }) };
    const [data, total] = await Promise.all([prisma.hrPayrollRun.findMany({ where, include: { _count: { select: { lines: true } } }, orderBy: { period: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit }), prisma.hrPayrollRun.count({ where })]);
    res.json({ data, total, page: q.page, limit: q.limit });
});
router.get('/payroll/:id', requirePermission('can_view_payroll'), async (req, res) => { res.json(await findRun(req, prisma)); });
router.post('/payroll', requirePermission('can_process_payroll'), async (req, res) => {
    const b = z.object({ branchId: z.string().min(1), period: z.string() }).strict().parse(req.body);
    res.status(201).json(await transaction(req, async (tx) => {
        await hrBranch(req, b.branchId, tx);
        const old = await tx.hrPayrollRun.findUnique({ where: { organizationId_branchId_period: { organizationId: req.user.organizationId, branchId: b.branchId, period: b.period } } });
        if (old && old.status !== 'draft')
            throw new AppError('Payroll is already approved for this branch and period', 409);
        const p = await calculatePayroll(tx, req.user.organizationId, b.branchId, b.period);
        const data = { inputHash: p.hash, grossAmount: p.grossAmount, deductionAmount: p.deductionAmount, netAmount: p.netAmount };
        if (old)
            await tx.hrPayrollLine.deleteMany({ where: { runId: old.id } });
        const run = old ? await tx.hrPayrollRun.update({ where: { id: old.id }, data }) : await tx.hrPayrollRun.create({ data: { ...data, organizationId: req.user.organizationId, branchId: b.branchId, period: b.period, createdBy: req.user.id } });
        await tx.hrPayrollLine.createMany({ data: p.lines.map(l => ({ ...l, runId: run.id, breakdown: l.breakdown as unknown as Prisma.InputJsonValue })) });
        await audit(tx, req, old ? 'recalculate' : 'generate', 'hr_payroll', run.id, b.branchId);
        return run;
    }));
});
router.post('/payroll/:id/approve', requirePermission('can_approve_payroll'), async (req, res) => {
    res.json(await transaction(req, async (tx) => {
        const run = await findRun(req, tx);
        if (run.status !== 'draft')
            throw new AppError('Only draft payroll can be approved', 409);
        await enforceHrApproval(req, tx, 'payroll', run.branchId, run.createdBy, Number(run.netAmount));
        const p = await calculatePayroll(tx, run.organizationId, run.branchId, run.period);
        const range = periodRange(run.period);
        const affectedEmployees = run.lines.map(l => l.employeeId);
        const pending = await tx.hrLeaveRequest.count({ where: { organizationId: run.organizationId, OR: [{ branchId: run.branchId }, { employeeId: { in: affectedEmployees } }], status: 'submitted', startDate: { lte: range.end }, endDate: { gte: range.start } } })
            + await tx.hrRecord.count({ where: { organizationId: run.organizationId, OR: [{ branchId: run.branchId }, { employeeId: { in: affectedEmployees } }], kind: { in: [...payrollRelevantKinds] }, status: 'submitted', date: { gte: range.start, lte: range.end } } });
        if (pending)
            throw new AppError('Resolve submitted leave and payroll-affecting requests before approving this month.', 409, 'HR_PENDING_APPROVALS');
        if (p.hash !== run.inputHash)
            throw new AppError('Payroll inputs have changed. Recalculate and review this payroll before approval.', 409, 'PAYROLL_STALE');
        const settings = await tx.hrSettings.findUnique({ where: { organizationId: run.organizationId } });
        const expense = await hrAccount(tx, run.organizationId, settings?.salaryExpenseAccountId, 'salary expense', 'EXPENSE');
        const payable = await hrAccount(tx, run.organizationId, settings?.salaryPayableAccountId, 'salary payable', 'LIABILITY');
        let loanRecovery = 0;
        for (const line of p.lines) {
            for (const entry of line.breakdown.entries) {
                const r = await tx.hrRecord.findUniqueOrThrow({ where: { id: entry.id } }), d = asData(r.data);
                if (entry.type === 'loan_recovery') {
                    loanRecovery = money(loanRecovery + entry.amount);
                    await tx.hrRecord.update({ where: { id: r.id }, data: { recoveredAmount: { increment: entry.amount }, version: { increment: 1 } } });
                }
                else if (d.recurrence !== 'monthly')
                    await tx.hrRecord.update({ where: { id: r.id }, data: { status: 'processed', version: { increment: 1 }, data: { ...d, payrollRunId: run.id } as Prisma.InputJsonValue } });
            }
        }
        // Absence and unpaid leave reduce expense; loan recoveries settle the
        // employee receivable; other deductions remain a separately mapped liability.
        const statutoryOrFixed = money(p.deductionAmount - loanRecovery - p.lines.reduce((n, l) => n + l.breakdown.absenceDeduction, 0));
        const ledgerLines = [{ accountId: expense.id, debitAmount: money(p.netAmount + loanRecovery + statutoryOrFixed) }, { accountId: payable.id, creditAmount: p.netAmount }];
        if (loanRecovery)
            ledgerLines.push({ accountId: (await hrAccount(tx, run.organizationId, settings?.employeeReceivableAccountId, 'employee receivable', 'ASSET')).id, creditAmount: loanRecovery });
        if (statutoryOrFixed)
            ledgerLines.push({ accountId: (await hrAccount(tx, run.organizationId, settings?.deductionPayableAccountId, 'deductions payable', 'LIABILITY')).id, creditAmount: statutoryOrFixed });
        if (new Set(ledgerLines.map(l => l.accountId)).size !== ledgerLines.length)
            throw new AppError('HR posting accounts must be different', 400);
        const journal = await postJournalEntry(ledgerDb(tx), { organizationId: run.organizationId, branchId: run.branchId, entryDate: periodRange(run.period).end, description: `Payroll accrual ${run.period}`, referenceType: 'hr_payroll', referenceId: run.id, sourceKey: `HR:PAYROLL:${run.id}`, createdBy: req.user.id, lines: ledgerLines });
        const result = await tx.hrPayrollRun.update({ where: { id: run.id }, data: { status: p.netAmount === 0 ? 'paid' : 'approved', approvedBy: req.user.id, approvedAt: new Date(), journalEntryId: journal?.id ?? null } });
        await audit(tx, req, 'approve', 'hr_payroll', run.id, run.branchId);
        return result;
    }));
});
router.post('/payroll/:id/payments', requirePermission('can_pay_salaries'), async (req, res) => {
    const b = z.object({ lineId: z.string().min(1), requestId: z.string().uuid(), amount: z.number().finite().positive().max(100000000), method: z.enum(['cash', 'bank_transfer']), reference: z.string().trim().min(1).max(200), paymentDate: z.string().date() }).strict().parse(req.body);
    res.status(201).json(await transaction(req, async (tx) => {
        const run = await findRun(req, tx), line = run.lines.find(l => l.id === b.lineId);
        if (!line)
            throw new AppError('Payslip not found in this payroll', 404);
        const previous = await tx.hrPayrollPayment.findUnique({ where: { requestId: b.requestId } });
        if (previous) {
            if (previous.lineId !== line.id || Number(previous.amount) !== money(b.amount) || previous.method !== b.method || previous.reference !== b.reference || dateOnly(previous.paymentDate) !== b.paymentDate)
                throw new AppError('Payment request id has already been used for different details', 409);
            return previous;
        }
        if (run.status !== 'approved')
            throw new AppError('Approve payroll before recording salary payments', 409);
        if (money(b.amount) !== b.amount || b.amount > money(Number(line.netAmount) - Number(line.paidAmount)))
            throw new AppError('Payment exceeds the unpaid salary or has more than two decimal places', 400);
        if (new Date(b.paymentDate) < periodRange(run.period).start)
            throw new AppError('Payment date cannot precede the payroll period', 400);
        const settings = await tx.hrSettings.findUnique({ where: { organizationId: run.organizationId } });
        const payable = await hrAccount(tx, run.organizationId, settings?.salaryPayableAccountId, 'salary payable', 'LIABILITY');
        const entry = await postHrPayment(tx, req, { branchId: run.branchId, amount: b.amount, method: b.method, date: new Date(b.paymentDate), debitAccountId: payable.id, referenceId: line.id, sourceKey: `HR:SALARY:${b.requestId}`, description: `Salary ${run.period} · ${line.employeeCode} · ${b.reference}` });
        const payment = await tx.hrPayrollPayment.create({ data: { ...b, paymentDate: new Date(b.paymentDate), createdBy: req.user.id, journalEntryId: entry.id } });
        await tx.hrPayrollLine.update({ where: { id: line.id }, data: { paidAmount: { increment: b.amount } } });
        const refreshed = await tx.hrPayrollLine.findMany({ where: { runId: run.id } });
        if (refreshed.every(l => Number(l.paidAmount) >= Number(l.netAmount)))
            await tx.hrPayrollRun.update({ where: { id: run.id }, data: { status: 'paid' } });
        await audit(tx, req, 'salary_payment', 'hr_payroll', run.id, run.branchId);
        return payment;
    }));
});
const settingsSchema = z.object({ workingDaysPerMonth: z.number().int().min(1).max(31), hoursPerDay: z.number().finite().min(1).max(24), overtimeMultiplier: z.number().finite().min(1).max(5), salaryExpenseAccountId: z.string().optional().nullable(), salaryPayableAccountId: z.string().optional().nullable(), employeeReceivableAccountId: z.string().optional().nullable(), deductionPayableAccountId: z.string().optional().nullable() }).strict();
router.get('/settings', requirePermission('can_configure_hr'), async (req, res) => { res.json(await prisma.hrSettings.findUnique({ where: { organizationId: req.user.organizationId } }) ?? { workingDaysPerMonth: 26, hoursPerDay: 8, overtimeMultiplier: 1.5 }); });
router.put('/settings', requirePermission('can_configure_hr'), async (req, res) => {
    const b = settingsSchema.parse(req.body);
    res.json(await transaction(req, async (tx) => {
        for (const [key, label, cls] of [['salaryExpenseAccountId', 'salary expense', 'EXPENSE'], ['salaryPayableAccountId', 'salary payable', 'LIABILITY'], ['employeeReceivableAccountId', 'employee receivable', 'ASSET'], ['deductionPayableAccountId', 'deduction payable', 'LIABILITY']] as const)
            if (b[key])
                await hrAccount(tx, req.user.organizationId, b[key], label, cls);
        const ids = [b.salaryExpenseAccountId, b.salaryPayableAccountId, b.employeeReceivableAccountId, b.deductionPayableAccountId].filter(Boolean);
        if (new Set(ids).size !== ids.length)
            throw new AppError('Choose separate HR posting accounts', 400);
        const result = await tx.hrSettings.upsert({ where: { organizationId: req.user.organizationId }, create: { organizationId: req.user.organizationId, ...b }, update: b });
        await audit(tx, req, 'configure', 'hr_settings', req.user.organizationId);
        return result;
    }));
});
router.get('/accounts', requirePermission('can_configure_hr'), async (req, res) => { res.json({ data: await prisma.account.findMany({ where: { organizationId: req.user.organizationId, status: 'ACTIVE', allowManualPosting: true, isControlAccount: false, accountClass: { in: ['ASSET', 'LIABILITY', 'EXPENSE'] } }, select: { id: true, code: true, name: true, accountClass: true }, orderBy: { code: 'asc' } }) }); });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (_req, file, cb) => cb(null, ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype)) });
router.post('/records/documents/:id/file', requirePermission('can_manage_hr'), upload.single('file'), async (req, res) => {
    if (!req.file)
        throw new AppError('Choose a PDF, JPEG or PNG file up to 10 MB', 400);
    const dir = path.resolve(UPLOAD_ROOT, 'hr', req.user.organizationId), file = path.join(dir, crypto.randomUUID());
    await fs.mkdir(dir, { recursive: true });
    let oldFile: string | undefined;
    try {
        await fs.writeFile(file, req.file.buffer);
        const result = await transaction(req, async (tx) => {
            const r = await tx.hrRecord.findFirst({ where: { id: req.params.id, kind: 'documents', ...(await hrScope(req)) } });
            if (!r || r.status !== 'active')
                throw new AppError('Active employee document not found', 404);
            oldFile = String(asData(r.data).filePath ?? '');
            const data = { ...asData(r.data), filePath: file, fileName: req.file!.originalname.slice(0, 200), fileType: req.file!.mimetype };
            await tx.hrRecord.update({ where: { id: r.id }, data: { data, version: { increment: 1 } } });
            await audit(tx, req, 'upload', 'hr_documents', r.id, r.branchId);
            return { fileName: data.fileName };
        });
        if (oldFile && path.dirname(oldFile) === dir)
            await fs.unlink(oldFile).catch(() => undefined);
        res.json(result);
    }
    catch (err) {
        await fs.unlink(file).catch(() => undefined);
        throw err;
    }
});
router.get('/records/documents/:id/file', requirePermission('can_view_hr'), async (req, res) => {
    const r = await prisma.hrRecord.findFirst({ where: { id: req.params.id, kind: 'documents', ...(await hrScope(req)) } });
    if (!r)
        throw new AppError('Employee document not found', 404);
    const d = asData(r.data), dir = path.resolve(UPLOAD_ROOT, 'hr', req.user.organizationId), file = path.resolve(String(d.filePath ?? ''));
    const mediaDir = path.join(UPLOAD_ROOT, 'branch-media', req.user.organizationId, r.branchId!, 'HrRecord');
    if (path.dirname(file) !== dir && !(isImmutableMedia(file) && path.dirname(file) === mediaDir))
        throw new AppError('No file has been attached', 404);
    try {
        await checkedUpload(file);
    }
    catch {
        throw new AppError('Document file not found', 404);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(file, path.basename(String(d.fileName ?? 'document')));
});
router.get('/reports', async (req, res) => {
    const q = z.object({ type: z.enum(['employees', 'attendance', 'leave', 'payroll', 'payments', 'financials']), from: z.string().date(), to: z.string().date() }).parse(req.query);
    await demand(req, ['payroll', 'payments', 'financials'].includes(q.type) ? 'can_view_payroll' : 'can_view_hr');
    if (q.from > q.to || +new Date(q.to) - +new Date(q.from) > 366 * 86400000)
        throw new AppError('Choose a report range of at most 366 days', 400);
    const scope = await hrScope(req), dates = { gte: new Date(q.from), lte: new Date(q.to) }, take = 5001;
    let rows: Record<string, string | number>[];
    if (q.type === 'employees') {
        const records = await prisma.hrRecord.findMany({ where: { organizationId: scope.organizationId, kind: { in: ['departments', 'designations'] } }, select: { id: true, title: true } });
        rows = (await prisma.hrEmployee.findMany({ where: { ...scope, joiningDate: { lte: new Date(q.to) } }, include: { branch: { select: { name: true } } }, orderBy: { code: 'asc' }, take })).map(e => ({ Code: e.code, Employee: `${e.firstName} ${e.lastName}`, Branch: e.branch.name, Department: records.find(r => r.id === e.departmentId)?.title ?? '', Designation: records.find(r => r.id === e.designationId)?.title ?? '', Joined: dateOnly(e.joiningDate), Status: e.status, 'Exit date': e.exitDate ? dateOnly(e.exitDate) : '' }));
    }
    else if (q.type === 'attendance')
        rows = (await prisma.hrAttendance.findMany({ where: { ...scope, date: dates }, include: { employee: { select: employeeSelect } }, orderBy: [{ date: 'asc' }, { employeeId: 'asc' }], take })).map(a => ({ Code: a.employee.code, Employee: `${a.employee.firstName} ${a.employee.lastName}`, Date: dateOnly(a.date), Status: a.status, 'Check in': a.checkIn?.toISOString() ?? '', 'Check out': a.checkOut?.toISOString() ?? '', Source: a.source }));
    else if (q.type === 'leave')
        rows = (await prisma.hrLeaveRequest.findMany({ where: { ...scope, startDate: { lte: dates.lte }, endDate: { gte: dates.gte } }, include: { employee: { select: employeeSelect } }, orderBy: { startDate: 'asc' }, take })).map(l => ({ Code: l.employee.code, Employee: `${l.employee.firstName} ${l.employee.lastName}`, From: dateOnly(l.startDate), To: dateOnly(l.endDate), Days: Number(l.days), Status: l.status, Reason: l.reason }));
    else if (q.type === 'payroll')
        rows = (await prisma.hrPayrollLine.findMany({ where: { run: { ...scope, period: { gte: q.from.slice(0, 7), lte: q.to.slice(0, 7) } } }, include: { run: { select: { period: true, status: true } } }, orderBy: { employeeCode: 'asc' }, take })).map(l => ({ Period: l.run.period, Code: l.employeeCode, Employee: l.employeeName, Basic: Number(l.basicAmount), Allowances: Number(l.allowanceAmount), Overtime: Number(l.overtimeAmount), Deductions: Number(l.deductionAmount), Net: Number(l.netAmount), Paid: Number(l.paidAmount), Outstanding: money(Number(l.netAmount) - Number(l.paidAmount)), Status: l.run.status }));
    else if (q.type === 'payments')
        rows = (await prisma.hrPayrollPayment.findMany({ where: { line: { run: scope }, paymentDate: dates }, include: { line: { select: { employeeCode: true, employeeName: true, run: { select: { period: true } } } } }, orderBy: { paymentDate: 'asc' }, take })).map(p => ({ Date: dateOnly(p.paymentDate), Period: p.line.run.period, Code: p.line.employeeCode, Employee: p.line.employeeName, Amount: Number(p.amount), Method: p.method, Reference: p.reference, Journal: p.journalEntryId }));
    else
        rows = (await prisma.hrRecord.findMany({ where: { ...scope, kind: { in: ['loans', 'reimbursements', 'benefits', 'commissions', 'settlements'] }, date: dates }, include: { employee: { select: employeeSelect } }, orderBy: { date: 'asc' }, take })).map(r => ({ Date: dateOnly(r.date), Code: r.employee?.code ?? '', Employee: r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : '', Type: r.kind, Title: r.title, Amount: Number(r.amount), Recovered: Number(r.recoveredAmount), Status: r.status }));
    const columns = rows.length ? Object.keys(rows[0]) : q.type === 'employees' ? ['Code', 'Employee', 'Branch', 'Department', 'Designation', 'Joined', 'Status', 'Exit date'] : [];
    res.json({ columns, rows: rows.slice(0, 5000), total: Math.min(rows.length, 5000), truncated: rows.length > 5000 });
});
export default router;
