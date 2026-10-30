require('dotenv/config')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Backfills permissions/module grants added by later features (purchase
// orders, approvals, alerts, documents, settings) into a database that was
// originally seeded before those existed. Idempotent — safe to run more
// than once. Does not touch users, branches, or any transactional data.
// Run with: npm run db:sync-permissions

const permissionsData = [
  { key: 'free_dish_manage', module: 'free_dish', description: 'Manage free items, section offers, registrations and exports' },
  { key: 'free_dish_redeem', module: 'free_dish', description: 'Verify and explicitly redeem Free Dish vouchers' },
  { key: 'can_view_hr', module: 'hr', description: 'View employee, attendance, leave and talent records' },
  { key: 'can_manage_hr', module: 'hr', description: 'Manage employees, attendance and HR workflow submissions' },
  { key: 'can_approve_hr', module: 'hr', description: 'Approve leave, transfers and employee financial requests' },
  { key: 'can_view_payroll', module: 'hr', description: 'View confidential salary details, payroll and payslips' },
  { key: 'can_process_payroll', module: 'hr', description: 'Prepare salary structures, adjustments and payroll drafts' },
  { key: 'can_approve_payroll', module: 'hr', description: 'Approve payroll and post the salary accrual' },
  { key: 'can_pay_salaries', module: 'hr', description: 'Record salary and employee advance payments' },
  { key: 'can_configure_hr', module: 'hr', description: 'Configure HR policy, approver rules and posting accounts' },
  // Sales
  { key: 'can_create_sales', module: 'sales', description: 'Create daily sales' },
  { key: 'can_approve_sales', module: 'sales', description: 'Approve sales' },
  { key: 'can_void_sales', module: 'sales', description: 'Void sales' },
  // Cash Closing
  { key: 'can_create_cash_closing', module: 'cash_closing', description: 'Create cash closings' },
  { key: 'can_approve_cash_closing', module: 'cash_closing', description: 'Approve cash closings' },
  // Expenses
  { key: 'can_create_expense', module: 'expenses', description: 'Create expenses' },
  { key: 'can_approve_expense', module: 'expenses', description: 'Approve expenses' },
  { key: 'can_void_expense', module: 'expenses', description: 'Void expenses' },
  // Suppliers & Bills
  { key: 'can_manage_suppliers', module: 'suppliers', description: 'Manage suppliers and create bills' },
  { key: 'can_create_bill', module: 'bills', description: 'Create bills' },
  { key: 'can_approve_bill', module: 'bills', description: 'Approve bills' },
  { key: 'can_make_payment', module: 'bills', description: 'Record bill payments' },
  // Inventory
  { key: 'can_manage_inventory', module: 'inventory', description: 'Manage inventory items and stock' },
  { key: 'can_transfer_stock', module: 'inventory', description: 'Transfer stock between branches' },
  { key: 'can_approve_wastage', module: 'inventory', description: 'Approve wastage reports' },
  // Purchase Orders
  { key: 'can_create_purchase_order', module: 'purchase_orders', description: 'Create purchase orders' },
  { key: 'can_approve_purchase_order', module: 'purchase_orders', description: 'Approve purchase orders and receive stock' },
  // Purchasing (one-shot vendor purchase entry)
  { key: 'can_create_purchasing_entry', module: 'purchasing', description: 'Create purchasing entries (vendor purchases)' },
  // Approvals & Alerts
  { key: 'can_view_approvals', module: 'approvals', description: 'View the unified approvals inbox' },
  { key: 'can_view_alerts', module: 'alerts', description: 'View the alerts module' },
  // Accounting
  { key: 'can_manage_accounting', module: 'accounting', description: 'Manage chart of accounts and journal entries' },
  { key: 'can_post_journal', module: 'accounting', description: 'Post journal entries to ledger' },
  { key: 'can_void_journal', module: 'accounting', description: 'Void journal entries' },
  // Reports
  { key: 'can_view_reports', module: 'reports', description: 'View reports' },
  { key: 'can_export_reports', module: 'reports', description: 'Export reports' },
  { key: 'can_view_financial_reports', module: 'reports', description: 'View financial reports' },
  // Admin
  { key: 'can_manage_users', module: 'users', description: 'Manage users' },
  { key: 'can_manage_roles', module: 'users', description: 'Manage roles and permissions' },
  { key: 'can_create_branch', module: 'branches', description: 'Create and manage branches' },
  { key: 'can_view_audit_logs', module: 'settings', description: 'View audit logs' },
  { key: 'can_manage_settings', module: 'settings', description: 'Manage organization settings' },
  // Chart of Accounts
  { key: 'accounts_view', module: 'accounts', description: 'View chart of accounts' },
  { key: 'accounts_create', module: 'accounts', description: 'Create accounts' },
  { key: 'accounts_edit', module: 'accounts', description: 'Edit accounts' },
  { key: 'accounts_archive', module: 'accounts', description: 'Archive/restore accounts' },
  { key: 'accounts_delete_unused', module: 'accounts', description: 'Delete accounts with no journal activity' },
  { key: 'accounts_import', module: 'accounts', description: 'Import chart of accounts' },
  { key: 'accounts_export', module: 'accounts', description: 'Export chart of accounts / reports' },
  { key: 'accounts_view_ledger', module: 'accounts', description: 'View account ledgers and balances' },
  { key: 'bank_accounts_manage', module: 'accounts', description: 'Manage bank accounts' },
  { key: 'opening_balances_post', module: 'accounts', description: 'Post opening balances' },
  { key: 'tax_rates_manage', module: 'accounts', description: 'Manage tax rates' },
  { key: 'account_mappings_manage', module: 'accounts', description: 'Manage account mappings' },
  { key: 'accounting_periods_manage', module: 'accounts', description: 'Lock/unlock/close accounting periods' },
  { key: 'manual_journals_create', module: 'accounts', description: 'Create manual journal entries' },
  { key: 'manual_journals_post', module: 'accounts', description: 'Post manual journal entries' },
  { key: 'journals_reverse', module: 'accounts', description: 'Reverse posted journal entries' },
  // Menu & QR Ordering
  { key: 'can_manage_menu', module: 'menu', description: 'Manage menu categories, dishes, shifts and tables / QR codes' },
  { key: 'can_manage_orders', module: 'orders', description: 'View, complete and cancel table orders' },
  { key: 'can_manage_kitchen', module: 'kitchen', description: 'Kitchen display: update item status and mark dishes out of stock' },
  { key: 'can_view_reviews', module: 'reviews', description: 'View and moderate customer reviews' },
  { key: 'can_take_call_center_orders', module: 'call_center', description: 'Take phone orders using customer lookup and branch delivery zones' },
  { key: 'can_manage_delivery', module: 'delivery', description: 'Dispatch own riders and confirm delivery and COD cash collection' },
  { key: 'can_manage_delivery_settings', module: 'delivery', description: 'Configure own delivery zones and riders' },
  { key: 'can_settle_rider_cash', module: 'delivery', description: 'Receive and reconcile rider cash into an open till' },
  { key: 'can_deliver_orders', module: 'rider', description: 'Rider: see own assigned deliveries and mark them picked up, delivered or failed' },
  { key: 'can_take_orders', module: 'floor', description: 'Seat guests and take table orders without checkout' },
  { key: 'can_manage_customers', module: 'customers', description: 'Edit customers, tags and house accounts; receive account payments' },
  { key: 'can_manage_payments', module: 'payments', description: 'See online and terminal payments; refund payments that could not be applied' },
  { key: 'can_manage_checkout_devices', module: 'settings', description: 'Pair and revoke customer displays and self-service kiosks' },
  { key: 'can_use_pos', module: 'pos', description: 'Point of sale: take dine-in, takeaway and delivery orders and payments' },
    { key: 'can_manage_tills', module: 'pos', description: 'Manage till sessions and view X/Z reports' },
    { key: 'can_void_items', module: 'orders', description: 'Void order items and unpaid orders' },
    { key: 'can_refund', module: 'orders', description: 'Refund paid orders' },
    { key: 'can_open_drawer', module: 'pos', description: 'Authorize drawer openings and cash movements' },
    { key: 'can_apply_discount', module: 'orders', description: 'Give discounts above the staff discount limit' },
]

const accountantPerms = [
  'can_approve_cash_closing',
  'can_approve_expense', 'can_void_expense',
  'can_manage_suppliers', 'can_approve_bill', 'can_make_payment',
  'can_manage_accounting', 'can_post_journal', 'can_void_journal',
  'can_view_reports', 'can_view_financial_reports', 'can_export_reports',
  'can_view_approvals', 'can_view_alerts',
  'accounts_view', 'accounts_create', 'accounts_edit',
  'accounts_import', 'accounts_export', 'accounts_view_ledger',
  'opening_balances_post', 'account_mappings_manage', 'accounting_periods_manage',
  'manual_journals_create', 'manual_journals_post', 'journals_reverse',
]

const managerPerms = [
  'can_create_sales', 'can_approve_sales', 'can_void_sales',
  'can_create_cash_closing', 'can_approve_cash_closing',
  'can_create_expense', 'can_approve_expense', 'can_void_expense',
  'can_manage_suppliers', 'can_create_bill', 'can_approve_bill',
  'can_manage_inventory', 'can_transfer_stock', 'can_approve_wastage',
  'can_create_purchase_order', 'can_approve_purchase_order', 'can_create_purchasing_entry',
  'can_view_approvals', 'can_view_alerts',
  'can_view_reports',
  'accounts_view', 'accounts_view_ledger',
  'can_manage_menu', 'can_manage_orders', 'can_manage_kitchen', 'can_view_reviews', 'can_use_pos', 'can_apply_discount',
    'can_manage_tills', 'can_void_items', 'can_refund', 'can_open_drawer',
    'can_take_call_center_orders', 'can_manage_delivery', 'can_manage_delivery_settings', 'can_settle_rider_cash', 'can_take_orders', 'can_manage_customers', 'can_manage_payments', 'can_manage_checkout_devices',
]

const cashierPerms = [
  'can_create_sales',
  'can_create_cash_closing',
  'can_create_expense',
  'can_create_purchase_order', 'can_create_purchasing_entry',
  'accounts_view',
  'can_manage_orders', 'can_use_pos', 'can_take_orders',
]

// Store Keeper: Purchasing + Inventory (incl. branch-to-branch transfers),
// limited to the single branch assigned to the user — the branch limit is
// enforced in code (backend/src/utils/branchScope.ts), not by permissions.
const storeKeeperPerms = [
  'can_create_purchasing_entry',
  'can_manage_inventory', 'can_transfer_stock',
]

const allKeys = permissionsData.map((p) => p.key)

// Administrator has everything except Users & Roles, Branches and Settings
const adminExcluded = ['can_manage_users', 'can_manage_roles', 'can_create_branch', 'can_manage_settings']

const roleGrants = {
  hr_manager: ['can_view_hr', 'can_manage_hr', 'can_approve_hr', 'can_view_payroll', 'can_process_payroll'],
  hr_officer: ['can_view_hr', 'can_manage_hr'],
  super_admin: allKeys,
  admin: allKeys.filter((k) => !adminExcluded.includes(k)),
  accountant: accountantPerms,
  branch_manager: managerPerms,
  cashier: cashierPerms,
  store_keeper: storeKeeperPerms,
  kitchen_staff: ['can_manage_kitchen'],
  call_center_agent: ['can_take_call_center_orders'],
  dispatcher: ['can_manage_delivery'],
  rider: ['can_deliver_orders'],
  waiter: ['can_take_orders'],
}

// Roles added after the original seed — created per organization if missing
const newRoles = [
  { name: 'hr_manager', displayName: 'HR Manager', description: 'Manage people, approve HR requests and prepare payroll; separate payroll approval and payment grants' },
  { name: 'hr_officer', displayName: 'HR Officer', description: 'Employee, attendance and leave administration without confidential payroll access' },
  { name: 'waiter', displayName: 'Waiter', description: 'Seat guests and take table orders; no payments' },
  { name: 'call_center_agent', displayName: 'Call Centre Agent', description: 'Take delivery and takeaway phone orders; no checkout' },
  { name: 'dispatcher', displayName: 'Dispatcher', description: 'Dispatch in-house riders and confirm COD collection; no till settlement' },
  { name: 'rider', displayName: 'Rider', description: 'Own rider login: only their assigned deliveries; no POS, payments or other orders' },
  { name: 'store_keeper', displayName: 'Store Keeper', description: 'Purchasing and inventory for one branch, including branch-to-branch transfers' },
  { name: 'kitchen_staff', displayName: 'Kitchen Staff', description: 'Kitchen display: incoming table orders and dish availability' },
]

async function main() {
  console.log('Syncing permissions...')

  const permissionIds = {}
  let permsCreated = 0
  for (const perm of permissionsData) {
    const existing = await prisma.permission.findUnique({ where: { key: perm.key } })
    const row = await prisma.permission.upsert({
      where: { key: perm.key },
      update: {},
      create: perm,
    })
    permissionIds[perm.key] = row.id
    if (!existing) permsCreated++
  }
  console.log(`Permissions: ${permsCreated} created, ${permissionsData.length - permsCreated} already present.`)

  const orgs = await prisma.organization.findMany({ select: { id: true } })
  for (const org of orgs) {
    for (const name of ['Wrong item', 'Guest changed mind', 'Kitchen error', 'Quality issue', 'Other']) await prisma.voidReason.upsert({ where: { organizationId_name: { organizationId: org.id, name } }, update: {}, create: { organizationId: org.id, name } })
    for (const r of newRoles) {
      const exists = await prisma.role.findUnique({ where: { organizationId_name: { organizationId: org.id, name: r.name } } })
      if (!exists) {
        await prisma.role.create({ data: { organizationId: org.id, isSystemRole: true, ...r } })
        console.log(`Created role "${r.displayName}"`)
      }
    }
  }

  const roles = await prisma.role.findMany({ where: { name: { in: Object.keys(roleGrants) } } })
  console.log(`Found roles: ${roles.map((r) => r.name).join(', ') || '(none matched)'}`)

  let grantsCreated = 0
  for (const role of roles) {
    const keys = roleGrants[role.name] || []
    for (const key of keys) {
      const permissionId = permissionIds[key]
      if (!permissionId) continue
      const existing = await prisma.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
      })
      if (existing) continue
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId } })
      grantsCreated++
    }
  }
  console.log(`Role grants: ${grantsCreated} newly added.`)

  // Older databases gave Administrator every permission — remove the
  // Super-Admin-only ones from it.
  const adminRoleIds = roles.filter((r) => r.name === 'admin').map((r) => r.id)
  const excludedIds = adminExcluded.map((k) => permissionIds[k]).filter(Boolean)
  const removed = await prisma.rolePermission.deleteMany({
    where: { roleId: { in: adminRoleIds }, permissionId: { in: excludedIds } },
  })
  await prisma.role.updateMany({
    where: { id: { in: adminRoleIds } },
    data: { description: 'Full access except Users & Roles, Branches and Settings' },
  })
  console.log(`Administrator: ${removed.count} Super-Admin-only grant(s) removed.`)
  console.log('Done. Existing users will see the new modules after their next login/page-refresh.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
