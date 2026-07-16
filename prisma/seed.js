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
  const accountsData = [
    // Assets
    { code: '1000', name: 'Cash', accountType: 'asset', normalBalance: 'debit', isHeader: false },
    { code: '1010', name: 'Bank Account', accountType: 'asset', normalBalance: 'debit', isHeader: false },
    { code: '1020', name: 'Petty Cash', accountType: 'asset', normalBalance: 'debit', isHeader: false },
    { code: '1100', name: 'Accounts Receivable', accountType: 'asset', normalBalance: 'debit', isHeader: false },
    { code: '1200', name: 'Inventory', accountType: 'asset', normalBalance: 'debit', isHeader: false },
    { code: '1300', name: 'Prepaid Expenses', accountType: 'asset', normalBalance: 'debit', isHeader: false },
    // Liabilities
    { code: '2000', name: 'Accounts Payable', accountType: 'liability', normalBalance: 'credit', isHeader: false },
    { code: '2100', name: 'VAT Payable', accountType: 'liability', normalBalance: 'credit', isHeader: false },
    { code: '2200', name: 'Salaries Payable', accountType: 'liability', normalBalance: 'credit', isHeader: false },
    { code: '2300', name: 'Other Payables', accountType: 'liability', normalBalance: 'credit', isHeader: false },
    // Equity
    { code: '3000', name: "Owner's Equity", accountType: 'equity', normalBalance: 'credit', isHeader: false },
    { code: '3100', name: 'Retained Earnings', accountType: 'equity', normalBalance: 'credit', isHeader: false },
    // Revenue
    { code: '4000', name: 'Sales Revenue', accountType: 'revenue', normalBalance: 'credit', isHeader: false },
    { code: '4010', name: 'Delivery Revenue', accountType: 'revenue', normalBalance: 'credit', isHeader: false },
    { code: '4020', name: 'Other Revenue', accountType: 'revenue', normalBalance: 'credit', isHeader: false },
    // COGS
    { code: '5000', name: 'Cost of Goods Sold', accountType: 'expense', normalBalance: 'debit', isHeader: true },
    { code: '5100', name: 'Food Cost', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '5200', name: 'Staff Meals', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '5300', name: 'Packaging Cost', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    // Operating Expenses
    { code: '6000', name: 'Operating Expenses', accountType: 'expense', normalBalance: 'debit', isHeader: true },
    { code: '6100', name: 'Salaries', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6200', name: 'Rent', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6300', name: 'Utilities', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6400', name: 'Delivery Charges', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6500', name: 'Maintenance', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6600', name: 'Marketing', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6700', name: 'Miscellaneous', accountType: 'expense', normalBalance: 'debit', isHeader: false },
    { code: '6800', name: 'Bank Charges', accountType: 'expense', normalBalance: 'debit', isHeader: false },
  ]

  const accounts = {}
  for (const acc of accountsData) {
    const created = await prisma.account.create({
      data: { ...acc, organizationId: org.id },
    })
    accounts[acc.code] = created.id
  }
  console.log(`Created ${accountsData.length} accounts`)

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
    { name: 'Delivery Charges', accountId: accounts['6400'] },
    { name: 'Maintenance', accountId: accounts['6500'] },
    { name: 'Marketing', accountId: accounts['6600'] },
    { name: 'Miscellaneous', accountId: accounts['6700'] },
    { name: 'Packaging', accountId: accounts['5300'] },
  ]

  for (const cat of categoryNames) {
    await prisma.expenseCategory.create({
      data: { ...cat, organizationId: org.id },
    })
  }
  console.log('Expense categories created')

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
      data: { ...item, organizationId: org.id },
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
