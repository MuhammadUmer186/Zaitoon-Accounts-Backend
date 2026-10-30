// Real PostgreSQL + HTTP regression test. Every fixture and request runs
// inside one transaction which is deliberately rolled back at the end.
// Savepoints preserve the application's nested transaction rollback behavior.
require('dotenv').config()
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { PrismaClient } = require('@prisma/client')
const configModule = require('../dist/config')
const originalDb = configModule.prisma
const rootDb = new PrismaClient()
const rollback = new Error('EXPECTED_TEST_ROLLBACK')
let server, passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }

async function run(tx) {
  let savepoint = 0
  const db = new Proxy(tx, { get(target, property) {
    if (property !== '$transaction') return target[property]
    return async (callback) => {
      const point = `test_request_${++savepoint}`
      await tx.$executeRawUnsafe(`SAVEPOINT ${point}`)
      try {
        const result = await callback(db)
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${point}`)
        return result
      } catch (error) {
        await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${point}`)
        await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${point}`)
        throw error
      }
    }
  } })
  configModule.prisma = db
  const app = require('../dist/app').default
  const { signAccessToken } = require('../dist/utils/jwt')
  const { businessDate } = require('../dist/services/orderSales')
  const { postJournalEntry } = require('../dist/utils/ledger')
  const { nextNumber } = require('../dist/utils/numbering')
  await tx.permission.upsert({ where: { key: 'can_manage_tills' }, update: {}, create: { key: 'can_manage_tills', module: 'pos', description: 'Manage till sessions and view X/Z reports' } })
  await tx.permission.upsert({ where: { key: 'can_void_items' }, update: {}, create: { key: 'can_void_items', module: 'orders', description: 'Void order items and unpaid orders' } })
  await tx.permission.upsert({ where: { key: 'can_refund' }, update: {}, create: { key: 'can_refund', module: 'orders', description: 'Refund paid orders' } })
  await tx.permission.upsert({ where: { key: 'can_open_drawer' }, update: {}, create: { key: 'can_open_drawer', module: 'pos', description: 'Authorize drawer openings and cash movements' } })
  const org = await tx.organization.create({ data: { requireTillForCash: false, name: 'Rollback test restaurant', createdAt: new Date('1900-01-01'), foodCostMethod: 'recipes' } })
  const org2 = await tx.organization.create({ data: { requireTillForCash: false, name: 'Other test organization' } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Test pickup', code: 'TEST', vatRate: 16 } })
  const foreign = await tx.branch.create({ data: { organizationId: org2.id, name: 'Foreign branch', code: 'FOREIGN' } })
  const user = await tx.user.create({ data: { organizationId: org.id, email: 'test@example.invalid', passwordHash: 'unused', firstName: 'Test', lastName: 'Cashier' } })
  const role = await tx.role.create({ data: { organizationId: org.id, name: 'super_admin', displayName: 'Test Super Admin' } })
  await tx.userRole.create({ data: { roleId: role.id, userId: user.id } })
  const deniedUser = await tx.user.create({ data: { organizationId: org.id, email: 'denied@example.invalid', passwordHash: 'unused', firstName: 'No', lastName: 'Access' } })
  const shift = await tx.menuShift.create({ data: { organizationId: org.id, name: 'All day', startTime: '00:00', endTime: '00:00' } })
  const category = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Test menu' } })
  const dish = await tx.dish.create({ data: { organizationId: org.id, categoryId: category.id, name: 'Meal', price: 116, shifts: { create: { shiftId: shift.id } } } })
  const item = await tx.item.create({ data: { organizationId: org.id, code: 'TEST', name: 'Ingredient', costPrice: 40 } })
  await tx.dishIngredient.create({ data: { dishId: dish.id, itemId: item.id, quantity: 0.25, wastePct: 10 } })
  await tx.branchStock.create({ data: { organizationId: org.id, branchId: branch.id, itemId: item.id, quantityOnHand: 10, averageCost: 40, totalValue: 400 } })
  const table = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'T1', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  const accountMap = {}
  for (const [key, accountClass, normalBalance] of [
    ['CASH_ON_HAND', 'ASSET', 'DEBIT'], ['CARD_CLEARING', 'ASSET', 'DEBIT'], ['DEFAULT_BANK', 'ASSET', 'DEBIT'],
    ['SALES_REVENUE', 'REVENUE', 'CREDIT'], ['OUTPUT_VAT', 'LIABILITY', 'CREDIT'], ['INVENTORY', 'ASSET', 'DEBIT'],
    ['INPUT_VAT', 'ASSET', 'DEBIT'], ['ACCOUNTS_PAYABLE', 'LIABILITY', 'CREDIT'],
    ['DEFAULT_EXPENSE', 'EXPENSE', 'DEBIT'], ['CASH_OVER_SHORT', 'EXPENSE', 'DEBIT'],
  ]) {
    const account = await tx.account.create({ data: { organizationId: org.id, code: key, name: key, accountClass, normalBalance } })
    accountMap[key] = account.id
    await tx.accountingMapping.create({ data: { organizationId: org.id, key, accountId: account.id } })
  }
  server = await new Promise(resolve => { const s = app.listen(Number(process.env.UI_TEST_PORT || 0), '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}/api/v1`
  const token = signAccessToken(user.id, org.id, user.email)
  let ip = 1
  const api = async (method, path, body, staff = false, fixedIp) => {
    const res = await fetch(base + path, { method, headers: {
      'Content-Type': 'application/json', 'X-Forwarded-For': fixedIp || `10.10.0.${ip++}`,
      ...(staff ? { Authorization: `Bearer ${typeof staff === 'string' ? staff : token}` } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, data: await res.json() }
  }
  if (process.env.TEST_HR_ONLY === '1') {
    await require('./hr.cjs')({ tx, api, org, branch, signAccessToken, check, base })
    return
  }
  await require('./module-visibility.cjs')({ tx, api, org, branch, signAccessToken, check })
  await require('./acceptance-payment.cjs')({ tx, api, org, branch, dish, check })
  if (process.env.TEST_PAYMENT_FIRST === '1') {
    await require('./kitchen.cjs')({ tx, api, signAccessToken, check })
    await require('./payment-first.cjs')({ tx, api, signAccessToken, check })
    await require('./zatca.cjs')({ tx, api, signAccessToken, check })
    return
  }
  const onlinePath = `/public/online/branches/${branch.id}`
  await require('./menu-import.cjs')({ tx, db, base, token, deniedToken: signAccessToken(deniedUser.id, org.id, deniedUser.email), org, org2, item, check })
  const payload = (quantity = 1) => ({ requestId: crypto.randomUUID(), customerName: 'Test customer', customerPhone: '+923001234567', items: [{ dishId: dish.id, quantity }] })
  const place = async (quantity = 1) => {
    const result = await api('POST', onlinePath + '/orders', payload(quantity))
    assert.equal(result.status, 201, JSON.stringify(result.data))
    const accepted = await api('POST', `/orders/${result.data.order.id}/accept`, {}, true)
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data))
    return result.data
  }
  let response = await api('GET', '/public/online/branches')
  check('public branch list isolates restaurant', () => assert.deepEqual(response.data.branches.map(b => b.id), [branch.id]))
  response = await api('GET', `/public/online/branches/${foreign.id}/menu`)
  check('cross-organization public branch blocked', () => assert.equal(response.status, 404))
  response = await api('GET', onlinePath + '/menu')
  check('public menu needs no QR or login', () => assert.equal(response.data.categories[0].dishes[0].price, 116))
  const originalBody = payload(2)
  response = await api('POST', onlinePath + '/orders', { ...originalBody, totalAmount: 1, paymentMethod: 'card', source: 'pos' })
  const first = response.data
  check('server prices order and extracts inclusive tax', () => { assert.equal(response.status, 201); assert.equal(first.order.totalAmount, 232); assert.equal(first.order.vatAmount, 32); assert.equal(first.order.subtotal, 200); assert.equal(first.order.paid, false) })
  response = await api('POST', onlinePath + '/orders', originalBody)
  check('network retry creates no duplicate order', () => { assert.equal(response.status, 200); assert.equal(response.data.order.id, first.order.id) })
  const stored = await tx.customerOrder.findUnique({ where: { id: first.order.id } })
  check('online pickup retains customer and stays unpaid', () => { assert.equal(stored.source, 'online'); assert.equal(stored.orderType, 'takeaway'); assert.equal(stored.tableId, null); assert.equal(stored.customerPhone, originalBody.customerPhone); assert.equal(stored.paymentMethod, null) })
  check('online order waits for acceptance', () => { assert.equal(stored.status, 'pending'); assert.equal(stored.acceptedAt, null); assert.equal(first.order.status, 'pending') })
  check('unpaid order creates no daily revenue', () => assert.equal(stored.dailySaleId, null))
  response = await api('GET', `/public/online/orders/${first.trackingCode}`)
  check('private tracking works without exposing phone', () => { assert.equal(response.status, 200); assert.equal(response.data.order.customerPhone, undefined) })
  response = await api('GET', `/public/online/orders/${first.trackingCode}.extra`)
  check('tampered tracking blocked', () => assert.equal(response.status, 404))
  response = await api('GET', `/public/online/orders/${first.order.orderNo}`)
  check('order number grants no tracking access', () => assert.equal(response.status, 404))
  response = await api('POST', onlinePath + '/orders', { ...payload(), items: [{ dishId: dish.id, quantity: -1 }] })
  check('invalid quantity rejected', () => assert.equal(response.status, 400))
  response = await api('POST', onlinePath + '/orders', { ...payload(), customerPhone: '-------' })
  check('phone number must contain actual digits', () => assert.equal(response.status, 400))
  await tx.dishOutOfStock.create({ data: { organizationId: org.id, branchId: branch.id, dishId: dish.id, markedBy: user.id } })
  response = await api('GET', onlinePath + '/menu')
  check('branch unavailable dish hidden', () => assert.equal(response.data.categories.length, 0))
  response = await api('POST', onlinePath + '/orders', payload())
  check('stale unavailable cart rejected', () => assert.equal(response.status, 409))
  await tx.dishOutOfStock.deleteMany({ where: { branchId: branch.id } })
  // Close every shift: earlier fixtures (menu import) add a 22:00-03:00 shift,
  // which made this check fail whenever the suite ran late in the evening.
  const openShifts = (await tx.menuShift.findMany({ where: { organizationId: org.id, isActive: true }, select: { id: true } })).map(s => s.id)
  await tx.menuShift.updateMany({ where: { id: { in: openShifts } }, data: { isActive: false } })
  response = await api('POST', onlinePath + '/orders', payload())
  check('closed shift refuses new orders', () => assert.equal(response.data.code, 'NO_ACTIVE_SHIFT'))
  await tx.menuShift.updateMany({ where: { id: { in: openShifts } }, data: { isActive: true } })
  response = await api('GET', '/orders?source=online', undefined, true)
  check('portal Online filter finds public order', () => assert.equal(response.data.data[0].id, first.order.id))

  // ── Online order types, acceptance queue, accept / reject ──
  response = await api('GET', onlinePath + '/menu')
  check('menu offers dine-in, takeaway and delivery by default', () => assert.deepEqual(response.data.orderTypes, ['dine_in', 'takeaway', 'delivery']))
  response = await api('GET', `/kitchen/orders?branchId=${branch.id}`, undefined, true)
  check('kitchen never sees an order before it is accepted', () => assert.equal(response.data.data.some(o => o.id === first.order.id), false))
  response = await api('GET', `/orders/online/pending?branchId=${branch.id}`, undefined, true)
  check('online queue lists the pending order with its items', () => { assert.equal(response.status, 200); assert.deepEqual(response.data.data.map(o => o.id), [first.order.id]); assert.equal(response.data.data[0].items.length, 1) })
  response = await api('GET', `/orders/stats?branchId=${branch.id}`, undefined, true)
  check('stats count orders awaiting acceptance apart from open ones', () => { assert.equal(response.data.awaitingAcceptanceCount, 1); assert.equal(response.data.openCount, 0) })
  response = await api('POST', `/orders/${first.order.id}/complete`, { paymentMethod: 'cash' }, true)
  check('pending online order cannot be charged', () => assert.equal(response.data.code, 'NOT_ACCEPTED'))
  response = await api('POST', `/kitchen/orders/${first.order.id}/advance`, { from: 'pending' }, true)
  check('kitchen cannot start a pending online order', () => assert.equal(response.data.code, 'NOT_ACCEPTED'))
  response = await api('POST', `/orders/${first.order.id}/cancel`, { reason: 'x' }, true)
  check('pending online order is rejected, not cancelled', () => assert.equal(response.data.code, 'NOT_ACCEPTED'))
  response = await api('POST', `/orders/${first.order.id}/accept`, { estimatedMinutes: 2 }, true)
  check('accept validates the ready-time estimate', () => assert.equal(response.status, 400))
  response = await api('POST', `/orders/${first.order.id}/accept`, {}, signAccessToken(deniedUser.id, org.id, deniedUser.email))
  check('accepting needs order permission', () => assert.equal(response.status, 403))
  response = await api('POST', `/orders/${first.order.id}/accept`, { estimatedMinutes: 20 }, true)
  const acceptedFirst = response.data
  check('accept records the order and estimate pending full payment', () => {
    assert.equal(response.status, 200); assert.equal(acceptedFirst.status, 'open'); assert.equal(acceptedFirst.acceptedBy, user.id)
    const minutes = (new Date(acceptedFirst.estimatedReadyAt) - new Date(acceptedFirst.acceptedAt)) / 60000
    assert.equal(minutes, 20); assert.equal(acceptedFirst.items.length, 1); assert.equal(acceptedFirst.branch.id, branch.id)
  })
  response = await api('POST', `/orders/${first.order.id}/accept`, {}, true)
  check('an order cannot be accepted twice', () => assert.equal(response.status, 409))
  response = await api('POST', `/orders/${first.order.id}/reject`, { reason: 'Too busy' }, true)
  check('an accepted order cannot be rejected', () => assert.equal(response.status, 409))
  response = await api('GET', `/kitchen/orders?branchId=${branch.id}`, undefined, true)
  check('accepted unpaid order stays off the kitchen board', () => assert.equal(response.data.data.some(o => o.id === first.order.id), false))
  response = await api('GET', `/public/online/orders/${first.trackingCode}`)
  check('customer sees acceptance and ready estimate', () => { assert.equal(response.data.order.status, 'open'); assert.ok(response.data.order.acceptedAt); assert.ok(response.data.order.estimatedReadyAt); assert.equal(response.data.order.rejectReason, null) })

  response = await api('POST', onlinePath + '/orders', { ...payload(), orderType: 'delivery' })
  check('delivery needs an address', () => { assert.equal(response.status, 400); assert.match(JSON.stringify(response.data), /delivery address/) })
  response = await api('POST', onlinePath + '/orders', { ...payload(), orderType: 'drive_thru' })
  check('unknown order type rejected', () => assert.equal(response.status, 400))
  const deliveryBody = { ...payload(), orderType: 'delivery', deliveryAddress: '  House 12, Street 4, F-7/2, Islamabad  ', notes: 'Ring the bell' }
  response = await api('POST', onlinePath + '/orders', deliveryBody)
  const delivery = response.data
  const storedDelivery = await tx.customerOrder.findUnique({ where: { id: delivery.order.id } })
  check('delivery order keeps type, trimmed address and note', () => {
    assert.equal(response.status, 201); assert.equal(delivery.order.orderType, 'delivery'); assert.equal(storedDelivery.orderType, 'delivery')
    assert.equal(storedDelivery.deliveryAddress, 'House 12, Street 4, F-7/2, Islamabad'); assert.equal(storedDelivery.notes, 'Ring the bell'); assert.equal(storedDelivery.status, 'pending')
  })
  response = await api('POST', onlinePath + '/orders', { ...payload(), orderType: 'dine_in', deliveryAddress: 'should be dropped' })
  const dineIn = response.data
  const storedDineIn = await tx.customerOrder.findUnique({ where: { id: dineIn.order.id } })
  check('online dine-in has no table and drops a stray address', () => { assert.equal(response.status, 201); assert.equal(storedDineIn.orderType, 'dine_in'); assert.equal(storedDineIn.tableId, null); assert.equal(storedDineIn.deliveryAddress, null) })
  response = await api('GET', '/orders?source=online&orderType=delivery', undefined, true)
  check('portal filters online orders by delivery type', () => assert.deepEqual(response.data.data.map(o => o.id), [delivery.order.id]))

  response = await api('POST', `/orders/${delivery.order.id}/reject`, { reason: '  ' }, true)
  check('reject needs a reason', () => assert.equal(response.status, 400))
  response = await api('POST', `/orders/${delivery.order.id}/reject`, { reason: 'Outside our delivery area' }, true)
  check('rejected order is closed with nothing to charge', () => { assert.equal(response.status, 200); assert.equal(response.data.status, 'cancelled'); assert.equal(response.data.totalAmount, 0); assert.ok(response.data.items.every(i => i.status === 'cancelled')) })
  response = await api('POST', `/orders/${delivery.order.id}/accept`, {}, true)
  check('a rejected order cannot be accepted', () => assert.equal(response.status, 409))
  response = await api('GET', `/public/online/orders/${delivery.trackingCode}`)
  check('customer sees why the order was turned down', () => { assert.equal(response.data.order.status, 'cancelled'); assert.equal(response.data.order.rejectReason, 'Outside our delivery area') })
  const storedRejected = await tx.customerOrder.findUnique({ where: { id: delivery.order.id } })
  check('rejection is recorded explicitly', () => { assert.ok(storedRejected.rejectedAt); assert.equal(storedRejected.acceptedAt, null) })
  response = await api('POST', `/orders/${dineIn.order.id}/accept`, {}, true)
  response = await api('POST', `/orders/${dineIn.order.id}/cancel`, { reason: 'Internal note' }, true)
  response = await api('GET', `/public/online/orders/${dineIn.trackingCode}`)
  check('a cancellation after acceptance keeps its reason internal', () => { assert.equal(response.data.order.status, 'cancelled'); assert.equal(response.data.order.rejectReason, null) })

  response = await api('PUT', `/orgs/${org.id}`, { onlineOrderTypes: ['delivery', 'takeaway', 'takeaway'] }, true)
  check('settings store order types once each, in menu order', () => { assert.equal(response.status, 200); assert.deepEqual(response.data.onlineOrderTypes, ['takeaway', 'delivery']) })
  response = await api('PUT', `/orgs/${org.id}`, { onlineOrderTypes: ['curbside'] }, true)
  check('settings refuse unknown order types', () => assert.equal(response.status, 400))
  response = await api('GET', onlinePath + '/menu')
  check('menu only offers the types switched on', () => assert.deepEqual(response.data.orderTypes, ['takeaway', 'delivery']))
  response = await api('POST', onlinePath + '/orders', { ...payload(), orderType: 'dine_in' })
  check('switched-off order type refused', () => assert.equal(response.data.code, 'ORDER_TYPE_UNAVAILABLE'))
  response = await api('POST', onlinePath + '/orders', deliveryBody)
  check('retry of an order placed earlier still returns it', () => { assert.equal(response.status, 200); assert.equal(response.data.order.id, delivery.order.id) })
  response = await api('PUT', `/orgs/${org.id}`, { onlineOrderTypes: [] }, true)
  check('online ordering can be switched off entirely', () => assert.deepEqual(response.data.onlineOrderTypes, []))
  response = await api('GET', '/public/online/branches')
  check('branch list tells the menu ordering is off', () => assert.deepEqual(response.data.orderTypes, []))
  response = await api('POST', onlinePath + '/orders', payload())
  check('no online orders while switched off', () => assert.equal(response.data.code, 'ORDER_TYPE_UNAVAILABLE'))
  response = await api('PUT', `/orgs/${org.id}`, { onlineOrderTypes: ['dine_in', 'takeaway', 'delivery'] }, true)
  assert.equal(response.status, 200)
  response = await api('GET', '/orders', undefined, signAccessToken(deniedUser.id, org.id, deniedUser.email))
  check('order portal requires staff permission', () => assert.equal(response.status, 403))
  response = await api('POST', `/orders/${first.order.id}/complete`, { paymentMethod: 'cash', amountTendered: 200 }, true)
  check('insufficient payment rejected and rolled back', () => assert.equal(response.status, 400))
  const afterFailed = await tx.customerOrder.findUnique({ where: { id: stored.id } })
  check('failed payment leaves no discount or daily sale', () => { assert.equal(afterFailed.dailySaleId, null); assert.equal(afterFailed.discountAmount, 0); assert.equal(afterFailed.status, 'open') })
  response = await api('POST', `/orders/${first.order.id}/complete`, { paymentMethod: 'cash', discountAmount: 11.6, discountReason: 'Regular guest', amountTendered: 250 }, true)
  const paid = response.data
  check('cash payment discount VAT and change reconcile', () => { assert.equal(response.status, 200); assert.equal(paid.totalAmount, 220.4); assert.equal(paid.vatAmount, 30.4); assert.equal(paid.changeAmount, 29.6); assert.equal(paid.foodCost, 22) })
  let stock = await tx.branchStock.findUnique({ where: { branchId_itemId: { branchId: branch.id, itemId: item.id } } })
  check('recipe ingredients consumed at weighted cost', () => { assert.equal(stock.quantityOnHand, 9.45); assert.equal(stock.totalValue, 378) })
  response = await api('POST', `/orders/${first.order.id}/complete`, { paymentMethod: 'cash' }, true)
  check('duplicate completion cannot charge twice', () => assert.equal(response.status, 400))
  response = await api('PATCH', `/orders/${first.order.id}/items/${paid.items[0].id}`, { status: 'cancelled', reason: 'Guest changed mind' }, true)
  check('paid dishes cannot be cancelled or alter sales', () => assert.equal(response.status, 400))
  const sale = await tx.dailySale.findUnique({ where: { id: paid.dailySaleId } })
  check('daily sale matches payment tax and cost', () => { assert.equal(sale.cashAmount, 220.4); assert.equal(sale.vatAmount, 30.4); assert.equal(sale.costOfSales, 22); assert.equal(sale.status, 'draft') })
  response = await api('POST', `/sales/${sale.id}/submit`, {}, true)
  check('missing COGS mapping blocks finalization', () => assert.equal(response.data.code, 'MAPPING_NOT_CONFIGURED'))
  const failedJournals = await tx.journalEntry.count({ where: { organizationId: org.id } })
  check('failed finalization rolls revenue journal back', () => assert.equal(failedJournals, 0))
  const cogs = await tx.account.create({ data: { organizationId: org.id, code: 'COGS', name: 'Cost of sales', accountClass: 'EXPENSE', normalBalance: 'DEBIT' } })
  await tx.accountingMapping.create({ data: { organizationId: org.id, key: 'COST_OF_SALES', accountId: cogs.id } })
  response = await api('POST', `/sales/${sale.id}/submit`, {}, true)
  check('daily-sales finalization posts revenue and COGS', () => { assert.equal(response.status, 200); assert.equal(response.data.status, 'approved'); assert.ok(response.data.cogsJournalEntryId) })
  const journals = await tx.journalEntry.findMany({ where: { organizationId: org.id }, include: { lines: true } })
  check('sales journal balances cash revenue and VAT', () => {
    const je = journals.find(j => j.sourceType === 'DAILY_SALE')
    assert.equal(Number(je.totalDebit), 220.4); assert.equal(Number(je.totalCredit), 220.4)
    assert.equal(Number(je.lines.find(l => l.accountId === accountMap.OUTPUT_VAT).creditAmount), 30.4)
    assert.equal(Number(je.lines.find(l => l.accountId === accountMap.SALES_REVENUE).creditAmount), 190)
  })
  check('COGS journal balances expense against inventory', () => { const je = journals.find(j => j.sourceType === 'DAILY_SALE_COGS'); assert.equal(Number(je.totalDebit), 22); assert.equal(Number(je.totalCredit), 22) })
  response = await api('POST', `/sales/${sale.id}/submit`, {}, true)
  check('finalized sale cannot post twice', () => assert.equal(response.status, 400))
  response = await api('POST', `/orders/${paid.id}/refund`, { reason: 'Test' }, true)
  check('finalized-day refund preserves ledger', () => assert.equal(response.data.code, 'SALE_FINALIZED'))
  const second = await place()
  response = await api('POST', `/orders/${second.order.id}/complete`, { paymentMethod: 'card' }, true)
  const secondPaid = response.data
  check('late payment opens fresh draft for finalized day', () => { assert.equal(response.status, 200); assert.notEqual(secondPaid.dailySaleId, sale.id) })
  response = await api('GET', `/sales/day-totals?branchId=${branch.id}&date=${businessDate('Asia/Karachi').toISOString().slice(0, 10)}`, undefined, true)
  check('cash-closing day totals reconcile cash and card', () => { assert.equal(response.data.cash, 220.4); assert.equal(response.data.card, 116); assert.equal(response.data.net, 336.4) })
  response = await api('POST', `/orders/${second.order.id}/refund`, { reason: 'Customer refund' }, true)
  check('draft-day refund removes paid order from sales', () => assert.equal(response.data.status, 'refunded'))
  const deletedDraft = await tx.dailySale.findUnique({ where: { id: secondPaid.dailySaleId } })
  check('empty automatic draft removed after refund', () => assert.equal(deletedDraft, null))
  stock = await tx.branchStock.findUnique({ where: { branchId_itemId: { branchId: branch.id, itemId: item.id } } })
  check('refund restores exact ingredient quantities and value', () => { assert.equal(stock.quantityOnHand, 9.45); assert.equal(stock.totalValue, 378) })
  const year = new Date().getFullYear()
  await tx.dailySale.create({ data: { organizationId: org.id, branchId: branch.id, saleNo: `SL-${year}-0009`, saleDate: businessDate('Asia/Karachi'), subtotal: 0, totalAmount: 0, netAmount: 0, createdBy: user.id } })
  const numbered = await nextNumber(db, 'dailySale', 'saleNo', 'SL', org.id)
  check('deleted document gaps cannot reuse an existing number', () => assert.equal(numbered, `SL-${year}-0010`))
  const third = await place()
  response = await api('POST', `/orders/${third.order.id}/cancel`, { reason: 'Test cancellation' }, true)
  check('unpaid cancellation creates no revenue', () => { assert.equal(response.data.status, 'cancelled'); assert.equal(response.data.totalAmount, 0); assert.equal(response.data.dailySaleId, null) })
  response = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
  check('existing QR dine-in still works', () => assert.equal(response.status, 201))
  const qrOrder = response.data.order
  response = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'dine_in', tableId: table.id, items: [{ dishId: dish.id, quantity: 1 }] }, true)
  check('POS joins running table order with correct total', () => { assert.equal(response.status, 201); assert.equal(response.data.id, qrOrder.id); assert.equal(response.data.totalAmount, 232) })

  // ── Table QR rounds wait for acceptance ──
  const qrItemId = qrOrder.items[0].id
  const posItemId = response.data.items.find(i => i.id !== qrItemId).id
  check('table QR dish waits for acceptance, POS dish goes straight in', () => {
    assert.equal(qrOrder.items[0].status, 'awaiting'); assert.equal(response.data.items.find(i => i.id === posItemId).status, 'pending')
  })
  response = await api('GET', `/kitchen/orders?branchId=${branch.id}`, undefined, true)
  check('kitchen does not show the awaiting dish', () => {
    const ticket = response.data.data.find(o => o.id === qrOrder.id)
    assert.equal(ticket, undefined)
  })
  response = await api('GET', `/orders/online/pending?branchId=${branch.id}`, undefined, true)
  check('acceptance queue lists the table with its waiting dish', () => assert.ok(response.data.data.some(o => o.id === qrOrder.id && o.table.name === 'T1')))
  response = await api('GET', `/orders/stats?branchId=${branch.id}`, undefined, true)
  check('stats count the table waiting for acceptance', () => assert.ok(response.data.awaitingAcceptanceCount >= 1))
  response = await api('POST', `/orders/${qrOrder.id}/complete`, { paymentMethod: 'cash' }, true)
  check('table with an awaiting dish cannot be charged', () => assert.equal(response.data.code, 'NOT_ACCEPTED'))
  response = await api('PATCH', `/orders/${qrOrder.id}/items/${qrItemId}`, { status: 'preparing' }, true)
  check('kitchen cannot start an awaiting dish', () => assert.equal(response.data.code, 'NOT_ACCEPTED'))
  response = await api('POST', `/public/tables/${table.orderToken}/orders`, { guestName: 'Ali', items: [{ dishId: dish.id, quantity: 2 }] })
  const secondRoundId = response.data.order.items.find(i => i.id !== qrItemId && i.status === 'awaiting').id
  check('second QR round joins the running order, also awaiting', () => { assert.equal(response.data.order.id, qrOrder.id); assert.equal(response.data.order.items.filter(i => i.status === 'awaiting').length, 2) })
  response = await api('POST', `/orders/${qrOrder.id}/accept`, { itemIds: [qrItemId] }, true)
  check('accepting the round on screen leaves a later round waiting', () => {
    assert.equal(response.status, 200); assert.deepEqual(response.data.acceptedItemIds, [qrItemId])
    assert.equal(response.data.items.find(i => i.id === qrItemId).status, 'pending'); assert.equal(response.data.items.find(i => i.id === secondRoundId).status, 'awaiting')
  })
  response = await api('POST', `/orders/${qrOrder.id}/accept`, { itemIds: [qrItemId] }, true)
  check('an accepted dish cannot be accepted again', () => assert.equal(response.status, 409))
  response = await api('POST', `/orders/${qrOrder.id}/reject`, { reason: 'Some items are no longer available' }, true)
  check('rejecting a round keeps the table order open with the rest', () => {
    assert.equal(response.status, 200); assert.equal(response.data.status, 'open'); assert.equal(response.data.totalAmount, 232)
    const rejected = response.data.items.find(i => i.id === secondRoundId)
    assert.equal(rejected.status, 'cancelled'); assert.equal(rejected.rejectReason, 'Some items are no longer available')
  })
  response = await api('GET', `/public/tables/${table.orderToken}/order`)
  check('guests see the turned-down dish with its reason', () => {
    const rejected = response.data.order.items.find(i => i.id === secondRoundId)
    assert.equal(rejected.status, 'cancelled'); assert.equal(rejected.rejectReason, 'Some items are no longer available')
  })
  response = await api('POST', `/orders/${qrOrder.id}/reject`, { reason: 'x' }, true)
  check('nothing left to reject on the table', () => assert.equal(response.status, 409))
  const table2 = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'T2', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  response = await api('POST', `/public/tables/${table2.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
  const lonely = response.data.order
  response = await api('POST', `/orders/${lonely.id}/reject`, { reason: 'We are closing soon' }, true)
  check('rejecting a new table order frees the table', () => { assert.equal(response.data.status, 'cancelled'); assert.ok(response.data.rejectedAt); assert.equal(response.data.totalAmount, 0) })
  response = await api('POST', `/public/tables/${table2.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
  check('the freed table starts a fresh order', () => { assert.equal(response.status, 201); assert.notEqual(response.data.order.id, lonely.id) })
  await api('POST', `/orders/${response.data.order.id}/reject`, { reason: 'cleanup' }, true)

  // ── Guests cancel from the table QR until the kitchen starts preparing ──
  const table3 = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'T3', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  const guestCancel = (itemIds) => api('POST', `/public/tables/${table3.orderToken}/cancel`, itemIds ? { itemIds } : {})
  response = await guestCancel()
  check('guest cancel needs an open order', () => assert.equal(response.data.code, 'ORDER_NOT_FOUND'))
  response = await api('POST', `/public/tables/${table3.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
  const t3Order = response.data.order
  const cookingId = t3Order.items[0].id
  await api('POST', `/orders/${t3Order.id}/accept`, {}, true)
  // Historical unpaid cooking fixture: cancellation rules still protect legacy orders.
  await tx.customerOrderItem.update({ where: { id: cookingId }, data: { status: 'preparing' } })
  response = await api('POST', `/public/tables/${table3.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 2 }] })
  const queuedId = response.data.order.items.find(i => i.status === 'awaiting').id
  await api('POST', `/orders/${t3Order.id}/accept`, { itemIds: [queuedId] }, true)
  response = await api('POST', `/public/tables/${table3.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
  const awaitingId = response.data.order.items.find(i => i.status === 'awaiting').id
  check('three rounds: preparing, accepted, awaiting', () => assert.equal(response.data.order.totalAmount, 464))
  response = await guestCancel([cookingId])
  check('guest cannot cancel a dish already being prepared', () => { assert.equal(response.status, 409); assert.equal(response.data.code, 'ALREADY_PREPARING') })
  response = await guestCancel([awaitingId, cookingId])
  check('a mixed request cancels nothing', () => assert.equal(response.data.code, 'ALREADY_PREPARING'))
  response = await guestCancel(['not-an-item'])
  check('guest cannot cancel a dish not on the order', () => assert.equal(response.data.code, 'ITEM_NOT_FOUND'))
  response = await guestCancel([awaitingId])
  check('guest cancels a dish awaiting confirmation', () => {
    assert.equal(response.status, 200); assert.equal(response.data.cancelledCount, 1); assert.equal(response.data.order.totalAmount, 348)
    assert.ok(!response.data.order.items.some(i => i.id === awaitingId))
  })
  // staff screens are told which cancelled dishes the kitchen had, so the
  // printer device can print a cancellation slip for them
  const stream = await fetch(`${base}/events/stream`, { headers: { Authorization: `Bearer ${token}` } })
  const reader = stream.body.getReader()
  const cancelledEvent = (async () => {
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return null
      buffer += Buffer.from(value).toString()
      const hit = buffer.split('\n').find((l) => l.startsWith('data:') && l.includes('guest_cancelled'))
      if (hit) return JSON.parse(hit.slice(5))
    }
  })()
  response = await guestCancel()
  const liveCancel = await Promise.race([cancelledEvent, new Promise((r) => setTimeout(() => r(null), 3000))])
  await reader.cancel()
  check('staff stream lists the kitchen dishes a guest cancelled', () => {
    assert.ok(liveCancel); assert.equal(liveCancel.orderId, t3Order.id); assert.deepEqual(liveCancel.itemIds, [queuedId])
  })
  check('cancel-all takes back only dishes the kitchen has not started', () => {
    assert.equal(response.status, 200); assert.equal(response.data.cancelledCount, 2); assert.equal(response.data.order.status, 'open')
    assert.deepEqual(response.data.order.items.map(i => i.id), [cookingId]); assert.equal(response.data.order.totalAmount, 116)
  })
  response = await guestCancel()
  check('nothing left that can be cancelled', () => { assert.equal(response.status, 409); assert.equal(response.data.code, 'ALREADY_PREPARING') })
  await api('POST', `/orders/${t3Order.id}/cancel`, { reason: 'cleanup' }, true)
  response = await api('POST', `/public/tables/${table3.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
  const soloOrder = response.data.order
  response = await guestCancel([soloOrder.items[0].id])
  const soloAfter = await tx.customerOrder.findUnique({ where: { id: soloOrder.id } })
  check('cancelling everything closes the order and frees the table', () => {
    assert.equal(response.status, 200); assert.equal(response.data.order, null)
    assert.equal(soloAfter.status, 'cancelled'); assert.equal(soloAfter.totalAmount, 0); assert.ok(soloAfter.closedAt)
  })
  response = await api('GET', `/orders/online/pending?branchId=${branch.id}`, undefined, true)
  check('a cancelled table order leaves the acceptance queue', () => assert.ok(!response.data.data.some(o => o.id === soloOrder.id)))
  response = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', customerName: 'Counter customer', items: [{ dishId: dish.id, quantity: 1 }] }, true)
  check('POS takeaway remains independent of online orders', () => { assert.equal(response.status, 201); assert.equal(response.data.source, 'pos'); assert.notEqual(response.data.id, qrOrder.id) })
  const posOrder = response.data
  response = await api('POST', `/orders/${posOrder.id}/complete`, { paymentMethod: 'bank_transfer' }, true)
  check('bank-transfer payment enters matching daily-sales bucket', () => assert.equal(response.status, 200))
  const bankSale = await tx.dailySale.findUnique({ where: { id: response.data.dailySaleId } })
  check('bank receipt and tax reconcile', () => { assert.equal(bankSale.bankTransferAmount, 116); assert.equal(bankSale.vatAmount, 16) })
  response = await api('GET', '/accounting/trial-balance', undefined, true)
  check('trial balance recognizes finalized net revenue and COGS', () => { assert.equal(response.data.summary.totalRevenue, 190); assert.equal(response.data.summary.totalExpenses, 22); assert.equal(response.data.summary.netIncome, 168) })
  const date = businessDate('Asia/Karachi').toISOString().slice(0, 10)
  response = await api('POST', '/expenses/categories', { name: 'Utilities' }, true)
  const expenseCategory = response.data
  response = await api('POST', '/expenses', { branchId: branch.id, expenseDate: date, categoryId: expenseCategory.id, description: 'Test utility', amount: 100, vatAmount: 16, totalAmount: 116, paymentMethod: 'cash' }, true)
  check('expense creates draft without posting', () => { assert.equal(response.status, 201); assert.equal(response.data.status, 'draft') })
  const expense = response.data
  await api('POST', `/expenses/${expense.id}/submit`, {}, true)
  response = await api('POST', `/expenses/${expense.id}/approve`, {}, true)
  check('expense approval posts balanced cost and input VAT', () => { assert.equal(response.status, 200); assert.ok(response.data.journalEntryId) })
  response = await api('POST', `/expenses/${expense.id}/void`, { voidReason: 'Regression reversal' }, true)
  check('expense reversal preserves audit trail', () => assert.equal(response.data.status, 'void'))
  response = await api('GET', '/accounting/trial-balance', undefined, true)
  check('voided expense and reversal net to zero', () => assert.equal(response.data.summary.totalExpenses, 22))
  response = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: date, openingCash: 100, cashSales: 220.4, cashExpensesPaid: 20, cashDeposited: 50, actualCashCounted: 240.4 }, true)
  const closing = response.data
  check('cash closing computes expected balance and shortage', () => { assert.equal(response.status, 201); assert.ok(Math.abs(closing.expectedCash - 250.4) < 0.001); assert.equal(closing.differenceType, 'short') })
  await api('POST', `/cash-closing/${closing.id}/submit`, {}, true)
  response = await api('POST', `/cash-closing/${closing.id}/approve`, {}, true)
  check('cash shortage approval posts adjustment', () => { assert.equal(response.status, 200); assert.ok(response.data.journalEntryId) })
  const shortage = await tx.journalEntry.findUnique({ where: { id: response.data.journalEntryId }, include: { lines: true } })
  check('shortage debit and cash credit reconcile', () => { assert.equal(Number(shortage.totalDebit), 10); assert.equal(Number(shortage.totalCredit), 10) })
  const supplier = await tx.supplier.create({ data: { organizationId: org.id, name: 'Test vendor' } })
  const { createPurchaseBill } = require('../dist/services/purchasing')
  const purchase = await db.$transaction(dbTx => createPurchaseBill(dbTx, { organizationId: org.id, branchId: branch.id, supplierId: supplier.id, supplierName: supplier.name,
    categoryId: expenseCategory.id, supplyDate: businessDate('Asia/Karachi'), paymentDate: businessDate('Asia/Karachi'), paymentType: 'cash', vatPercent: 16, amountPaid: 50,
    items: [{ itemId: item.id, description: 'Ingredient receipt', quantity: 2, unitCost: 40 }], createdBy: user.id }))
  check('purchasing reconciles inventory tax partial payment and payable', () => { assert.equal(purchase.bill.totalAmount, 92.8); assert.equal(purchase.bill.paidAmount, 50); assert.ok(Math.abs(purchase.bill.balanceDue - 42.8) < 0.001); assert.equal(purchase.bill.status, 'partial') })
  const purchaseJournal = await tx.journalEntry.findFirst({ where: { referenceId: purchase.bill.id, sourceType: 'BILL' }, include: { lines: true } })
  check('purchase journal balances inventory and input VAT with payable', () => { assert.equal(Number(purchaseJournal.totalDebit), 92.8); assert.equal(Number(purchaseJournal.totalCredit), 92.8) })
  const beforePaymentJournals = await tx.journalEntry.count({ where: { organizationId: org.id } })
  response = await api('POST', '/expenses/purchasing-payment', { billId: purchase.bill.id, paymentDate: date, paymentMethod: 'cash', amount: 42.8, paidBy: 'Test cashier' }, true)
  const paymentExpense = response.data
  check('purchase payment expense settles payable without duplicate cost', () => { assert.equal(response.status, 201); assert.equal(paymentExpense.source, 'purchasing') })
  const afterPaymentJournals = await tx.journalEntry.count({ where: { organizationId: org.id } })
  check('purchase payment posts exactly one journal', () => assert.equal(afterPaymentJournals, beforePaymentJournals + 1))
  response = await api('POST', `/expenses/${paymentExpense.id}/void`, { voidReason: 'Undo payment' }, true)
  const purchaseAfterVoid = await tx.bill.findUnique({ where: { id: purchase.bill.id } })
  check('voiding payment reopens supplier balance', () => { assert.equal(response.status, 200); assert.equal(purchaseAfterVoid.status, 'partial'); assert.ok(Math.abs(purchaseAfterVoid.balanceDue - 42.8) < 0.001) })
  for (const path of [
    '/auth/me', '/branches', '/users', '/acl/roles', '/sales', '/sales/summary', '/expenses', '/expenses/pending-approval',
    '/cash-closing', '/cash-closing/pending-approval', '/suppliers', '/suppliers/bills', '/purchase-orders', '/documents', '/alerts', '/notifications',
    '/accounts', '/accounts/tree', '/accounts/summary', '/bank-accounts', '/tax-rates', '/accounting-settings/mappings', '/accounting-periods',
    '/accounting/journals', '/accounting/trial-balance', '/reports/dashboard', '/reports/dashboard-v2', '/reports/financial', '/reports/inventory-health',
    '/reports/sales', '/reports/daily-sales', '/reports/branch-sales', '/reports/branch-profit', '/inventory/items', '/inventory/stock', '/inventory/wastage',
    '/inventory/stock-outs', '/menu/dishes', '/menu/shifts', `/menu/costing?branchId=${branch.id}`, `/kitchen/orders?branchId=${branch.id}`, `/pos/menu?branchId=${branch.id}`,
  ]) {
    response = await api('GET', path, undefined, true)
    check(`module API smoke ${path.split('?')[0]}`, () => assert.equal(response.status, 200, JSON.stringify(response.data)))
  }
  check('business date rolls at Pakistan midnight', () => assert.equal(businessDate('Asia/Karachi', new Date('2026-10-11T19:01:00Z')).toISOString().slice(0, 10), '2026-10-12'))
  const entryInput = { organizationId: org.id, branchId: branch.id, entryDate: businessDate('Asia/Karachi'), description: 'Test', referenceType: 'test', referenceId: org.id, createdBy: user.id,
    lines: [{ accountId: accountMap.CASH_ON_HAND, debitAmount: 10 }, { accountId: accountMap.SALES_REVENUE, creditAmount: 9 }] }
  await assert.rejects(() => postJournalEntry(db, entryInput), e => e.code === 'UNBALANCED_ENTRY')
  check('unbalanced financial journal blocked', () => assert.ok(true))
  const lockedPeriod = await tx.accountingPeriod.create({ data: { organizationId: org.id, name: 'Test locked', startDate: new Date('1900-01-01'), endDate: new Date('2100-01-01'), status: 'LOCKED' } })
  await assert.rejects(() => postJournalEntry(db, { ...entryInput, lines: [{ accountId: accountMap.CASH_ON_HAND, debitAmount: 10 }, { accountId: accountMap.SALES_REVENUE, creditAmount: 10 }] }), e => e.code === 'PERIOD_LOCKED')
  check('locked accounting period prevents posting', () => assert.ok(true))
  // Subsequent cash-control scenarios require an open posting period.
  await tx.accountingPeriod.delete({ where: { id: lockedPeriod.id } })
  for (let i = 0; i < 11; i++) response = await api('POST', onlinePath + '/orders', {}, false, '10.20.0.1')
  check('public order rate limit enforced', () => assert.equal(response.status, 429))
  await require('./controls.cjs')({ tx, api, org, dish, item, signAccessToken, businessDate, check })
  await require('./menu-options.cjs')({ tx, api, signAccessToken, check })
  await require('./zatca.cjs')({ tx, api, signAccessToken, check })
  await require('./kitchen.cjs')({ tx, api, signAccessToken, check })
  await require('./reports.cjs')({ api, base, token, org, businessDate, check })
  await require('./tills.cjs')({ tx, api, signAccessToken, check })
  await require('./offline-pos.cjs')({ tx, api, signAccessToken, check })
  await require('./delivery.cjs')({ tx, api, signAccessToken, check, base })
  await require('./floor.cjs')({ tx, api, signAccessToken, check, base })
  await require('./customers.cjs')({ tx, api, signAccessToken, check, base })
  await require('./promotions.cjs')({ tx, api, signAccessToken, check })
  await require('./payments.cjs')({ tx, api, signAccessToken, check, base })
  await require('./payment-first.cjs')({ tx, api, signAccessToken, check })
  await require('./single-branch.cjs')({ tx, api, base, token, org, branch, table, check })
  if (process.env.UI_TEST_HOLD === '1') {
    console.log(`UI fixture ready: /order/${branch.id}. Send input to roll back.`)
    await new Promise(resolve => process.stdin.once('data', resolve))
  }
}

rootDb.$transaction(async tx => { await run(tx); throw rollback }, { timeout: process.env.UI_TEST_HOLD === '1' ? 600000 : 120000, maxWait: 10000 })
  .catch(error => { if (error !== rollback) { console.error(error); process.exitCode = 1 } })
  .finally(async () => {
    if (server) await new Promise(resolve => server.close(resolve))
    await rootDb.$disconnect()
    await originalDb.$disconnect()
    console.log(`${passed} checks passed; all test fixtures rolled back.`)
  })
