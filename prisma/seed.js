require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')
const { createChartOfAccounts } = require('./reference-data')

const prisma = new PrismaClient()

async function main() {
  await prisma.hrPayrollPayment.deleteMany()
  await prisma.hrPayrollLine.deleteMany()
  await prisma.hrPayrollRun.deleteMany()
  await prisma.hrLeaveRequest.deleteMany()
  await prisma.hrAttendance.deleteMany()
  await prisma.hrRecord.deleteMany()
  await prisma.hrEmployee.deleteMany()
  await prisma.hrSettings.deleteMany()
  console.log('Seeding database...')

  // ─── Clean existing data ──────────────────────────────────────────────────────
  await prisma.auditLog.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.wastageItem.deleteMany()
  await prisma.wastageReport.deleteMany()
  await prisma.stockMovement.deleteMany()
  await prisma.branchStock.deleteMany()
  await prisma.purchaseOrderItem.deleteMany()
  await prisma.purchaseOrder.deleteMany()
  await prisma.item.deleteMany()
  await prisma.itemCategory.deleteMany()
  await prisma.payment.deleteMany()
  await prisma.billItem.deleteMany()
  await prisma.bill.deleteMany()
  await prisma.supplier.deleteMany()
  await prisma.expense.deleteMany()
  await prisma.expenseCategory.deleteMany()
  await prisma.deliveryBreakdown.deleteMany()
  await prisma.dailySale.deleteMany()
  await prisma.cashClosing.deleteMany()
  await prisma.journalLine.deleteMany()
  await prisma.journalEntry.deleteMany()
  await prisma.document.deleteMany()
  await prisma.accountingMapping.deleteMany()
  await prisma.bankAccount.deleteMany()
  await prisma.taxRate.deleteMany()
  await prisma.accountingPeriod.deleteMany()
  await prisma.account.deleteMany()
  await prisma.rolePermission.deleteMany()
  await prisma.permission.deleteMany()
  await prisma.userBranchAccess.deleteMany()
  await prisma.userRole.deleteMany()
  await prisma.role.deleteMany()
  await prisma.refreshToken.deleteMany()
  await prisma.user.deleteMany()
  await prisma.branch.deleteMany()
  await prisma.organization.deleteMany()
  console.log('Cleaned existing data')

  // ─── Organization ─────────────────────────────────────────────────────────────
  const org = await prisma.organization.create({
    data: {
      name: 'FoodSync Demo Restaurant',
      tradeName: 'FoodSync Demo',
      registrationNo: 'NTN-1234567-8',
      vatNumber: 'STRN-3277876543210',
      email: 'info@foodsync.pk',
      phone: '+924235761234',
      address: 'MM Alam Road, Gulberg III',
      city: 'Lahore',
      country: 'PK',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      fiscalYearStart: '01-01',
    },
  })
  for (const name of ['Wrong item', 'Guest changed mind', 'Kitchen error', 'Quality issue', 'Other']) await prisma.voidReason.create({ data: { organizationId: org.id, name } })

  console.log('Organization created:', org.name)

  // ─── Branches ─────────────────────────────────────────────────────────────────
  const branchGulberg = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: 'Gulberg Branch',
      code: 'GLB',
      city: 'Lahore',
      address: 'MM Alam Road, Gulberg III, Lahore',
      phone: '+924235762222',
      email: 'gulberg@foodsync.pk',
      vatEnabled: true,
      vatRate: 16,
      salePrefix: 'SL-GLB',
      expensePrefix: 'EXP-GLB',
      invoicePrefix: 'INV-GLB',
    },
  })

  const branchDha = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: 'DHA Branch',
      code: 'DHA',
      city: 'Lahore',
      address: 'Y Block, DHA Phase 3, Lahore',
      phone: '+924235893333',
      email: 'dha@foodsync.pk',
      vatEnabled: true,
      vatRate: 16,
      salePrefix: 'SL-DHA',
      expensePrefix: 'EXP-DHA',
      invoicePrefix: 'INV-DHA',
    },
  })

  const branchClifton = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: 'Clifton Branch',
      code: 'CLF',
      city: 'Karachi',
      address: 'Block 5, Clifton, Karachi',
      phone: '+922135874444',
      email: 'clifton@foodsync.pk',
      vatEnabled: true,
      vatRate: 16,
      salePrefix: 'SL-CLF',
      expensePrefix: 'EXP-CLF',
      invoicePrefix: 'INV-CLF',
    },
  })

  const branches = [branchGulberg, branchDha, branchClifton]
  console.log('Branches created:', branches.map((b) => b.name).join(', '))

  // ─── Chart of Accounts ────────────────────────────────────────────────────────
  // Standard structure recommended for the Chart of Accounts module: control
  // (header) accounts group leaf posting accounts by accountClass; Equity is
  // fully represented (previously excluded from reporting entirely).
  const accounts = await createChartOfAccounts(prisma, org.id)

  // ─── Permissions ──────────────────────────────────────────────────────────────
  // Keys must match the PERMISSIONS constants in frontend/src/lib/constants.ts
  const permissionsData = [
    { key: 'can_view_hr', module: 'hr', description: 'View employee, attendance, leave and talent records' },
    { key: 'can_manage_hr', module: 'hr', description: 'Manage employees, attendance and HR submissions' },
    { key: 'can_approve_hr', module: 'hr', description: 'Approve leave and HR workflows' },
    { key: 'can_view_payroll', module: 'hr', description: 'View confidential salary and payroll records' },
    { key: 'can_process_payroll', module: 'hr', description: 'Prepare salary structures and payroll' },
    { key: 'can_approve_payroll', module: 'hr', description: 'Approve and post payroll accruals' },
    { key: 'can_pay_salaries', module: 'hr', description: 'Record salary and employee advance payments' },
    { key: 'can_configure_hr', module: 'hr', description: 'Configure HR policy and posting accounts' },
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

  const permissions = {}
  for (const perm of permissionsData) {
    const created = await prisma.permission.create({ data: perm })
    permissions[perm.key] = created.id
  }
  console.log(`Created ${permissionsData.length} permissions`)

  // ─── Roles ────────────────────────────────────────────────────────────────────
  const allPermIds = Object.values(permissions)

  const superAdminRole = await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'super_admin',
      displayName: 'Super Admin',
      description: 'Full system access',
      isSystemRole: true,
      permissions: {
        create: allPermIds.map((id) => ({ permissionId: id })),
      },
    },
  })

  // Administrator: everything except Users & Roles, Branches and Settings
  const adminExcluded = ['can_manage_users', 'can_manage_roles', 'can_create_branch', 'can_manage_settings']
  const adminPermIds = Object.entries(permissions).filter(([key]) => !adminExcluded.includes(key)).map(([, id]) => id)
  const adminRole = await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'admin',
      displayName: 'Administrator',
      description: 'Full access except Users & Roles, Branches and Settings',
      isSystemRole: true,
      permissions: {
        create: adminPermIds.map((id) => ({ permissionId: id })),
      },
    },
  })

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

  const accountantRole = await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'accountant',
      displayName: 'Accountant',
      description: 'Access to accounting, bills, and reports',
      isSystemRole: true,
      permissions: {
        create: accountantPerms.map((key) => ({ permissionId: permissions[key] })),
      },
    },
  })

  for (const [name, displayName, keys] of [
    ['call_center_agent', 'Call Centre Agent', ['can_take_call_center_orders']],
    ['dispatcher', 'Dispatcher', ['can_manage_delivery']],
    ['rider', 'Rider', ['can_deliver_orders']],
    ['waiter', 'Waiter', ['can_take_orders']],
  ]) await prisma.role.create({ data: { organizationId: org.id, name, displayName, isSystemRole: true, permissions: { create: keys.map((key) => ({ permissionId: permissions[key] })) } } })

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

  const branchManagerRole = await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'branch_manager',
      displayName: 'Branch Manager',
      description: 'Branch-level management access',
      isSystemRole: true,
      permissions: {
        create: managerPerms.map((key) => ({ permissionId: permissions[key] })),
      },
    },
  })

  const cashierPerms = [
    'can_create_sales',
    'can_create_cash_closing',
    'can_create_expense',
    'can_create_purchase_order', 'can_create_purchasing_entry',
    'accounts_view',
    'can_manage_orders', 'can_use_pos', 'can_take_orders',
  ]

  // Store Keeper: Purchasing + Inventory for exactly one branch (the branch
  // limit is enforced in backend/src/utils/branchScope.ts)
  await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'store_keeper',
      displayName: 'Store Keeper',
      description: 'Purchasing and inventory for one branch, including branch-to-branch transfers',
      isSystemRole: true,
      permissions: {
        create: ['can_create_purchasing_entry', 'can_manage_inventory', 'can_transfer_stock'].map((key) => ({ permissionId: permissions[key] })),
      },
    },
  })

  // Kitchen Staff: the kitchen display (incoming table orders, out-of-stock switch)
  await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'kitchen_staff',
      displayName: 'Kitchen Staff',
      description: 'Kitchen display: incoming table orders and dish availability',
      isSystemRole: true,
      permissions: { create: [{ permissionId: permissions.can_manage_kitchen }] },
    },
  })

  const cashierRole = await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'cashier',
      displayName: 'Cashier',
      description: 'Daily sales and cash closing entry',
      isSystemRole: true,
      permissions: {
        create: cashierPerms.map((key) => ({ permissionId: permissions[key] })),
      },
    },
  })

  console.log('Roles created:', [superAdminRole, adminRole, accountantRole, branchManagerRole, cashierRole].map(r => r.name).join(', '))

  // ─── Admin User ───────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Admin@123', 10)

  const adminUser = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'admin@foodsync.pk',
      passwordHash,
      firstName: 'Super',
      lastName: 'Admin',
      phone: '+923001234567',
      isActive: true,
    },
  })

  // Assign super_admin role
  await prisma.userRole.create({
    data: { userId: adminUser.id, roleId: superAdminRole.id },
  })

  // Grant access to all branches
  for (const branch of branches) {
    await prisma.userBranchAccess.create({
      data: {
        userId: adminUser.id,
        organizationId: org.id,
        branchId: branch.id,
        canView: true,
        canCreate: true,
        canApprove: true,
      },
    })
  }

  // Additional manager user
  const managerHash = await bcrypt.hash('Manager@123', 10)
  const managerUser = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'manager@foodsync.pk',
      passwordHash: managerHash,
      firstName: 'Usman',
      lastName: 'Tariq',
      phone: '+923002222222',
      isActive: true,
    },
  })
  await prisma.userRole.create({ data: { userId: managerUser.id, roleId: branchManagerRole.id } })
  await prisma.userBranchAccess.create({
    data: {
      userId: managerUser.id,
      organizationId: org.id,
      branchId: branchGulberg.id,
      canView: true,
      canCreate: true,
      canApprove: true,
    },
  })

  // Accountant user
  const acctHash = await bcrypt.hash('Accountant@123', 10)
  const acctUser = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: 'accountant@foodsync.pk',
      passwordHash: acctHash,
      firstName: 'Ayesha',
      lastName: 'Khan',
      phone: '+923003333333',
      isActive: true,
    },
  })
  await prisma.userRole.create({ data: { userId: acctUser.id, roleId: accountantRole.id } })
  for (const branch of branches) {
    await prisma.userBranchAccess.create({
      data: {
        userId: acctUser.id,
        organizationId: org.id,
        branchId: branch.id,
        canView: true,
        canCreate: false,
        canApprove: true,
      },
    })
  }

  console.log('Users created:', [adminUser, managerUser, acctUser].map(u => u.email).join(', '))

  // ─── Expense Categories ───────────────────────────────────────────────────────
  const categoryNames = [
    { name: 'Food Purchases', accountId: accounts['5100'] },
    { name: 'Salaries', accountId: accounts['6100'] },
    { name: 'Rent', accountId: accounts['6200'] },
    { name: 'Utilities', accountId: accounts['6300'] },
    { name: 'Delivery Charges', accountId: accounts['5400'] },
    { name: 'Maintenance', accountId: accounts['6700'] },
    { name: 'Marketing', accountId: accounts['6400'] },
    { name: 'Miscellaneous', accountId: accounts['6990'] },
    { name: 'Packaging', accountId: accounts['5400'] },
  ]

  for (const cat of categoryNames) {
    await prisma.expenseCategory.create({
      data: { ...cat, organizationId: org.id },
    })
  }
  console.log('Expense categories created')

  // ─── Item Categories (catalog groupings with a default unit of measure) ──────
  const categoriesData = [
    { name: 'Oils', description: 'Cooking and finishing oils', unit: 'litre' },
    { name: 'Meat', description: 'Fresh and frozen meats', unit: 'kg' },
    { name: 'Grains', description: 'Rice, flour, and other staples', unit: 'kg' },
    { name: 'Condiments', description: 'Sauces, pastes, and seasonings', unit: 'kg' },
    { name: 'Vegetables', description: 'Fresh produce', unit: 'kg' },
    { name: 'Spices', description: 'Dried spices and spice blends', unit: 'kg' },
    { name: 'Beverages', description: 'Bottled and packaged drinks', unit: 'case' },
  ]

  const categories = {}
  for (const cat of categoriesData) {
    const created = await prisma.itemCategory.create({
      data: { ...cat, organizationId: org.id },
    })
    categories[cat.name] = created.id
  }
  console.log(`Created ${categoriesData.length} item categories`)

  // ─── Inventory Items (catalog only — zero stock until real purchases/counts) ──
  const itemsData = [
    { code: 'OIL-001', name: 'Olive Oil', category: 'Oils', unit: 'litre', costPrice: 45, reorderPoint: 20 },
    { code: 'CHK-001', name: 'Chicken Breast', category: 'Meat', unit: 'kg', costPrice: 28, reorderPoint: 50 },
    { code: 'RIC-001', name: 'Basmati Rice', category: 'Grains', unit: 'kg', costPrice: 12, reorderPoint: 100 },
    { code: 'TOM-001', name: 'Tomato Paste', category: 'Condiments', unit: 'kg', costPrice: 18, reorderPoint: 30 },
    { code: 'LAM-001', name: 'Lamb Meat', category: 'Meat', unit: 'kg', costPrice: 65, reorderPoint: 30 },
    { code: 'FLR-001', name: 'Flour', category: 'Grains', unit: 'kg', costPrice: 5, reorderPoint: 100 },
    { code: 'ONI-001', name: 'Onions', category: 'Vegetables', unit: 'kg', costPrice: 4, reorderPoint: 50 },
    { code: 'GAR-001', name: 'Garlic', category: 'Vegetables', unit: 'kg', costPrice: 22, reorderPoint: 20 },
    { code: 'SPE-001', name: 'Mixed Spices', category: 'Spices', unit: 'kg', costPrice: 85, reorderPoint: 10 },
    { code: 'BOT-001', name: 'Water Bottles (Case)', category: 'Beverages', unit: 'case', costPrice: 25, reorderPoint: 30 },
  ]

  const items = {}
  for (const item of itemsData) {
    const created = await prisma.item.create({
      data: { ...item, categoryId: categories[item.category], organizationId: org.id },
    })
    items[item.code] = created.id
  }
  console.log('Inventory items created')

  // ─── Branch Stock — start every branch at zero on-hand quantity ──────────────
  // Real stock will only ever move because a Purchase Order was received or a
  // stock-in/wastage entry was recorded — never fabricated.
  for (const item of itemsData) {
    for (const branch of branches) {
      await prisma.branchStock.create({
        data: {
          organizationId: org.id,
          branchId: branch.id,
          itemId: items[item.code],
          quantityOnHand: 0,
          averageCost: item.costPrice,
          totalValue: 0,
          reorderPoint: item.reorderPoint,
        },
      })
    }
  }
  console.log('Branch stock initialized at zero (real reorder points, no fake quantities)')

  // ─── Suppliers (master data — no fabricated bills/purchase orders) ──────────
  await prisma.supplier.create({
    data: {
      organizationId: org.id,
      name: 'Al-Noor Traders',
      tradeName: 'Al-Noor',
      vatNumber: 'STRN-3277871234567',
      email: 'orders@alnoortraders.pk',
      phone: '+924237654321',
      address: 'Akbari Mandi, Lahore',
      city: 'Lahore',
      creditLimit: 100000,
      paymentTermsDays: 30,
      notes: 'Primary food supplier',
    },
  })

  await prisma.supplier.create({
    data: {
      organizationId: org.id,
      name: 'Jodia Bazaar Spices',
      tradeName: 'Jodia Spices',
      vatNumber: 'STRN-1700111222333',
      email: 'info@jodiaspices.pk',
      phone: '+922132411222',
      address: 'Jodia Bazaar, Karachi',
      city: 'Karachi',
      creditLimit: 50000,
      paymentTermsDays: 15,
    },
  })
  console.log('Suppliers created')

  console.log('\n=== SEED COMPLETE (structural/reference data only — no fabricated transactions) ===')
  console.log(`Organization: ${org.name} (${org.id})`)
  console.log(`Branches: ${branches.map((b) => `${b.name} (${b.id})`).join(', ')}`)
  console.log('\nLogin credentials:')
  console.log('  Admin:      admin@foodsync.pk     / Admin@123')
  console.log('  Manager:    manager@foodsync.pk   / Manager@123')
  console.log('  Accountant: accountant@foodsync.pk / Accountant@123')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
