require('dotenv/config')
const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
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
      name: 'Zaitoon Restaurant Group',
      tradeName: 'Zaitoon',
      registrationNo: 'CR-1234567890',
      vatNumber: '300123456789003',
      email: 'info@zaitoon.com',
      phone: '+966501234567',
      address: 'King Fahd Road, Al Olaya District',
      city: 'Riyadh',
      country: 'SA',
      currency: 'SAR',
      fiscalYearStart: '01-01',
    },
  })
  console.log('Organization created:', org.name)

  // ─── Branches ─────────────────────────────────────────────────────────────────
  const branchMakkah = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: 'Makkah Branch',
      code: 'MKH',
      city: 'Makkah',
      address: 'Al Aziziyah District, Makkah',
      phone: '+966502222111',
      email: 'makkah@zaitoon.com',
      vatEnabled: true,
      vatRate: 15,
      salePrefix: 'SL-MKH',
      expensePrefix: 'EXP-MKH',
      invoicePrefix: 'INV-MKH',
    },
  })

  const branchMadina1 = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: 'Madina Branch 1',
      code: 'MDN1',
      city: 'Madina',
      address: 'Al Anbariyah District, Madina',
      phone: '+966503333222',
      email: 'madina1@zaitoon.com',
      vatEnabled: true,
      vatRate: 15,
      salePrefix: 'SL-MD1',
      expensePrefix: 'EXP-MD1',
      invoicePrefix: 'INV-MD1',
    },
  })

  const branchMadina2 = await prisma.branch.create({
    data: {
      organizationId: org.id,
      name: 'Madina Branch 2',
      code: 'MDN2',
      city: 'Madina',
      address: 'Quba District, Madina',
      phone: '+966504444333',
      email: 'madina2@zaitoon.com',
      vatEnabled: true,
      vatRate: 15,
      salePrefix: 'SL-MD2',
      expensePrefix: 'EXP-MD2',
      invoicePrefix: 'INV-MD2',
    },
  })

  const branches = [branchMakkah, branchMadina1, branchMadina2]
  console.log('Branches created:', branches.map((b) => b.name).join(', '))

  // ─── Chart of Accounts ────────────────────────────────────────────────────────
  // Standard structure recommended for the Chart of Accounts module: control
  // (header) accounts group leaf posting accounts by accountClass; Equity is
  // fully represented (previously excluded from reporting entirely).
  const accountsData = [
    { code: '1000', name: 'Assets', accountClass: 'ASSET', isControlAccount: true, isSystem: true },
    { code: '1100', name: 'Current Assets', accountClass: 'ASSET', isControlAccount: true, isSystem: true, parentCode: '1000' },
    { code: '1110', name: 'Cash on Hand', accountClass: 'ASSET', reportingGroup: 'Cash', parentCode: '1100' },
    { code: '1120', name: 'Bank Accounts', accountClass: 'ASSET', reportingGroup: 'Bank', parentCode: '1100' },
    { code: '1150', name: 'Card Clearing', accountClass: 'ASSET', reportingGroup: 'Bank', parentCode: '1100' },
    { code: '1200', name: 'Accounts Receivable', accountClass: 'ASSET', reportingGroup: 'Accounts Receivable', parentCode: '1100' },
    { code: '1300', name: 'Inventory', accountClass: 'ASSET', reportingGroup: 'Inventory', parentCode: '1100' },
    { code: '1400', name: 'Input VAT', accountClass: 'ASSET', reportingGroup: 'Input VAT', parentCode: '1100' },
    { code: '1500', name: 'Prepayments', accountClass: 'ASSET', reportingGroup: 'Prepayments', parentCode: '1100' },
    { code: '1600', name: 'Fixed Assets', accountClass: 'ASSET', isControlAccount: true, isSystem: true, parentCode: '1000' },
    { code: '1610', name: 'Furniture and Equipment', accountClass: 'ASSET', reportingGroup: 'Fixed Assets', parentCode: '1600' },
    { code: '1620', name: 'Kitchen Equipment', accountClass: 'ASSET', reportingGroup: 'Fixed Assets', parentCode: '1600' },
    { code: '1690', name: 'Accumulated Depreciation', accountClass: 'ASSET', reportingGroup: 'Accumulated Depreciation', parentCode: '1600' },

    { code: '2000', name: 'Liabilities', accountClass: 'LIABILITY', isControlAccount: true, isSystem: true },
    { code: '2100', name: 'Current Liabilities', accountClass: 'LIABILITY', isControlAccount: true, isSystem: true, parentCode: '2000' },
    { code: '2110', name: 'Accounts Payable', accountClass: 'LIABILITY', reportingGroup: 'Accounts Payable', parentCode: '2100' },
    { code: '2200', name: 'Output VAT', accountClass: 'LIABILITY', reportingGroup: 'Output VAT', parentCode: '2100' },
    { code: '2300', name: 'Accrued Expenses', accountClass: 'LIABILITY', reportingGroup: 'Accrued Expenses', parentCode: '2100' },
    { code: '2400', name: 'Loans Payable', accountClass: 'LIABILITY', reportingGroup: 'Loans', parentCode: '2000' },
    { code: '2500', name: 'Other Liabilities', accountClass: 'LIABILITY', reportingGroup: 'Other Liabilities', parentCode: '2000' },

    { code: '3000', name: 'Equity', accountClass: 'EQUITY', isControlAccount: true, isSystem: true },
    { code: '3100', name: 'Owner Capital', accountClass: 'EQUITY', reportingGroup: 'Owner Capital', parentCode: '3000' },
    { code: '3200', name: 'Retained Earnings', accountClass: 'EQUITY', reportingGroup: 'Retained Earnings', parentCode: '3000' },
    { code: '3300', name: 'Current Year Earnings', accountClass: 'EQUITY', reportingGroup: 'Current Year Earnings', parentCode: '3000', isSystem: true, allowManualPosting: false },
    { code: '3400', name: 'Owner Drawings', accountClass: 'EQUITY', reportingGroup: 'Drawings', parentCode: '3000' },
    { code: '3900', name: 'Opening Balance Equity', accountClass: 'EQUITY', reportingGroup: 'Opening Balance Equity', parentCode: '3000', isSystem: true },

    { code: '4000', name: 'Revenue', accountClass: 'REVENUE', isControlAccount: true, isSystem: true },
    { code: '4100', name: 'Sales Revenue', accountClass: 'REVENUE', reportingGroup: 'Sales Revenue', parentCode: '4000' },
    { code: '4200', name: 'Service Revenue', accountClass: 'REVENUE', reportingGroup: 'Service Revenue', parentCode: '4000' },
    { code: '4300', name: 'Other Income', accountClass: 'REVENUE', reportingGroup: 'Other Income', parentCode: '4000' },
    { code: '4900', name: 'Sales Returns and Discounts', accountClass: 'REVENUE', reportingGroup: 'Discounts', parentCode: '4000' },

    { code: '5000', name: 'Cost of Sales', accountClass: 'EXPENSE', isControlAccount: true, isSystem: true },
    { code: '5100', name: 'Food Purchases and Cost of Sales', accountClass: 'EXPENSE', reportingGroup: 'Cost of Sales', parentCode: '5000' },
    { code: '5200', name: 'Inventory Wastage', accountClass: 'EXPENSE', reportingGroup: 'Wastage', parentCode: '5000' },
    { code: '5300', name: 'Direct Labour', accountClass: 'EXPENSE', reportingGroup: 'Direct Costs', parentCode: '5000' },
    { code: '5400', name: 'Other Direct Costs', accountClass: 'EXPENSE', reportingGroup: 'Direct Costs', parentCode: '5000' },

    { code: '6000', name: 'Operating Expenses', accountClass: 'EXPENSE', isControlAccount: true, isSystem: true },
    { code: '6100', name: 'Salaries and Wages', accountClass: 'EXPENSE', reportingGroup: 'Salaries', parentCode: '6000' },
    { code: '6200', name: 'Rent', accountClass: 'EXPENSE', reportingGroup: 'Rent', parentCode: '6000' },
    { code: '6300', name: 'Utilities', accountClass: 'EXPENSE', reportingGroup: 'Utilities', parentCode: '6000' },
    { code: '6400', name: 'Marketing and Advertising', accountClass: 'EXPENSE', reportingGroup: 'Marketing', parentCode: '6000' },
    { code: '6500', name: 'Bank Charges', accountClass: 'EXPENSE', reportingGroup: 'Bank Charges', parentCode: '6000' },
    { code: '6600', name: 'Cleaning', accountClass: 'EXPENSE', reportingGroup: 'Operating Expense', parentCode: '6000' },
    { code: '6700', name: 'Repairs and Maintenance', accountClass: 'EXPENSE', reportingGroup: 'Operating Expense', parentCode: '6000' },
    { code: '6800', name: 'Depreciation Expense', accountClass: 'EXPENSE', reportingGroup: 'Depreciation', parentCode: '6000' },
    { code: '6900', name: 'Cash Over or Short', accountClass: 'EXPENSE', reportingGroup: 'Cash Over or Short', parentCode: '6000' },
    { code: '6990', name: 'Other Operating Expenses', accountClass: 'EXPENSE', reportingGroup: 'Other Expense', parentCode: '6000' },
  ]

  const NORMAL_BALANCE = { ASSET: 'DEBIT', LIABILITY: 'CREDIT', EQUITY: 'CREDIT', REVENUE: 'CREDIT', EXPENSE: 'DEBIT' }

  const accounts = {}
  for (const acc of accountsData) {
    const { parentCode, ...rest } = acc
    const created = await prisma.account.create({
      data: {
        ...rest,
        normalBalance: NORMAL_BALANCE[acc.accountClass],
        isControlAccount: !!acc.isControlAccount,
        allowManualPosting: acc.allowManualPosting !== undefined ? acc.allowManualPosting : !acc.isControlAccount,
        isSystem: !!acc.isSystem,
        organizationId: org.id,
      },
    })
    accounts[acc.code] = created.id
  }
  for (const acc of accountsData) {
    if (acc.parentCode) {
      await prisma.account.update({ where: { id: accounts[acc.code] }, data: { parentId: accounts[acc.parentCode] } })
    }
  }
  console.log(`Created ${accountsData.length} accounts`)

  // ─── Account Mappings ─────────────────────────────────────────────────────
  // Wires the operational posting roles every module resolves through
  // (resolveMappedAccount in ledger.ts) to the standard chart above — without
  // these, no sale/expense/bill/wastage/cash-closing can post at all.
  const mappingsData = {
    CASH_ON_HAND: '1110',
    DEFAULT_BANK: '1120',
    CARD_CLEARING: '1150',
    ACCOUNTS_RECEIVABLE: '1200',
    ACCOUNTS_PAYABLE: '2110',
    INVENTORY: '1300',
    SALES_REVENUE: '4100',
    OTHER_INCOME: '4300',
    COST_OF_SALES: '5100',
    DEFAULT_EXPENSE: '6990',
    INPUT_VAT: '1400',
    OUTPUT_VAT: '2200',
    WASTAGE_EXPENSE: '5200',
    CASH_OVER_SHORT: '6900',
    RETAINED_EARNINGS: '3200',
    OPENING_BALANCE_EQUITY: '3900',
  }
  for (const [key, code] of Object.entries(mappingsData)) {
    await prisma.accountingMapping.create({ data: { organizationId: org.id, key, accountId: accounts[code] } })
  }
  console.log(`Created ${Object.keys(mappingsData).length} account mappings`)

  // ─── Permissions ──────────────────────────────────────────────────────────────
  // Keys must match the PERMISSIONS constants in frontend/src/lib/constants.ts
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

  const adminRole = await prisma.role.create({
    data: {
      organizationId: org.id,
      name: 'admin',
      displayName: 'Administrator',
      description: 'Organization admin with full access',
      isSystemRole: true,
      permissions: {
        create: allPermIds.map((id) => ({ permissionId: id })),
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
    'can_create_purchase_order',
    'accounts_view',
  ]

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
      email: 'admin@zaitoon.com',
      passwordHash,
      firstName: 'Ahmad',
      lastName: 'Al-Zaitoon',
      phone: '+966501234567',
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
      email: 'manager@zaitoon.com',
      passwordHash: managerHash,
      firstName: 'Mohammed',
      lastName: 'Al-Rashid',
      phone: '+966502222222',
      isActive: true,
    },
  })
  await prisma.userRole.create({ data: { userId: managerUser.id, roleId: branchManagerRole.id } })
  await prisma.userBranchAccess.create({
    data: {
      userId: managerUser.id,
      organizationId: org.id,
      branchId: branchMakkah.id,
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
      email: 'accountant@zaitoon.com',
      passwordHash: acctHash,
      firstName: 'Fatima',
      lastName: 'Al-Hassan',
      phone: '+966503333333',
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
      name: 'Al-Noor Trading Company',
      tradeName: 'Al-Noor',
      vatNumber: '300987654321003',
      email: 'orders@alnoor.com',
      phone: '+966555678901',
      address: 'Industrial Area, Jeddah',
      city: 'Jeddah',
      creditLimit: 100000,
      paymentTermsDays: 30,
      notes: 'Primary food supplier',
    },
  })

  await prisma.supplier.create({
    data: {
      organizationId: org.id,
      name: 'Arabian Spices Trading',
      tradeName: 'Arabian Spices',
      vatNumber: '300111222333003',
      email: 'info@arabianspices.com',
      phone: '+966556789012',
      address: 'Riyadh Old Town Market',
      city: 'Riyadh',
      creditLimit: 50000,
      paymentTermsDays: 15,
    },
  })
  console.log('Suppliers created')

  console.log('\n=== SEED COMPLETE (structural/reference data only — no fabricated transactions) ===')
  console.log(`Organization: ${org.name} (${org.id})`)
  console.log(`Branches: ${branches.map((b) => `${b.name} (${b.id})`).join(', ')}`)
  console.log('\nLogin credentials:')
  console.log('  Admin:      admin@zaitoon.com     / Admin@123')
  console.log('  Manager:    manager@zaitoon.com   / Manager@123')
  console.log('  Accountant: accountant@zaitoon.com / Accountant@123')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
