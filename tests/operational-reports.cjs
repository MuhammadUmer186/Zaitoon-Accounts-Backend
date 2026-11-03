// Real HTTP/database tests. The parent creates and drops only a named scratch DB.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const root = path.resolve(__dirname, '..')
async function child(file, args, env) {
  const result = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [file, ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    p.on('error', reject); p.on('exit', code => resolve(code))
  })
  if (result !== 0) throw new Error(`Test subprocess exited ${result}`)
}
async function parent() {
  const original = new URL(process.env.DATABASE_URL)
  const adminUrl = new URL(original); adminUrl.pathname = '/postgres'
  const name = `fs_reports_${process.pid}_${Date.now()}`
  const scratch = new URL(original); scratch.pathname = `/${name}`
  assert.match(name, /^fs_reports_\d+_\d+$/); assert.notEqual(scratch.pathname, original.pathname)
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } }); let created = false
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true
    const env = { ...process.env, DATABASE_URL: scratch.toString(), REPORT_TEST_CHILD: '1', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' }
    await child(path.join(root, 'node_modules/prisma/build/index.js'), ['db', 'push', '--skip-generate'], env)
    await child(__filename, [], env)
  } finally {
    if (created) { await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`); console.log('Scratch report database removed') }
    await admin.$disconnect()
  }
}
async function tests() {
  assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/fs_reports_\d+_\d+$/)
  const { prisma: db } = require('../dist/config')
  const app = require('../dist/app').default
  const { signAccessToken } = require('../dist/utils/jwt')
  const { operationalReportNames } = require('../dist/services/operationalReports')
  let server, passed = 0
  const check = (name, fn) => { fn(); passed++; console.log('PASS ' + name) }
  try {
    const org = await db.organization.create({ data: { name: 'Report fixture', timezone: 'Asia/Karachi', foodCostMethod: 'recipes' } })
    const other = await db.organization.create({ data: { name: 'Foreign organization' } })
    const branch = await db.branch.create({ data: { organizationId: org.id, name: 'Allowed branch', code: 'A' } })
    const hidden = await db.branch.create({ data: { organizationId: org.id, name: 'HIDDEN BRANCH', code: 'B' } })
    const foreign = await db.branch.create({ data: { organizationId: other.id, name: 'FOREIGN BRANCH', code: 'F' } })
    const user = await db.user.create({ data: { organizationId: org.id, email: 'reports@example.invalid', passwordHash: 'unused', firstName: 'Report', lastName: 'Tester' } })
    const role = await db.role.create({ data: { organizationId: org.id, name: 'store_keeper', displayName: 'Scoped reports' } })
    for (const [key, module] of [['can_view_reports', 'reports'], ['can_export_reports', 'reports'], ['can_manage_kitchen', 'kitchen'], ['can_manage_orders', 'orders']]) {
      const permission = await db.permission.create({ data: { key, module, description: key } })
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
    }
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
    await db.userBranchAccess.create({ data: { userId: user.id, organizationId: org.id, branchId: branch.id } })
    const category = await db.menuCategory.create({ data: { organizationId: org.id, name: 'Meals' } })
    const dish = await db.dish.create({ data: { organizationId: org.id, categoryId: category.id, name: 'Meal', price: 116, prepMinutes: 10 } })
    const ingredient = await db.item.create({ data: { organizationId: org.id, code: 'RICE', name: 'Rice', unit: 'kg', costPrice: 40, reorderPoint: 1 } })
    await db.dishIngredient.create({ data: { dishId: dish.id, itemId: ingredient.id, quantity: 1 } })
    const dining = await db.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'T1', orderToken: 'report-order-token', reviewToken: 'report-review-token' } })
    const customer = await db.customer.create({ data: { organizationId: org.id, name: 'Returning guest', phone: '+923001234567' } })
    let orderNo = 0
    const makeOrder = async (data = {}) => db.customerOrder.create({ data: {
      organizationId: org.id, branchId: branch.id, orderNo: ++orderNo, orderType: 'dine_in', source: 'pos', status: 'completed', itemsTotal: 116, totalAmount: 116, subtotal: 100, vatAmount: 16, vatRate: 16, foodCost: 40, createdAt: new Date('2026-11-02T18:50:00Z'), closedAt: new Date('2026-11-02T19:15:00Z'), closedBy: user.id, customerId: customer.id, customerName: 'Returning guest',
      items: { create: { dishId: dish.id, dishName: 'Meal', unitPrice: 116, lineTotal: 116, quantity: 1, unitCost: 40, status: 'served', createdAt: new Date('2026-11-02T18:50:00Z'), firedAt: new Date('2026-11-02T19:16:00Z'), readyAt: new Date('2026-11-02T19:28:00Z'), servedAt: new Date('2026-11-02T19:30:00Z'), recipeUsage: [{ itemId: ingredient.id, quantity: 1, unitCost: 40 }] } }, ...data,
    } })
    await makeOrder({ closedAt: new Date('2026-11-01T20:00:00Z') })
    const first = await makeOrder({ tableId: dining.id, guestCount: 2, discountAmount: 11.6, discountReason: 'Staff offer', totalAmount: 104.4, vatAmount: 14.4, subtotal: 90 })
    const delivery = await makeOrder({ orderType: 'delivery', source: 'online', closedAt: new Date('2026-11-03T12:00:00Z'), deliveryFee: 11.6, deliveryFeeVatAmount: 1.6, totalAmount: 127.6, vatAmount: 17.6 })
    const hiddenOrder = await makeOrder({ branchId: hidden.id, customerName: 'HIDDEN GUEST' })
    const foreignOrder = await makeOrder({ organizationId: other.id, branchId: foreign.id, customerId: null })
    await db.branchStock.create({ data: { organizationId: org.id, branchId: branch.id, itemId: ingredient.id, quantityOnHand: 2, averageCost: 40, totalValue: 80, reorderPoint: 1 } })
    for (const [type, quantity] of [['sale', -2], ['stock_out', -1], ['sale_return', 0.25], ['wastage', -0.5], ['transfer_out', -100]]) await db.stockMovement.create({ data: { organizationId: org.id, branchId: branch.id, itemId: ingredient.id, movementType: type, quantity, unitCost: 40, totalValue: Math.abs(quantity) * 40, createdBy: user.id, createdAt: new Date('2026-11-03T10:00:00Z') } })
    await db.auditLog.create({ data: { organizationId: org.id, branchId: branch.id, userId: user.id, userName: 'Report Tester', userEmail: user.email, module: 'orders', action: 'table_clear', resourceId: dining.id, createdAt: new Date('2026-11-03T10:00:00Z'), newData: { seatedAt: '2026-11-03T09:00:00Z', clearedAt: '2026-11-03T10:00:00Z', tableName: 'T1', guestCount: 2 } } })
    const supplier = await db.supplier.create({ data: { organizationId: org.id, name: 'Rice supplier' } })
    for (const [date, price] of [['2026-11-01', 40], ['2026-11-03', 50]]) await db.bill.create({ data: { organizationId: org.id, branchId: branch.id, supplierId: supplier.id, billNo: `B-${date}`, billDate: new Date(date), dueDate: new Date(date), subtotal: price * 2, totalAmount: price * 2, vatAmount: 0, balanceDue: price * 2, status: 'approved', createdBy: user.id, items: { create: { itemId: ingredient.id, description: 'Rice', quantity: 2, unitPrice: price, totalAmount: price * 2 } } } })
    await db.branchTarget.create({ data: { organizationId: org.id, branchId: branch.id, year: 2026, month: 11, salesTarget: 3000 } })
    await db.purchaseOrder.create({ data: { organizationId: org.id, branchId: branch.id, poNo: 'PO-1', orderDate: new Date('2026-11-03'), expectedDeliveryDate: new Date('2026-11-04'), createdBy: user.id, status: 'approved', items: { create: { itemId: ingredient.id, description: 'Rice', quantity: 4 } } } })
    await db.dailySale.create({ data: { organizationId: org.id, branchId: branch.id, saleNo: 'S-1', saleDate: new Date('2026-11-03'), subtotal: 200, totalAmount: 232, vatAmount: 32, netAmount: 232, createdBy: user.id, status: 'approved', deliveryBreakdown: { create: { platform: 'Example platform', amount: 100, commission: 10, netAmount: 90 } } } })
    for (const o of [first, delivery]) await db.tillPayment.create({ data: { organizationId: org.id, branchId: branch.id, userId: user.id, orderId: o.id, referenceKey: `sale:${o.id}:0`, method: 'card', amount: o.totalAmount, type: 'sale', createdAt: o.closedAt } })
    await db.paymentIntent.create({ data: { organizationId: org.id, branchId: branch.id, orderId: first.id, channel: 'qr', adapter: 'mock', environment: 'sandbox', amount: first.totalAmount, currency: 'PKR', status: 'succeeded', providerRef: 'TEST-PROVIDER', accessTokenHash: 'unused', idempotencyKey: 'fixture', expiresAt: new Date('2026-11-04'), settledAt: first.closedAt } })
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const token = signAccessToken(user.id, org.id, user.email); let ip = 1
    const base = `http://127.0.0.1:${server.address().port}/api/v1`
    const get = (url, auth = token) => fetch(base + url, { headers: { ...(auth && { Authorization: `Bearer ${auth}` }), 'X-Forwarded-For': `10.20.${Math.floor(ip / 255)}.${ip++ % 255}` } })
    const range = '?fromDate=2026-11-03&toDate=2026-11-03'
    const loaded = {}
    for (const key of Object.keys(operationalReportNames)) {
      const res = await get(`/reports/${key}${range}`); const data = await res.json()
      check(`${key}: valid JSON and comparison`, () => { assert.equal(res.status, 200, JSON.stringify(data)); assert.equal(data.report.key, key); assert.equal(data.report.sections[0].id, 'comparison'); assert.equal(data.report.sections[0].type, 'table') })
      check(`${key}: branch and organization isolation`, () => { assert.ok(!JSON.stringify(data).includes('HIDDEN')); assert.ok(!JSON.stringify(data).includes('FOREIGN')); assert.ok(!JSON.stringify(data).includes(hiddenOrder.id)); assert.ok(!JSON.stringify(data).includes(foreignOrder.id)) })
      loaded[key] = data.report
      for (const [format, mime, magic] of [['pdf', 'application/pdf', '%PDF'], ['excel', 'spreadsheetml', 'PK'], ['csv', 'text/csv', '\ufeffReport,']]) {
        const out = await get(`/reports/${key}${range}&format=${format}`); const buf = Buffer.from(await out.arrayBuffer())
        check(`${key}: ${format} export`, () => { assert.equal(out.status, 200, buf.toString().slice(0, 200)); assert.ok(out.headers.get('content-type').includes(mime)); assert.ok((format === 'csv' ? buf.toString('utf8') : buf.toString('latin1')).startsWith(magic)) })
      }
      const empty = await get(`/reports/${key}?fromDate=1900-01-01&toDate=1900-01-01`)
      check(`${key}: empty period`, () => assert.equal(empty.status, 200))
    }
    const section = (key, id = 'summary') => loaded[key].sections.find(s => s.id === id)
    const metric = (key, label) => loaded[key].kpis.find(k => k.label === label).value
    check('menu allocation reconciles discounted food revenue, excluding delivery fees', () => { assert.equal(section('menu-performance').rows[0].sales, 190); assert.equal(metric('menu-performance', 'Recorded food cost'), 80) })
    check('hourly buckets respect the local midnight boundary', () => assert.equal(section('hourly-sales').rows.find(r => r.weekday === 'Tue' && r.hour === '00:00').orders, 1))
    check('ingredient variance includes returns, separates waste and excludes transfers', () => { const r = section('ingredient-variance').rows[0]; assert.equal(r.expected, 2); assert.equal(r.actual, 2.75); assert.equal(r.variance, 0.75); assert.equal(r.waste, 0.5) })
    check('kitchen minutes start at course fire and detect lateness', () => { const r = section('kitchen-performance', 'lines').rows.find(r => r.order === `#${first.orderNo}`); assert.equal(r.minutes, 12); assert.equal(r.late, 'Yes') })
    check('supplier comparison finds prior price before the period', () => { const r = section('supplier-price-changes').rows[0]; assert.equal(r.previous, 40); assert.equal(r.price, 50); assert.equal(r.changePct, 25); assert.equal(r.impact, 20) })
    check('retention distinguishes returning guests and within-period repeats', () => { assert.equal(metric('customer-retention', 'Returning customers'), 1); assert.equal(metric('customer-retention', 'New customers'), 0); assert.equal(metric('customer-retention', 'Repeat purchase rate'), 100) })
    check('table occupancy uses explicit seat/clear timestamps', () => { assert.equal(metric('table-performance', 'Measured table turns'), 1); assert.equal(metric('table-performance', 'Average occupancy minutes'), 60) })
    check('targets prorate the monthly target for selected days', () => { const r = section('branch-targets').rows[0]; assert.equal(r.target, 100); assert.equal(r.sales, 232); assert.equal(r.achievement, 232) })
    check('replenishment includes waste, excludes transfers and deducts approved orders', () => { const r = section('stock-replenishment').rows[0]; assert.equal(r.used, 3.25); assert.equal(r.onOrder, 4); assert.equal(r.suggested, 39.5) })
    check('gateway reconciliation finds the actual order payment reference', () => assert.equal(metric('payment-reconciliation', 'Gateway booking difference'), 0))
    const detail = await get(`/reports/source-order/${first.id}`)
    check('source order drill-down returns line and payment evidence', () => assert.equal(detail.status, 200))
    const hiddenDetail = await get(`/reports/source-order/${hiddenOrder.id}`)
    check('source order drill-down refuses inaccessible branches', () => assert.equal(hiddenDetail.status, 404))
    const foreignDetail = await get(`/reports/source-order/${foreignOrder.id}`)
    check('source order drill-down refuses other organizations', () => assert.equal(foreignDetail.status, 404))
    for (const query of ['fromDate=2026-02-30', 'fromDate=2026-11-04&toDate=2026-11-03', 'format=exe', 'fromDate[]=2026-11-03']) {
      const bad = await get(`/reports/menu-performance?${query}`); check(`invalid filters rejected: ${query}`, () => assert.equal(bad.status, 400))
    }
    const forbidden = await get(`/reports/menu-performance?branchId=${hidden.id}`)
    check('explicit inaccessible branch refused', () => assert.equal(forbidden.status, 403))
    const unauth = await get('/reports/menu-performance', '')
    check('anonymous reports refused', () => assert.equal(unauth.status, 401))
    const exportPermission = await db.permission.findUnique({ where: { key: 'can_export_reports' } })
    await db.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: exportPermission.id } })
    const noExport = await get('/reports/menu-performance?format=csv')
    check('export permission enforced', () => assert.equal(noExport.status, 403))
    const { costAndConsumeOrder } = require('../dist/services/foodCost')
    const snapshotOrder = await makeOrder({ status: 'open', closedAt: null })
    await db.$transaction(tx => costAndConsumeOrder(tx, snapshotOrder.id, user.id))
    const snap = await db.customerOrderItem.findFirst({ where: { orderId: snapshotOrder.id } })
    check('payment costing captures immutable ingredient quantities and costs', () => { assert.equal(snap.recipeUsage[0].itemId, ingredient.id); assert.equal(snap.recipeUsage[0].quantity, 1); assert.equal(snap.recipeUsage[0].unitCost, 40) })
    // Later refunds must be reported on the refund day, not the original sale day.
    const refunded = await makeOrder({ status: 'refunded', closedAt: new Date('2026-10-01T12:00:00Z'), cancelReason: 'Quality issue' })
    for (const [index, amount] of [50, 66].entries()) await db.tillPayment.create({ data: { organizationId: org.id, branchId: branch.id, userId: user.id, orderId: refunded.id, referenceKey: `refund:${refunded.id}:${index}`, method: index ? 'card' : 'cash', amount, type: 'refund', createdAt: new Date('2026-11-03T10:00:00Z') } })
    const cancelled = await makeOrder({ status: 'cancelled', closedAt: null, cancelReason: 'Changed mind', updatedAt: new Date('2026-11-06') })
    await db.auditLog.create({ data: { organizationId: org.id, branchId: branch.id, userId: user.id, userName: 'Report Tester', userEmail: user.email, module: 'orders', action: 'cancel', resourceType: 'customer_order', resourceId: cancelled.id, createdAt: new Date('2026-11-03T10:00:00Z'), newData: { reason: 'Changed mind', approvedBy: user.id } } })
    let extra = await (await get(`/reports/discounts-voids-refunds${range}`)).json()
    check('refund report uses immutable events for later split-method refunds', () => assert.equal(extra.report.kpis.find(k => k.label === 'Refund payments').value, 116))
    check('void report preserves audit event dates and approvers after later updates', () => { const r = extra.report.sections.find(s => s.id === 'summary').rows.find(r => r.type === 'Void'); assert.equal(r.order, `#${cancelled.orderNo}`); assert.equal(r.approver, 'Report Tester'); assert.equal(r.date, '2026-11-03T10:00:00.000Z') })
    const unknown = await makeOrder()
    const unknownLine = await db.customerOrderItem.findFirst({ where: { orderId: unknown.id } })
    await db.customerOrderItem.update({ where: { id: unknownLine.id }, data: { recipeUsage: require('@prisma/client').Prisma.DbNull, readyAt: null, servedAt: null } })
    extra = await (await get(`/reports/ingredient-variance${range}`)).json()
    check('legacy ingredient quantities remain explicitly unavailable', () => assert.equal(extra.report.kpis.find(k => k.label === 'Lines without snapshots').value, 1))
    extra = await (await get(`/reports/kitchen-performance${range}`)).json()
    check('legacy served lines do not acquire invented ready times', () => assert.equal(extra.report.sections.find(s => s.id === 'lines').rows.find(r => r.order === `#${unknown.orderNo}`).minutes, null))
    // Both single-line and bulk kitchen flows must persist first-ready timestamps.
    const send = (url, body, method = 'POST') => fetch(base + url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const live = await makeOrder({ closedAt: new Date() })
    const line = await db.customerOrderItem.findFirst({ where: { orderId: live.id } })
    await db.customerOrderItem.update({ where: { id: line.id }, data: { status: 'pending', preparingAt: null, readyAt: null, servedAt: null } })
    for (const from of ['pending', 'preparing', 'ready']) { const r = await send(`/kitchen/orders/${live.id}/advance`, { from }); assert.equal(r.status, 200, await r.text()) }
    const served = await db.customerOrderItem.findUnique({ where: { id: line.id } })
    check('bulk kitchen flow captures preparation, ready and served times', () => { assert.ok(served.preparingAt); assert.ok(served.readyAt); assert.ok(served.servedAt) })
    const recalled = await send(`/kitchen/orders/${live.id}/recall`, {})
    check('recall succeeds for a just-served ticket', () => assert.equal(recalled.status, 200))
    const afterRecall = await db.customerOrderItem.findUnique({ where: { id: line.id } })
    check('recall clears served time and preserves first-ready measurement', () => { assert.equal(afterRecall.servedAt, null); assert.equal(afterRecall.readyAt.getTime(), served.readyAt.getTime()) })
    const single = await send(`/orders/${live.id}/items/${line.id}`, { status: 'served' }, 'PATCH')
    check('single-line service transition captures timing', () => assert.equal(single.status, 200))
    const afterSingle = await db.customerOrderItem.findUnique({ where: { id: line.id } })
    check('single-line transition preserves ready history', () => { assert.ok(afterSingle.servedAt); assert.equal(afterSingle.readyAt.getTime(), served.readyAt.getTime()) })
    await db.diningTable.update({ where: { id: dining.id }, data: { seatedAt: new Date(Date.now() - 1800000), guestCount: 2, needsClearing: true } })
    const cleared = await send(`/floor/tables/${dining.id}/clear`, {})
    check('table clear records a measured occupancy event', () => assert.equal(cleared.status, 200))
    const clearEvent = await db.auditLog.findFirst({ where: { resourceId: dining.id, action: 'table_clear', createdAt: { gt: new Date(Date.now() - 60000) } }, orderBy: { createdAt: 'desc' } })
    check('table occupancy audit retains seated/cleared timestamps', () => { assert.ok(clearEvent.newData.seatedAt); assert.ok(clearEvent.newData.clearedAt); assert.equal(clearEvent.newData.guestCount, 2) })
    const split = await makeOrder()
    for (const number of [1, 2]) {
      const bill = await db.orderCheck.create({ data: { organizationId: org.id, branchId: branch.id, orderId: split.id, number, label: `Guest ${number}`, mode: 'equal', lines: [], itemsTotal: 58, totalAmount: 58, vatRate: 16, vatAmount: 8, status: 'paid', paidAt: split.closedAt } })
      await db.tillPayment.create({ data: { organizationId: org.id, branchId: branch.id, userId: user.id, orderId: split.id, checkId: bill.id, referenceKey: `sale:check:${bill.id}:0`, method: 'card', amount: 58, type: 'sale', createdAt: split.closedAt } })
      await db.paymentIntent.create({ data: { organizationId: org.id, branchId: branch.id, orderId: split.id, checkId: bill.id, channel: 'qr', adapter: 'mock', environment: 'sandbox', amount: 58, currency: 'PKR', status: 'succeeded', providerRef: `SPLIT-${number}`, accessTokenHash: 'unused', idempotencyKey: `split-${number}`, expiresAt: new Date('2026-11-04'), settledAt: split.closedAt } })
    }
    extra = await (await get(`/reports/payment-reconciliation${range}`)).json()
    check('split-check gateway reconciliation matches each check exactly once', () => { const rows = extra.report.sections.find(s => s.id === 'gateway').rows.filter(r => r.order === split.id); assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.recorded), [58, 58]); assert.ok(rows.every(r => r.difference === 0)) })
    await db.organization.update({ where: { id: org.id }, data: { currency: 'KWD', locale: 'en-KW' } })
    extra = await (await get(`/reports/menu-performance${range}`)).json()
    check('new reports follow organization currency precision', () => { assert.equal(extra.report.format.currency, 'KWD'); assert.equal(extra.report.format.decimals, 3) })
    await db.userBranchAccess.deleteMany({ where: { userId: user.id } })
    for (const key of Object.keys(operationalReportNames)) {
      const none = await get(`/reports/${key}${range}`); const data = await none.json()
      check(`${key}: no branch grants means no branch data`, () => { assert.equal(none.status, 200); assert.equal(data.report.scopeLabel, 'No authorized branches'); assert.ok(data.report.sections.filter(s => s.type === 'table' && !['comparison', 'summary'].includes(s.id)).every(s => s.rows.length === 0)); if (key !== 'hourly-sales') assert.equal(data.report.sections.find(s => s.id === 'summary').rows.length, 0) })
    }
    console.log(`PASS ${passed} operational report checks`)
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await db.$disconnect() }
}
(process.env.REPORT_TEST_CHILD === '1' ? tests() : parent()).catch(e => { console.error(e); process.exitCode = 1 })
