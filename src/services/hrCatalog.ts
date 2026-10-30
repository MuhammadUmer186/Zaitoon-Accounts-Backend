import { z } from 'zod';
export type HrField = {
    key: string;
    label: string;
    type: 'text' | 'textarea' | 'date' | 'number' | 'select' | 'email' | 'time';
    required?: boolean;
    min?: number;
    max?: number;
    options?: string[];
    lookup?: string;
};
export type HrRegister = {
    key: string;
    label: string;
    group: string;
    employee?: boolean;
    approval?: boolean;
    monetary?: boolean;
    fields: HrField[];
};
const field = (key: string, label: string, type: HrField['type'] = 'text', extra: Partial<HrField> = {}): HrField => ({ key, label, type, ...extra });
const required = { required: true };
export const hrRegisters: HrRegister[] = [
    { key: 'departments', label: 'Departments', group: 'Employees', fields: [field('code', 'Department code', 'text', required), field('description', 'Description', 'textarea')] },
    { key: 'designations', label: 'Designations', group: 'Employees', fields: [field('departmentId', 'Department', 'select', { lookup: 'departments' }), field('grade', 'Grade')] },
    { key: 'documents', label: 'Employee Documents', group: 'Employees', employee: true, fields: [field('documentType', 'Document type', 'select', { ...required, options: ['identity', 'contract', 'qualification', 'medical', 'other'] }), field('reference', 'Document reference'), field('expiryDate', 'Expiry date', 'date')] },
    { key: 'transfers', label: 'Employee Transfers', group: 'Employees', employee: true, approval: true, fields: [field('destinationBranchId', 'Destination branch', 'select', { ...required, lookup: 'branches' }), field('departmentId', 'Destination department', 'select', { lookup: 'departments' }), field('designationId', 'Destination designation', 'select', { lookup: 'designations' }), field('reason', 'Reason', 'textarea', required)] },
    { key: 'shifts', label: 'Shift Setup', group: 'Attendance & Shifts', fields: [field('startTime', 'Start time', 'time', required), field('endTime', 'End time', 'time', required), field('breakMinutes', 'Unpaid break (minutes)', 'number', { min: 0, max: 240 }), field('graceMinutes', 'Grace period (minutes)', 'number', { min: 0, max: 120 })] },
    { key: 'rosters', label: 'Duty Rosters', group: 'Attendance & Shifts', employee: true, fields: [field('shiftId', 'Shift', 'select', { ...required, lookup: 'shifts' }), field('endDate', 'Last duty date', 'date', required), field('restDays', 'Weekly rest days', 'text'), field('notes', 'Notes', 'textarea')] },
    { key: 'overtime', label: 'Overtime', group: 'Attendance & Shifts', employee: true, approval: true, fields: [field('hours', 'Approved hours', 'number', { ...required, min: 0.25, max: 24 }), field('reason', 'Reason', 'textarea', required)] },
    { key: 'leave-types', label: 'Leave Types', group: 'Leave Management', fields: [field('annualDays', 'Annual entitlement (days)', 'number', { ...required, min: 0, max: 366 }), field('paid', 'Payment', 'select', { ...required, options: ['paid', 'unpaid'] }), field('description', 'Policy notes', 'textarea')] },
    { key: 'salary-structures', label: 'Salary Structures', group: 'Payroll', fields: [field('description', 'Description', 'textarea'), field('allowance', 'Monthly allowance', 'number', { min: 0, max: 100000000 }), field('deduction', 'Monthly deduction', 'number', { min: 0, max: 100000000 })] },
    { key: 'components', label: 'Allowances & Deductions', group: 'Payroll', employee: true, approval: true, monetary: true, fields: [field('componentType', 'Type', 'select', { ...required, options: ['allowance', 'deduction'] }), field('recurrence', 'Recurrence', 'select', { ...required, options: ['once', 'monthly'] }), field('endDate', 'End date', 'date'), field('notes', 'Notes', 'textarea')] },
    { key: 'loans', label: 'Loans & Advances', group: 'Employee Financials', employee: true, approval: true, monetary: true, fields: [field('loanType', 'Type', 'select', { ...required, options: ['loan', 'advance'] }), field('installment', 'Monthly recovery', 'number', { ...required, min: 0.01, max: 100000000 }), field('reason', 'Reason', 'textarea', required)] },
    { key: 'reimbursements', label: 'Reimbursements', group: 'Employee Financials', employee: true, approval: true, monetary: true, fields: [field('category', 'Category', 'select', { ...required, options: ['travel', 'medical', 'supplies', 'other'] }), field('receiptReference', 'Receipt reference', 'text', required), field('notes', 'Notes', 'textarea')] },
    { key: 'benefits', label: 'Benefits', group: 'Employee Financials', employee: true, approval: true, monetary: true, fields: [field('recurrence', 'Recurrence', 'select', { ...required, options: ['once', 'monthly'] }), field('endDate', 'End date', 'date'), field('notes', 'Notes', 'textarea')] },
    { key: 'commissions', label: 'Commissions', group: 'Employee Financials', employee: true, approval: true, monetary: true, fields: [field('reference', 'Sales / performance reference', 'text', required), field('notes', 'Calculation notes', 'textarea', required)] },
    { key: 'recruitment', label: 'Recruitment', group: 'Talent Management', fields: [field('candidateName', 'Candidate name', 'text', required), field('email', 'Candidate email', 'email'), field('position', 'Position', 'text', required), field('stage', 'Stage', 'select', { ...required, options: ['applied', 'shortlisted', 'interview', 'offered', 'hired', 'declined'] }), field('interviewDate', 'Interview date', 'date'), field('notes', 'Notes', 'textarea')] },
    { key: 'onboarding', label: 'Onboarding', group: 'Talent Management', employee: true, fields: [field('owner', 'Responsible person', 'text', required), field('dueDate', 'Due date', 'date', required), field('progress', 'Progress', 'select', { ...required, options: ['pending', 'in_progress', 'complete'] }), field('checklist', 'Checklist / handover notes', 'textarea', required)] },
    { key: 'appraisals', label: 'Performance Appraisals', group: 'Talent Management', employee: true, approval: true, fields: [field('reviewer', 'Reviewer', 'text', required), field('rating', 'Rating (1–5)', 'number', { ...required, min: 1, max: 5 }), field('goals', 'Goals and feedback', 'textarea', required), field('nextReviewDate', 'Next review', 'date')] },
    { key: 'training', label: 'Training', group: 'Talent Management', employee: true, fields: [field('provider', 'Trainer / provider', 'text', required), field('endDate', 'Completion date', 'date'), field('progress', 'Progress', 'select', { ...required, options: ['planned', 'in_progress', 'complete'] }), field('notes', 'Skills / certificate reference', 'textarea')] },
    { key: 'resignations', label: 'Resignation', group: 'Employee Exit', employee: true, approval: true, fields: [field('lastWorkingDate', 'Last working date', 'date', required), field('reason', 'Reason', 'textarea', required)] },
    { key: 'clearance', label: 'Clearance', group: 'Employee Exit', employee: true, approval: true, fields: [field('department', 'Clearing department', 'text', required), field('assetsReturned', 'Assets returned', 'select', { ...required, options: ['yes', 'no', 'not_applicable'] }), field('notes', 'Clearance notes', 'textarea', required)] },
    { key: 'settlements', label: 'Final Settlement', group: 'Employee Exit', employee: true, approval: true, monetary: true, fields: [field('reason', 'Calculation / entitlement details', 'textarea', required)] },
    { key: 'approval-rules', label: 'Approval Rules', group: 'Reports & Settings', fields: [field('workflow', 'Workflow', 'select', { ...required, options: ['leave', 'payroll', 'transfers', 'overtime', 'components', 'loans', 'reimbursements', 'benefits', 'commissions', 'appraisals', 'resignations', 'clearance', 'settlements'] }), field('minimumAmount', 'Amount threshold', 'number', { min: 0, max: 100000000 }), field('approverRoleId', 'Required approver role', 'select', { ...required, lookup: 'roles' })] },
];
export const hrCatalog = new Map(hrRegisters.map(r => [r.key, r]));
export function registerSchema(register: HrRegister) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const f of register.fields) {
        let schema: z.ZodTypeAny;
        if (f.type === 'number')
            schema = z.number().finite().min(f.min ?? 0).max(f.max ?? 100000000);
        else if (f.type === 'date')
            schema = z.string().date();
        else if (f.type === 'time')
            schema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm time');
        else if (f.options)
            schema = z.enum(f.options as [
                string,
                ...string[]
            ]);
        else if (f.type === 'email')
            schema = z.string().trim().email().max(200);
        else
            schema = z.string().trim().min(1).max(f.type === 'textarea' ? 4000 : 200);
        shape[f.key] = f.required ? schema : schema.optional().nullable();
    }
    return z.object({
        branchId: z.string().min(1), title: z.string().trim().min(1).max(200), date: z.string().date(),
        employeeId: register.employee ? z.string().min(1) : z.string().optional().nullable(),
        amount: register.monetary ? z.number().finite().positive().max(100000000) : z.number().finite().min(0).max(100000000).default(0),
        data: z.object(shape).strict(), version: z.number().int().positive().optional(),
    }).strict();
}
