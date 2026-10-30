import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Request } from 'express';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { z } from 'zod';
import { prisma } from '../config';
import { AppError } from '../middleware/error';
import { assertBranchAccess, branchFilter } from '../utils/branchScope';
import { getUserPermissions } from '../utils/permissions';
import { assertNotOwnSubmission } from '../middleware/authorize';
import { postJournalEntry, mappingKeyForPaymentMethod, resolveMappedAccount } from '../utils/ledger';
import { HrRegister } from './hrCatalog';
export type HrTx = Prisma.TransactionClient;
export const money = (n: number) => regionalRoundMoney(n);
export const asData = (value: Prisma.JsonValue): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);
export const periodRange = (period: string) => {
    z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(period);
    const start = new Date(`${period}-01T00:00:00Z`);
    if (start.getUTCFullYear() < 2000 || start.getUTCFullYear() > 2200)
        throw new AppError('Choose a payroll year from 2000 to 2200', 400);
    return { start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)) };
};
export function datesBetween(start: Date, end: Date) {
    const out: string[] = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000)
        out.push(dateOnly(new Date(t)));
    return out;
}
// One organization-level lock gives approvals, transfers, leave balances and
// payroll snapshots a consistent order, including cross-branch transfers.
export async function hrLock(tx: HrTx, org: string) { await tx.$queryRaw `SELECT pg_advisory_xact_lock(hashtext(${`hr:${org}`}))::text`; }
export async function hrScope(req: Request) {
    const branchId = await branchFilter(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined);
    return { organizationId: req.user.organizationId, ...(branchId && { branchId }) };
}
export async function hrBranch(req: Request, branchId: string, tx: HrTx = prisma) {
    await assertBranchAccess(req, branchId);
    const branch = await tx.branch.findFirst({ where: { id: branchId, organizationId: req.user.organizationId, isActive: true } });
    if (!branch)
        throw new AppError('Active branch not found', 404, 'NOT_FOUND');
    return branch;
}
export async function hrEmployee(req: Request, id: string, tx: HrTx = prisma) {
    const e = await tx.hrEmployee.findFirst({ where: { id, organizationId: req.user.organizationId } });
    if (!e)
        throw new AppError('Employee not found', 404, 'NOT_FOUND');
    await assertBranchAccess(req, e.branchId);
    return e;
}
export async function registerReference(tx: HrTx, req: Request, id: unknown, kind: string, branchId: string) {
    if (!id)
        return null;
    const row = await tx.hrRecord.findFirst({ where: { id: String(id), organizationId: req.user.organizationId, branchId, kind, status: 'active' } });
    if (!row)
        throw new AppError(`Choose an active ${kind.replace(/-/g, ' ')} record from this branch`, 400, 'INVALID_REFERENCE');
    return row;
}
export async function assertHrPeriodOpen(tx: HrTx, organizationId: string, branchId: string, date: Date, employeeId?: string | null) {
    const locked = await tx.hrPayrollRun.findFirst({ where: { organizationId, OR: [{ branchId }, ...(employeeId ? [{ lines: { some: { employeeId } } }] : [])], period: dateOnly(date).slice(0, 7), status: { in: ['approved', 'paid'] } } });
    if (locked)
        throw new AppError('This payroll period is approved. Use an adjustment in a later period.', 409, 'HR_PERIOD_LOCKED');
}
export async function enforceHrApproval(req: Request, tx: HrTx, workflow: string, branchId: string, createdBy: string, amount = 0) {
    await assertNotOwnSubmission(req, createdBy, workflow);
    const rules = await tx.hrRecord.findMany({ where: { organizationId: req.user.organizationId, branchId, kind: 'approval-rules', status: 'active' } });
    const { roles } = await getUserPermissions(tx, req.user.id);
    if (roles.some(r => ['super_admin', 'owner'].includes(r)))
        return;
    const userRoles = await tx.userRole.findMany({ where: { userId: req.user.id }, select: { roleId: true } });
    for (const r of rules) {
        const d = asData(r.data);
        if (d.workflow === workflow && amount >= Number(d.minimumAmount ?? 0) && !userRoles.some(ur => ur.roleId === d.approverRoleId)) {
            throw new AppError('The configured approval rule requires another approver role', 403, 'HR_APPROVER_REQUIRED');
        }
    }
}
export const payrollRelevantKinds = new Set(['salary-structures', 'leave-types', 'overtime', 'components', 'loans', 'reimbursements', 'benefits', 'commissions', 'settlements', 'transfers', 'resignations']);
export async function validateRegister(tx: HrTx, req: Request, register: HrRegister, body: {
    branchId: string;
    employeeId?: string | null;
    date: string;
    amount: number;
    data: Record<string, unknown>;
}, ignoreId?: string) {
    await hrBranch(req, body.branchId, tx);
    if (register.monetary && money(body.amount) !== body.amount)
        throw new AppError('Amounts must have at most two decimal places', 400);
    if (register.employee && body.employeeId) {
        const e = await hrEmployee(req, body.employeeId, tx);
        if (e.branchId !== body.branchId)
            throw new AppError('Employee belongs to another branch', 400, 'INVALID_REFERENCE');
        if (payrollRelevantKinds.has(register.key) && new Date(body.date) < e.joiningDate)
            throw new AppError('Record date cannot precede employee joining', 400);
        if (e.exitDate && ['overtime', 'transfers', 'loans'].includes(register.key) && new Date(body.date) > e.exitDate)
            throw new AppError('This record must fall within employee service dates', 400);
    }
    for (const f of register.fields.filter(f => f.lookup)) {
        const id = body.data[f.key];
        if (!id)
            continue;
        if (f.lookup === 'branches')
            await hrBranch(req, String(id), tx);
        else if (f.lookup === 'roles') {
            if (!await tx.role.count({ where: { id: String(id), organizationId: req.user.organizationId } }))
                throw new AppError('Approver role not found', 400);
        }
        else
            await registerReference(tx, req, id, f.lookup!, register.key === 'transfers' ? String(body.data.destinationBranchId) : body.branchId);
    }
    for (const key of ['endDate', 'lastWorkingDate'])
        if (body.data[key] && String(body.data[key]) < body.date)
            throw new AppError('End date cannot precede the effective date', 400);
    if (register.key === 'loans' && Number(body.data.installment) > body.amount)
        throw new AppError('Monthly recovery cannot exceed the loan amount', 400);
    if (register.key === 'rosters') {
        const rows = await tx.hrRecord.findMany({ where: { organizationId: req.user.organizationId, employeeId: body.employeeId, kind: 'rosters', status: 'active', ...(ignoreId && { id: { not: ignoreId } }) } });
        if (rows.some(r => dateOnly(r.date) <= String(body.data.endDate) && String(asData(r.data).endDate) >= body.date))
            throw new AppError('This employee already has an overlapping duty roster', 409);
    }
    if (payrollRelevantKinds.has(register.key))
        await assertHrPeriodOpen(tx, req.user.organizationId, body.branchId, new Date(body.date), body.employeeId);
}
export const employeeSchema = z.object({
    branchId: z.string().min(1), code: z.string().trim().min(1).max(40), firstName: z.string().trim().min(1).max(80), lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(200).optional().nullable(), phone: z.string().trim().max(40).optional().nullable(), address: z.string().trim().max(1000).optional().nullable(),
    nationalId: z.string().trim().max(80).optional().nullable(), emergencyContact: z.string().trim().max(200).optional().nullable(),
    joiningDate: z.string().date(), employmentType: z.enum(['full_time', 'part_time', 'contract', 'temporary']),
    status: z.enum(['active', 'probation', 'suspended']).default('active'),
    departmentId: z.string().optional().nullable(), designationId: z.string().optional().nullable(), salaryStructureId: z.string().optional().nullable(),
    basicSalary: z.number().finite().min(0).max(100000000).optional(), biometricId: z.string().trim().min(1).max(100).optional().nullable(), version: z.number().int().positive().optional(),
}).strict();
export const attendanceSchema = z.object({ employeeId: z.string().min(1), date: z.string().date(), checkIn: z.string().datetime({ offset: true }).optional().nullable(), checkOut: z.string().datetime({ offset: true }).optional().nullable(), status: z.enum(['present', 'absent', 'late', 'half_day', 'holiday', 'rest_day']), notes: z.string().trim().max(1000).optional().nullable(), version: z.number().int().positive().optional() }).strict().superRefine((b, ctx) => {
    if (b.checkOut && (!b.checkIn || new Date(b.checkOut) <= new Date(b.checkIn)))
        ctx.addIssue({ code: 'custom', message: 'Check-out must be after check-in' });
    if (b.checkIn && b.checkOut && +new Date(b.checkOut) - +new Date(b.checkIn) > 36 * 3600000)
        ctx.addIssue({ code: 'custom', message: 'Attendance cannot exceed 36 hours' });
    if (['absent', 'holiday', 'rest_day'].includes(b.status) && (b.checkIn || b.checkOut))
        ctx.addIssue({ code: 'custom', message: 'This attendance status cannot contain clock times' });
});
type PayrollBreakdown = {
    employeeVersion: number;
    structureVersion: number | null;
    calendarDays: number;
    payableDays: number;
    absenceDays: number;
    unpaidLeaveDays: number;
    absenceDeduction: number;
    overtimeHours: number;
    entries: {
        id: string;
        version: number;
        kind: string;
        amount: number;
        type: string;
    }[];
};
export async function calculatePayroll(tx: HrTx, org: string, branchId: string, period: string) {
    const { start, end } = periodRange(period);
    const settings = await tx.hrSettings.findUnique({ where: { organizationId: org } });
    const workingDays = settings?.workingDaysPerMonth ?? 26, hours = Number(settings?.hoursPerDay ?? 8), multiplier = Number(settings?.overtimeMultiplier ?? 1.5);
    const settlements = await tx.hrRecord.findMany({ where: { organizationId: org, branchId, kind: 'settlements', status: 'approved', date: { gte: start, lte: end } }, select: { employeeId: true } });
    const transfers = await tx.hrRecord.findMany({ where: { organizationId: org, kind: 'transfers', status: 'approved', employeeId: { not: null } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] });
    const candidates = await tx.hrEmployee.findMany({ where: { organizationId: org, AND: [{ OR: [{ branchId }, { id: { in: transfers.filter(t => t.branchId === branchId).map(t => t.employeeId!) } }] }], joiningDate: { lte: end }, OR: [
                { AND: [{ OR: [{ exitDate: null }, { exitDate: { gte: start } }] }, { OR: [{ status: { in: ['active', 'probation'] } }, { status: 'exited', exitDate: { gte: start } }] }] },
                { id: { in: settlements.flatMap(s => s.employeeId ? [s.employeeId] : []) } },
            ] }, orderBy: { id: 'asc' } });
    // The branch at month-end owns the month's payroll. Source snapshots preserve
    // the ability to process historical months after an employee has transferred.
    const employees = candidates.flatMap(e => {
        const next = transfers.find(t => t.employeeId === e.id && t.date > end);
        if (!next)
            return e.branchId === branchId ? [e] : [];
        if (next.branchId !== branchId)
            return [];
        const d = asData(next.data);
        return [{ ...e, branchId, basicSalary: new Prisma.Decimal(String(d.sourceBasicSalary ?? e.basicSalary)), salaryStructureId: d.sourceSalaryStructureId ? String(d.sourceSalaryStructureId) : null }];
    });
    const alreadyPaidElsewhere = await tx.hrPayrollLine.count({ where: { employeeId: { in: employees.map(e => e.id) }, run: { organizationId: org, branchId: { not: branchId }, period, status: { in: ['approved', 'paid'] } } } });
    if (alreadyPaidElsewhere)
        throw new AppError('An employee already has approved payroll in another branch for this month. Process their destination salary from the following month.', 409, 'PAYROLL_DUPLICATE_EMPLOYEE');
    const ids = employees.map(e => e.id);
    const [records, attendance, leaves, types] = await Promise.all([
        tx.hrRecord.findMany({ where: { organizationId: org, OR: [{ employeeId: { in: ids } }, { kind: 'salary-structures', branchId }], status: { in: ['active', 'approved', 'paid'] }, date: { lte: end } }, orderBy: { id: 'asc' } }),
        tx.hrAttendance.findMany({ where: { organizationId: org, employeeId: { in: ids }, date: { gte: start, lte: end } } }),
        tx.hrLeaveRequest.findMany({ where: { organizationId: org, employeeId: { in: ids }, status: 'approved', startDate: { lte: end }, endDate: { gte: start } } }),
        tx.hrRecord.findMany({ where: { organizationId: org, kind: 'leave-types' } }),
    ]);
    const lines = employees.map(e => {
        const activeStart = e.joiningDate > start ? e.joiningDate : start, activeEnd = e.exitDate && e.exitDate < end ? e.exitDate : end;
        const calendarDays = end.getUTCDate(), payableDays = Math.max(0, datesBetween(activeStart, activeEnd).length);
        const basicAmount = money(Number(e.basicSalary) * payableDays / calendarDays);
        const structure = records.find(r => r.id === e.salaryStructureId && r.kind === 'salary-structures' && r.status === 'active'), sd = structure ? asData(structure.data) : {};
        if (e.salaryStructureId && !structure)
            throw new AppError(`Salary structure for ${e.code} is not active in this payroll period`, 400);
        let allowanceAmount = money(Number(sd.allowance ?? 0) * payableDays / calendarDays), deductionAmount = money(Number(sd.deduction ?? 0) * payableDays / calendarDays), overtimeHours = 0;
        const entries: PayrollBreakdown['entries'] = [];
        const covered = new Set<string>(), unpaid = new Set<string>();
        for (const l of leaves.filter(l => l.employeeId === e.id)) {
            const from = new Date(Math.max(+l.startDate, +activeStart)), to = new Date(Math.min(+l.endDate, +activeEnd));
            for (const d of datesBetween(from, to)) {
                covered.add(d);
                if (asData(types.find(t => t.id === l.leaveTypeId)?.data ?? {}).paid === 'unpaid')
                    unpaid.add(d);
            }
        }
        let absenceDays = 0;
        for (const a of attendance.filter(a => a.employeeId === e.id && a.date >= activeStart && a.date <= activeEnd))
            if (!covered.has(dateOnly(a.date)))
                absenceDays += a.status === 'absent' ? 1 : a.status === 'half_day' ? 0.5 : 0;
        const absenceDeduction = money(Number(e.basicSalary) / workingDays * (absenceDays + unpaid.size));
        deductionAmount += absenceDeduction;
        for (const r of records.filter(r => r.employeeId === e.id && ['approved', 'paid'].includes(r.status))) {
            const d = asData(r.data), monthly = d.recurrence === 'monthly';
            if (r.kind !== 'settlements' && (r.date > activeEnd || (d.endDate && String(d.endDate) < dateOnly(activeStart))))
                continue;
            if (r.kind === 'loans') {
                if (r.status !== 'paid' || (d.disbursedAt && new Date(String(d.disbursedAt)) > end))
                    continue;
                const amount = money(Math.min(Number(d.installment), Number(r.amount) - Number(r.recoveredAmount)));
                if (amount > 0) {
                    deductionAmount += amount;
                    entries.push({ id: r.id, version: r.version, kind: r.kind, amount, type: 'loan_recovery' });
                }
                continue;
            }
            if (!monthly && r.date < activeStart)
                continue;
            if (r.kind === 'overtime') {
                overtimeHours += Number(d.hours);
                entries.push({ id: r.id, version: r.version, kind: r.kind, amount: Number(d.hours), type: 'overtime' });
                continue;
            }
            if (!['components', 'reimbursements', 'benefits', 'commissions', 'settlements'].includes(r.kind))
                continue;
            if (r.status === 'paid')
                continue;
            const amount = Number(r.amount), type = d.componentType === 'deduction' ? 'deduction' : 'allowance';
            if (type === 'deduction')
                deductionAmount += amount;
            else
                allowanceAmount += amount;
            entries.push({ id: r.id, version: r.version, kind: r.kind, amount, type });
        }
        const overtimeAmount = money(Number(e.basicSalary) / (workingDays * hours) * multiplier * overtimeHours);
        allowanceAmount = money(allowanceAmount);
        deductionAmount = money(deductionAmount);
        const netAmount = money(basicAmount + allowanceAmount + overtimeAmount - deductionAmount);
        if (netAmount < 0)
            throw new AppError(`Deductions exceed earnings for ${e.code}. Review attendance, leave and recoveries.`, 400, 'NEGATIVE_PAYROLL');
        const breakdown: PayrollBreakdown = { employeeVersion: e.version, structureVersion: structure?.version ?? null, calendarDays, payableDays, absenceDays, unpaidLeaveDays: unpaid.size, absenceDeduction, overtimeHours, entries };
        return { employeeId: e.id, employeeCode: e.code, employeeName: `${e.firstName} ${e.lastName}`, basicAmount, allowanceAmount, overtimeAmount, deductionAmount, netAmount, breakdown };
    });
    if (!lines.length)
        throw new AppError('No eligible employees in this branch and period', 400, 'NO_EMPLOYEES');
    const hash = createHash('sha256').update(JSON.stringify({ workingDays, hours, multiplier, lines })).digest('hex');
    return { lines, hash, grossAmount: money(lines.reduce((n, l) => n + l.basicAmount + l.allowanceAmount + l.overtimeAmount, 0)), deductionAmount: money(lines.reduce((n, l) => n + l.deductionAmount, 0)), netAmount: money(lines.reduce((n, l) => n + l.netAmount, 0)) };
}
export async function hrAccount(tx: HrTx, org: string, id: string | null | undefined, label: string, accountClass?: string) {
    if (!id)
        throw new AppError(`Configure the ${label} account in HR Configuration`, 400, 'HR_ACCOUNT_REQUIRED');
    const a = await tx.account.findFirst({ where: { id, organizationId: org, status: 'ACTIVE', allowManualPosting: true, isControlAccount: false } });
    if (!a || (accountClass && a.accountClass !== accountClass))
        throw new AppError(`Choose an active ${accountClass ?? ''} posting account for ${label}`, 400, 'HR_ACCOUNT_INVALID');
    return a;
}
// The existing ledger helper accepts PrismaClient but uses only transaction-safe
// model operations. This is the same transaction adapter used elsewhere in FoodSync.
export const ledgerDb = (tx: HrTx) => tx as typeof prisma;
export async function postHrPayment(tx: HrTx, req: Request, input: {
    branchId: string;
    amount: number;
    method: string;
    date: Date;
    debitAccountId: string;
    referenceId: string;
    sourceKey: string;
    description: string;
}) {
    const cash = await resolveMappedAccount(ledgerDb(tx), req.user.organizationId, mappingKeyForPaymentMethod(input.method));
    if (cash.id === input.debitAccountId)
        throw new AppError('Payment and liability/receivable accounts must differ', 400);
    const entry = await postJournalEntry(ledgerDb(tx), { organizationId: req.user.organizationId, branchId: input.branchId, entryDate: input.date, description: input.description, referenceType: 'hr_payment', referenceId: input.referenceId, sourceKey: input.sourceKey, createdBy: req.user.id,
        lines: [{ accountId: input.debitAccountId, debitAmount: input.amount }, { accountId: cash.id, creditAmount: input.amount }] });
    if (!entry)
        throw new AppError('A positive payment must create a ledger entry', 500);
    return entry;
}
