require('dotenv/config')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Backfills permissions/module grants added by later features (purchase
// orders, approvals, alerts, documents, settings) into a database that was
// originally seeded before those existed. Idempotent — safe to run more
// than once. Does not touch users, branches, or any transactional data.
// Run with: npm run db:sync-permissions

const permissionsData = [
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
  'can_create_purchase_order', 'can_approve_purchase_order',
  'can_view_approvals', 'can_view_alerts',
  'can_view_reports',
  'accounts_view', 'accounts_view_ledger',
]

const cashierPerms = [
  'can_create_sales',
  'can_create_cash_closing',
  'can_create_expense',
  'can_create_purchase_order',
  'accounts_view',
]

const allKeys = permissionsData.map((p) => p.key)

const roleGrants = {
  super_admin: allKeys,
  admin: allKeys,
  accountant: accountantPerms,
  branch_manager: managerPerms,
  cashier: cashierPerms,
}

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
