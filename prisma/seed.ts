import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

function daysAgo(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d
}

function rand(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100
}

async function main() {
  console.log('Seeding database...')

  // ─── Clean existing data ──────────────────────────────────────────────────────
  await prisma.auditLog.deleteMany()
  await prisma.notification.deleteMany()
  await prisma.wastageItem.deleteMany()
  await prisma.wastageReport.deleteMany()
  await prisma.stockMovement.deleteMany()
  await prisma.branchStock.deleteMany()
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

  const accounts: Record<string, string> = {}
  for (const acc of accountsData) {
    const created = await prisma.account.create({
      data: { ...acc, organizationId: org.id },
    })
    accounts[acc.code] = created.id
  }
  console.log(`Created ${accountsData.length} accounts`)

  // ─── Permissions ──────────────────────────────────────────────────────────────
  const permissionsData = [
    // Dashboard
    { key: 'dashboard.view', module: 'dashboard', description: 'View dashboard' },
    // Sales
    { key: 'sales.view', module: 'sales', description: 'View daily sales' },
    { key: 'sales.create', module: 'sales', description: 'Create daily sales' },
    { key: 'sales.edit', module: 'sales', description: 'Edit daily sales' },
    { key: 'sales.submit', module: 'sales', description: 'Submit sales for approval' },
    { key: 'sales.approve', module: 'sales', description: 'Approve sales' },
    { key: 'sales.void', module: 'sales', description: 'Void sales' },
    // Cash Closing
    { key: 'cash_closing.view', module: 'cash_closing', description: 'View cash closings' },
    { key: 'cash_closing.create', module: 'cash_closing', description: 'Create cash closings' },
    { key: 'cash_closing.approve', module: 'cash_closing', description: 'Approve cash closings' },
    // Expenses
    { key: 'expenses.view', module: 'expenses', description: 'View expenses' },
    { key: 'expenses.create', module: 'expenses', description: 'Create expenses' },
    { key: 'expenses.edit', module: 'expenses', description: 'Edit expenses' },
    { key: 'expenses.approve', module: 'expenses', description: 'Approve expenses' },
    { key: 'expenses.void', module: 'expenses', description: 'Void expenses' },
    // Suppliers
    { key: 'suppliers.view', module: 'suppliers', description: 'View suppliers' },
    { key: 'suppliers.create', module: 'suppliers', description: 'Create suppliers' },
    { key: 'suppliers.edit', module: 'suppliers', description: 'Edit suppliers' },
    // Bills
    { key: 'bills.view', module: 'bills', description: 'View bills' },
    { key: 'bills.create', module: 'bills', description: 'Create bills' },
    { key: 'bills.approve', module: 'bills', description: 'Approve bills' },
    { key: 'bills.pay', module: 'bills', description: 'Record bill payments' },
    // Inventory
    { key: 'inventory.view', module: 'inventory', description: 'View inventory' },
    { key: 'inventory.create', module: 'inventory', description: 'Add stock' },
    { key: 'inventory.wastage', module: 'inventory', description: 'Record wastage' },
    { key: 'inventory.approve_wastage', module: 'inventory', description: 'Approve wastage' },
    // Accounting
    { key: 'accounting.view', module: 'accounting', description: 'View accounts and journals' },
    { key: 'accounting.create', module: 'accounting', description: 'Create journal entries' },
    { key: 'accounting.post', module: 'accounting', description: 'Post journal entries' },
    { key: 'accounting.void', module: 'accounting', description: 'Void journal entries' },
    // Reports
    { key: 'reports.view', module: 'reports', description: 'View reports' },
    { key: 'reports.financial', module: 'reports', description: 'View financial reports' },
    // Users & ACL
    { key: 'users.view', module: 'users', description: 'View users' },
    { key: 'users.create', module: 'users', description: 'Create users' },
    { key: 'users.edit', module: 'users', description: 'Edit users' },
    { key: 'roles.manage', module: 'users', description: 'Manage roles and permissions' },
    // Branches
    { key: 'branches.view', module: 'branches', description: 'View branches' },
    { key: 'branches.manage', module: 'branches', description: 'Manage branches' },
  ]

  const permissions: Record<string, string> = {}
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
    'dashboard.view', 'sales.view', 'cash_closing.view', 'cash_closing.approve',
    'expenses.view', 'expenses.approve', 'suppliers.view', 'bills.view', 'bills.approve',
    'bills.pay', 'accounting.view', 'accounting.create', 'accounting.post',
    'reports.view', 'reports.financial', 'inventory.view',
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
    'dashboard.view', 'sales.view', 'sales.create', 'sales.edit', 'sales.submit',
    'sales.approve', 'cash_closing.view', 'cash_closing.create', 'cash_closing.approve',
    'expenses.view', 'expenses.create', 'expenses.edit', 'expenses.approve',
    'suppliers.view', 'bills.view', 'inventory.view', 'inventory.create',
    'inventory.wastage', 'inventory.approve_wastage', 'reports.view',
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
    'dashboard.view', 'sales.view', 'sales.create', 'sales.submit',
    'cash_closing.view', 'cash_closing.create', 'expenses.view', 'expenses.create',
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

  const categories: Record<string, string> = {}
  for (const cat of categoryNames) {
    const created = await prisma.expenseCategory.create({
      data: { ...cat, organizationId: org.id },
    })
    categories[cat.name] = created.id
  }
  console.log('Expense categories created')

  // ─── Inventory Items ──────────────────────────────────────────────────────────
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

  const items: Record<string, string> = {}
  for (const item of itemsData) {
    const created = await prisma.item.create({
      data: { ...item, organizationId: org.id },
    })
    items[item.code] = created.id
  }
  console.log('Inventory items created')

  // ─── Branch Stock ─────────────────────────────────────────────────────────────
  const stockQtyMap: Record<string, number[]> = {
    'OIL-001': [15, 25, 18],  // Makkah below reorder!
    'CHK-001': [80, 60, 45],
    'RIC-001': [150, 120, 95],
    'TOM-001': [40, 35, 22],
    'LAM-001': [25, 18, 12],  // Madina1 & 2 below reorder!
    'FLR-001': [120, 100, 90],
    'ONI-001': [60, 55, 40],
    'GAR-001': [25, 20, 15],
    'SPE-001': [8, 12, 7],    // Makkah & Madina2 below reorder!
    'BOT-001': [45, 30, 20],
  }

  for (const [code, qtys] of Object.entries(stockQtyMap)) {
    for (let i = 0; i < branches.length; i++) {
      const item = itemsData.find(it => it.code === code)!
      await prisma.branchStock.create({
        data: {
          organizationId: org.id,
          branchId: branches[i].id,
          itemId: items[code],
          quantityOnHand: qtys[i],
          averageCost: item.costPrice,
          totalValue: qtys[i] * item.costPrice,
          reorderPoint: item.reorderPoint,
        },
      })
    }
  }
  console.log('Branch stock created')

  // ─── Daily Sales (last 30 days) ───────────────────────────────────────────────
  // Target monthly amounts: Makkah ~125k, Madina1 ~102k, Madina2 ~85.5k
  const salesConfig = [
    { branch: branchMakkah, dailyBase: 4167, variance: 0.3 },     // ~125k/month
    { branch: branchMadina1, dailyBase: 3400, variance: 0.25 },   // ~102k/month
    { branch: branchMadina2, dailyBase: 2850, variance: 0.2 },    // ~85.5k/month
  ]

  let saleCounters: Record<string, number> = {
    [branchMakkah.id]: 0,
    [branchMadina1.id]: 0,
    [branchMadina2.id]: 0,
  }

  const saleStatuses = ['approved', 'approved', 'approved', 'approved', 'approved', 'submitted', 'draft', 'void']

  for (let day = 30; day >= 0; day--) {
    const saleDate = daysAgo(day)
    const isToday = day === 0

    for (const { branch, dailyBase, variance } of salesConfig) {
      const status = isToday ? 'draft' : day <= 2 ? 'submitted' : saleStatuses[Math.floor(Math.random() * saleStatuses.length)]

      saleCounters[branch.id]++
      const year = saleDate.getFullYear()
      const prefix = branch.salePrefix || 'SL'
      const saleNo = `${prefix}-${year}-${saleCounters[branch.id].toString().padStart(4, '0')}`

      const dailyTotal = rand(dailyBase * (1 - variance), dailyBase * (1 + variance))
      const cashPct = rand(0.4, 0.6)
      const cardPct = rand(0.15, 0.25)
      const deliveryPct = 1 - cashPct - cardPct
      const cashAmount = Math.round(dailyTotal * cashPct * 100) / 100
      const cardAmount = Math.round(dailyTotal * cardPct * 100) / 100
      const deliveryAmount = Math.round(dailyTotal * deliveryPct * 100) / 100

      const subtotal = Math.round(dailyTotal / 1.15 * 100) / 100
      const vatAmount = Math.round(subtotal * 0.15 * 100) / 100
      const totalAmount = subtotal + vatAmount
      const refundAmount = status !== 'void' ? rand(0, dailyTotal * 0.02) : 0
      const netAmount = totalAmount - refundAmount
      const discountAmount = rand(0, subtotal * 0.05)

      await prisma.dailySale.create({
        data: {
          organizationId: org.id,
          branchId: branch.id,
          saleNo,
          saleDate,
          cashAmount,
          cardAmount,
          deliveryAmount,
          bankTransferAmount: 0,
          otherAmount: 0,
          subtotal,
          discountAmount,
          vatAmount,
          totalAmount,
          refundAmount,
          netAmount,
          vatRate: 15,
          status,
          createdBy: adminUser.id,
          ...(status === 'void' && { voidReason: 'Data entry error' }),
          ...(status !== 'draft' && status !== 'void' && {
            submittedBy: adminUser.id,
            submittedAt: saleDate,
          }),
          ...(status === 'approved' && {
            approvedBy: adminUser.id,
            approvedAt: saleDate,
          }),
          deliveryBreakdown: deliveryAmount > 0 ? {
            create: [
              {
                platform: 'HungerStation',
                amount: Math.round(deliveryAmount * 0.5 * 100) / 100,
                commission: Math.round(deliveryAmount * 0.5 * 0.15 * 100) / 100,
                netAmount: Math.round(deliveryAmount * 0.5 * 0.85 * 100) / 100,
              },
              {
                platform: 'Jahez',
                amount: Math.round(deliveryAmount * 0.3 * 100) / 100,
                commission: Math.round(deliveryAmount * 0.3 * 0.12 * 100) / 100,
                netAmount: Math.round(deliveryAmount * 0.3 * 0.88 * 100) / 100,
              },
              {
                platform: 'Noon Food',
                amount: Math.round(deliveryAmount * 0.2 * 100) / 100,
                commission: Math.round(deliveryAmount * 0.2 * 0.18 * 100) / 100,
                netAmount: Math.round(deliveryAmount * 0.2 * 0.82 * 100) / 100,
              },
            ],
          } : undefined,
        },
      })
    }
  }
  console.log('Daily sales created (31 days x 3 branches)')

  // ─── Cash Closings ────────────────────────────────────────────────────────────
  let closingCounters: Record<string, number> = {
    [branchMakkah.id]: 0,
    [branchMadina1.id]: 0,
    [branchMadina2.id]: 0,
  }

  for (let day = 30; day >= 3; day--) {
    const closingDate = daysAgo(day)

    for (const branch of branches) {
      closingCounters[branch.id]++
      const year = closingDate.getFullYear()
      const closingNo = `CC-${branch.code}-${year}-${closingCounters[branch.id].toString().padStart(4, '0')}`
      const openingCash = rand(500, 2000)
      const cashSales = rand(1500, 4000)
      const cashExpensesPaid = rand(200, 800)
      const cashDeposited = rand(1000, 3000)
      const otherCashIn = rand(0, 200)
      const otherCashOut = rand(0, 100)
      const expectedCash = openingCash + cashSales + otherCashIn - cashExpensesPaid - cashDeposited - otherCashOut
      const deviation = rand(-50, 50)
      const actualCashCounted = Math.round((expectedCash + deviation) * 100) / 100
      const difference = actualCashCounted - expectedCash

      const status = day > 5 ? 'approved' : day > 2 ? 'submitted' : 'draft'

      await prisma.cashClosing.create({
        data: {
          organizationId: org.id,
          branchId: branch.id,
          closingNo,
          closingDate,
          openingCash,
          cashSales,
          cashExpensesPaid,
          cashDeposited,
          otherCashIn,
          otherCashOut,
          expectedCash,
          actualCashCounted,
          difference,
          differenceType: Math.abs(difference) < 0.01 ? 'balanced' : difference < 0 ? 'short' : 'excess',
          status,
          createdBy: adminUser.id,
          ...(status !== 'draft' && { approvedBy: adminUser.id, approvedAt: closingDate }),
        },
      })
    }
  }
  console.log('Cash closings created')

  // ─── Expenses ─────────────────────────────────────────────────────────────────
  const expenseTemplates = [
    { catName: 'Food Purchases', descr: 'Weekly food supply purchase', minAmt: 3000, maxAmt: 8000 },
    { catName: 'Salaries', descr: 'Monthly staff salaries', minAmt: 15000, maxAmt: 25000 },
    { catName: 'Rent', descr: 'Monthly rent payment', minAmt: 8000, maxAmt: 12000 },
    { catName: 'Utilities', descr: 'Electricity and water bill', minAmt: 1500, maxAmt: 3500 },
    { catName: 'Delivery Charges', descr: 'Delivery platform fees', minAmt: 500, maxAmt: 1500 },
    { catName: 'Maintenance', descr: 'Equipment maintenance', minAmt: 500, maxAmt: 3000 },
    { catName: 'Miscellaneous', descr: 'Miscellaneous operational expenses', minAmt: 200, maxAmt: 1000 },
  ]

  let expCounters: Record<string, number> = {
    [branchMakkah.id]: 0,
    [branchMadina1.id]: 0,
    [branchMadina2.id]: 0,
  }

  for (let day = 29; day >= 0; day--) {
    const expDate = daysAgo(day)
    // About 2 expenses per branch per day
    for (const branch of branches) {
      const numExpenses = Math.floor(Math.random() * 2) + 1
      for (let e = 0; e < numExpenses; e++) {
        const template = expenseTemplates[Math.floor(Math.random() * expenseTemplates.length)]
        expCounters[branch.id]++
        const year = expDate.getFullYear()
        const prefix = branch.expensePrefix || 'EXP'
        const expenseNo = `${prefix}-${year}-${expCounters[branch.id].toString().padStart(4, '0')}`
        const amount = rand(template.minAmt, template.maxAmt)
        const vatRate = Math.random() > 0.5 ? 15 : 0
        const vatAmount = Math.round(amount * vatRate / 100 * 100) / 100
        const totalAmount = amount + vatAmount
        const status = day > 5 ? 'approved' : day > 2 ? 'submitted' : 'draft'

        await prisma.expense.create({
          data: {
            organizationId: org.id,
            branchId: branch.id,
            expenseNo,
            expenseDate: expDate,
            categoryId: categories[template.catName],
            description: template.descr,
            amount,
            vatAmount,
            vatRate,
            totalAmount,
            paymentMethod: Math.random() > 0.5 ? 'cash' : 'bank_transfer',
            status,
            createdBy: adminUser.id,
            ...(status !== 'draft' && {
              submittedBy: adminUser.id,
              submittedAt: expDate,
            }),
            ...(status === 'approved' && {
              approvedBy: adminUser.id,
              approvedAt: expDate,
            }),
          },
        })
      }
    }
  }
  console.log('Expenses created')

  // ─── Supplier ─────────────────────────────────────────────────────────────────
  const supplier = await prisma.supplier.create({
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

  const supplier2 = await prisma.supplier.create({
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

  // ─── Bills ────────────────────────────────────────────────────────────────────
  // Recent paid bill
  const bill1 = await prisma.bill.create({
    data: {
      organizationId: org.id,
      branchId: branchMakkah.id,
      supplierId: supplier.id,
      billNo: `BILL-${new Date().getFullYear()}-0001`,
      supplierBillNo: 'SUP-2024-8821',
      billDate: daysAgo(20),
      dueDate: daysAgo(10), // Already past due
      subtotal: 15000,
      vatAmount: 2250,
      totalAmount: 17250,
      paidAmount: 17250,
      balanceDue: 0,
      status: 'paid',
      createdBy: adminUser.id,
      approvedBy: adminUser.id,
      approvedAt: daysAgo(19),
      items: {
        create: [
          { description: 'Olive Oil 100L', quantity: 100, unitPrice: 45, vatRate: 15, vatAmount: 675, totalAmount: 5175 },
          { description: 'Chicken Breast 200kg', quantity: 200, unitPrice: 28, vatRate: 15, vatAmount: 840, totalAmount: 6440 },
          { description: 'Basmati Rice 300kg', quantity: 300, unitPrice: 12, vatRate: 15, vatAmount: 540, totalAmount: 4140 },
        ],
      },
    },
  })

  // Record the payment for bill1
  await prisma.payment.create({
    data: {
      organizationId: org.id,
      branchId: branchMakkah.id,
      billId: bill1.id,
      paymentDate: daysAgo(15),
      amount: 17250,
      paymentMethod: 'bank_transfer',
      referenceNo: 'TXN-20240115-001',
      createdBy: adminUser.id,
    },
  })

  // Overdue bill (past due, unpaid)
  await prisma.bill.create({
    data: {
      organizationId: org.id,
      branchId: branchMadina1.id,
      supplierId: supplier2.id,
      billNo: `BILL-${new Date().getFullYear()}-0002`,
      supplierBillNo: 'ARS-2024-0099',
      billDate: daysAgo(45),
      dueDate: daysAgo(15), // OVERDUE
      subtotal: 8500,
      vatAmount: 1275,
      totalAmount: 9775,
      paidAmount: 0,
      balanceDue: 9775,
      status: 'approved',
      createdBy: adminUser.id,
      approvedBy: adminUser.id,
      approvedAt: daysAgo(44),
      items: {
        create: [
          { description: 'Mixed Spices 100kg', quantity: 100, unitPrice: 85, vatRate: 15, vatAmount: 1275, totalAmount: 9775 },
        ],
      },
    },
  })

  // Partially paid bill
  const bill3 = await prisma.bill.create({
    data: {
      organizationId: org.id,
      branchId: branchMakkah.id,
      supplierId: supplier.id,
      billNo: `BILL-${new Date().getFullYear()}-0003`,
      billDate: daysAgo(10),
      dueDate: daysAgo(-20), // Due in future
      subtotal: 22000,
      vatAmount: 3300,
      totalAmount: 25300,
      paidAmount: 10000,
      balanceDue: 15300,
      status: 'partial',
      createdBy: adminUser.id,
      approvedBy: adminUser.id,
      approvedAt: daysAgo(9),
      items: {
        create: [
          { description: 'Chicken Breast 500kg', quantity: 500, unitPrice: 28, vatRate: 15, vatAmount: 2100, totalAmount: 16100 },
          { description: 'Lamb Meat 100kg', quantity: 100, unitPrice: 65, vatRate: 15, vatAmount: 975, totalAmount: 7475 },
        ],
      },
    },
  })

  await prisma.payment.create({
    data: {
      organizationId: org.id,
      branchId: branchMakkah.id,
      billId: bill3.id,
      paymentDate: daysAgo(5),
      amount: 10000,
      paymentMethod: 'bank_transfer',
      referenceNo: 'TXN-PARTIAL-001',
      createdBy: adminUser.id,
    },
  })

  // Draft bill needing approval for Madina2
  await prisma.bill.create({
    data: {
      organizationId: org.id,
      branchId: branchMadina2.id,
      supplierId: supplier.id,
      billNo: `BILL-${new Date().getFullYear()}-0004`,
      billDate: daysAgo(2),
      dueDate: daysAgo(-28),
      subtotal: 12000,
      vatAmount: 1800,
      totalAmount: 13800,
      paidAmount: 0,
      balanceDue: 13800,
      status: 'draft',
      createdBy: adminUser.id,
    },
  })

  console.log('Bills created (1 paid, 1 overdue, 1 partial, 1 draft)')

  // ─── Journal Entries ──────────────────────────────────────────────────────────
  const year = new Date().getFullYear()

  // Opening balances entry
  await prisma.journalEntry.create({
    data: {
      organizationId: org.id,
      branchId: branchMakkah.id,
      entryNo: `JE-${year}-0001`,
      entryDate: daysAgo(30),
      description: 'Opening balances - Makkah Branch',
      status: 'posted',
      totalDebit: 500000,
      totalCredit: 500000,
      isBalanced: true,
      postedBy: adminUser.id,
      postedAt: daysAgo(30),
      createdBy: adminUser.id,
      lines: {
        create: [
          { accountId: accounts['1010'], description: 'Opening bank balance', debitAmount: 200000, creditAmount: 0, lineOrder: 1 },
          { accountId: accounts['1000'], description: 'Opening cash balance', debitAmount: 50000, creditAmount: 0, lineOrder: 2 },
          { accountId: accounts['1200'], description: 'Opening inventory value', debitAmount: 250000, creditAmount: 0, lineOrder: 3 },
          { accountId: accounts['3000'], description: "Owner's equity", debitAmount: 0, creditAmount: 500000, lineOrder: 4 },
        ],
      },
    },
  })

  // Revenue recognition entry
  await prisma.journalEntry.create({
    data: {
      organizationId: org.id,
      branchId: branchMakkah.id,
      entryNo: `JE-${year}-0002`,
      entryDate: daysAgo(7),
      description: 'Weekly sales revenue recognition',
      status: 'posted',
      totalDebit: 28750,
      totalCredit: 28750,
      isBalanced: true,
      postedBy: adminUser.id,
      postedAt: daysAgo(7),
      createdBy: adminUser.id,
      lines: {
        create: [
          { accountId: accounts['1000'], description: 'Cash from sales', debitAmount: 25000, creditAmount: 0, lineOrder: 1 },
          { accountId: accounts['2100'], description: 'VAT collected', debitAmount: 3750, creditAmount: 0, lineOrder: 2 },
          { accountId: accounts['4000'], description: 'Sales revenue', debitAmount: 0, creditAmount: 25000, lineOrder: 3 },
          { accountId: accounts['2100'], description: 'VAT payable', debitAmount: 0, creditAmount: 3750, lineOrder: 4 },
        ],
      },
    },
  })

  // Draft entry
  await prisma.journalEntry.create({
    data: {
      organizationId: org.id,
      branchId: branchMadina1.id,
      entryNo: `JE-${year}-0003`,
      entryDate: daysAgo(1),
      description: 'Supplier payment - Al-Noor Trading',
      status: 'draft',
      totalDebit: 17250,
      totalCredit: 17250,
      isBalanced: true,
      createdBy: adminUser.id,
      lines: {
        create: [
          { accountId: accounts['2000'], description: 'Accounts payable - Al-Noor', debitAmount: 17250, creditAmount: 0, lineOrder: 1 },
          { accountId: accounts['1010'], description: 'Bank payment', debitAmount: 0, creditAmount: 17250, lineOrder: 2 },
        ],
      },
    },
  })

  console.log('Journal entries created')

  // ─── Notifications ────────────────────────────────────────────────────────────
  const notifData = [
    {
      userId: adminUser.id,
      type: 'warning',
      title: 'Low Stock Alert',
      message: 'Olive Oil stock at Makkah Branch is below reorder point (15 litres < 20 litres)',
      link: '/inventory/stock',
    },
    {
      userId: adminUser.id,
      type: 'warning',
      title: 'Overdue Bill',
      message: 'Bill #BILL-2024-0002 from Arabian Spices Trading is overdue by 15 days. Amount: SAR 9,775',
      link: '/suppliers/bills',
    },
    {
      userId: adminUser.id,
      type: 'info',
      title: 'Sales Submitted',
      message: '3 daily sales records are pending your approval',
      link: '/sales?status=submitted',
    },
    {
      userId: adminUser.id,
      type: 'success',
      title: 'Cash Closing Approved',
      message: 'Cash closing CC-MKH-2024-0028 has been approved',
      link: '/cash-closing',
    },
  ]

  for (const notif of notifData) {
    await prisma.notification.create({
      data: { ...notif, organizationId: org.id },
    })
  }
  console.log('Notifications created')

  // ─── Audit Logs ───────────────────────────────────────────────────────────────
  const auditData = [
    { action: 'CREATE', module: 'sales', resourceType: 'DailySale', resourceRef: 'SL-MKH-2026-0031', branchId: branchMakkah.id },
    { action: 'APPROVE', module: 'sales', resourceType: 'DailySale', resourceRef: 'SL-MD1-2026-0030', branchId: branchMadina1.id },
    { action: 'CREATE', module: 'expenses', resourceType: 'Expense', resourceRef: 'EXP-MKH-2026-0060', branchId: branchMakkah.id },
    { action: 'APPROVE', module: 'cash_closing', resourceType: 'CashClosing', resourceRef: 'CC-MKH-2024-0028', branchId: branchMakkah.id },
    { action: 'CREATE', module: 'bills', resourceType: 'Bill', resourceRef: 'BILL-2026-0004', branchId: branchMadina2.id },
    { action: 'LOGIN', module: 'auth', resourceType: 'User', resourceRef: 'admin@zaitoon.com' },
  ]

  for (const log of auditData) {
    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        userId: adminUser.id,
        userEmail: adminUser.email,
        userName: `${adminUser.firstName} ${adminUser.lastName}`,
        ipAddress: '127.0.0.1',
        ...log,
      },
    })
  }
  console.log('Audit logs created')

  console.log('\n=== SEED COMPLETE ===')
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
