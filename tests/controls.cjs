// Access control and cash-control regression checks: module/permission gates,
// system-calculated cash closing, separation of duties, discount policy,
// split payments and dish cancellation after cooking. Runs inside the
// caller's rolled-back transaction.
const assert = require('node:assert/strict')

module.exports = async function controlsTests({ tx, api, org, dish, item, signAccessToken, businessDate, check }) {
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Controls outlet', code: 'CTRL', vatRate: 16 } })
  await tx.branchStock.create({ data: { organizationId: org.id, branchId: branch.id, itemId: item.id, quantityOnHand: 10, averageCost: 40, totalValue: 400 } })
  const permission = async (key, module) => tx.permission.upsert({ where: { key }, update: {}, create: { key, module, description: key } })
  const makeUser = async (name, keys) => {
    const user = await tx.user.create({ data: { organizationId: org.id, email: `${name}@controls.invalid`, passwordHash: 'unused', firstName: name, lastName: 'Test' } })
    if (keys) {
      const role = await tx.role.create({ data: { organizationId: org.id, name: `controls_${name}`, displayName: name } })
      for (const [key, module] of keys) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: (await permission(key, module)).id } })
      await tx.userRole.create({ data: { roleId: role.id, userId: user.id } })
    }
    return signAccessToken(user.id, org.id, user.email)
  }
  const nobody = await makeUser('nobody', null)
  const cashier = await makeUser('cashier', [['can_use_pos', 'pos'], ['can_manage_orders', 'orders'], ['can_create_cash_closing', 'cash_closing'], ['can_create_sales', 'sales']])
  const manager = await makeUser('manager', [['can_use_pos', 'pos'], ['can_manage_orders', 'orders'], ['can_apply_discount', 'orders'], ['can_create_cash_closing', 'cash_closing'], ['can_approve_cash_closing', 'cash_closing']])
  const kitchen = await makeUser('kitchen', [['can_manage_kitchen', 'kitchen'], ['can_void_items', 'orders']])
  const date = businessDate('Asia/Karachi').toISOString().slice(0, 10)
  const posOrder = async (token, quantity = 1) => {
    const r = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity }] }, token)
    assert.equal(r.status, 201, JSON.stringify(r.data))
    return r.data
  }

  // ── module and permission gates
  for (const path of ['/accounting/trial-balance', '/reports/financial', '/sales', '/expenses', '/inventory/stock', '/suppliers', '/cash-closing', '/purchase-orders', '/alerts']) {
    const r = await api('GET', path, undefined, nobody)
    check(`user without a role is refused ${path}`, () => assert.equal(r.status, 403))
  }
  let r = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: date }, nobody)
  check('user without a role cannot create a cash closing', () => assert.equal(r.status, 403))
  r = await api('GET', '/sales', undefined, kitchen)
  check('kitchen staff cannot read sales', () => assert.equal(r.status, 403))
  r = await api('GET', '/accounting/trial-balance', undefined, cashier)
  check('cashier cannot read the trial balance', () => assert.equal(r.status, 403))
  r = await api('GET', `/sales/day-totals?branchId=${branch.id}&date=${date}`, undefined, cashier)
  check('cash closing can still read the day totals', () => assert.equal(r.status, 200))

  // ── discount policy (staff limit 10% by default)
  let order = await posOrder(cashier)
  r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'cash', discountAmount: 58 }, cashier)
  check('discount without a reason is refused', () => assert.equal(r.status, 400))
  r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'cash', discountAmount: 58, discountReason: 'Friend of owner' }, cashier)
  check('cashier cannot give a discount above the staff limit', () => { assert.equal(r.status, 403); assert.equal(r.data.code, 'DISCOUNT_LIMIT') })
  r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'cash', discountAmount: 58, discountReason: 'Service recovery' }, manager)
  check('manager can approve a larger discount with a reason', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.discountReason, 'Service recovery'); assert.equal(r.data.totalAmount, 58) })
  order = await posOrder(cashier)
  r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'cash', discountAmount: 11.6, discountReason: 'Loyal guest' }, cashier)
  check('cashier can give a discount within the limit', () => { assert.equal(r.status, 200); assert.equal(r.data.totalAmount, 104.4) })

  // ── split payment
  order = await posOrder(cashier)
  r = await api('POST', `/orders/${order.id}/complete`, { payments: [{ method: 'cash', amount: 50 }, { method: 'card', amount: 50 }] }, cashier)
  check('payments that do not add up to the bill are refused', () => { assert.equal(r.status, 400); assert.equal(r.data.code, 'PAYMENT_MISMATCH') })
  r = await api('POST', `/orders/${order.id}/complete`, { payments: [{ method: 'cash', amount: 50 }, { method: 'card', amount: 66 }], amountTendered: 100 }, cashier)
  check('split bill is stored per method with change on the cash part', () => {
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.paymentMethod, 'split'); assert.equal(r.data.payments.length, 2); assert.equal(r.data.changeAmount, 50)
  })
  const sale = await tx.dailySale.findUnique({ where: { id: r.data.dailySaleId } })
  check('daily sale books each part of a split bill to its method', () => {
    assert.ok(Math.abs(sale.cashAmount - (58 + 104.4 + 50)) < 0.001, String(sale.cashAmount)); assert.ok(Math.abs(sale.cardAmount - 66) < 0.001)
  })

  // ── dish cancellation
  order = await posOrder(cashier, 2)
  const line = order.items[0]
  r = await api('PATCH', `/orders/${order.id}/items/${line.id}`, { status: 'cancelled' }, kitchen)
  check('removing a dish needs a reason', () => assert.equal(r.status, 400))
  r = await api('PATCH', `/orders/${order.id}/items/${line.id}`, { status: 'preparing' }, kitchen)
  check('kitchen cannot prepare an unpaid dish', () => assert.equal(r.data.code, 'PAYMENT_REQUIRED'))
  // Legacy cooking fixture for historical wastage and cancellation coverage.
  await tx.customerOrderItem.update({ where: { id: line.id }, data: { status: 'preparing' } })
  const before = await tx.branchStock.findUnique({ where: { branchId_itemId: { branchId: branch.id, itemId: item.id } } })
  r = await api('PATCH', `/orders/${order.id}/items/${line.id}`, { status: 'cancelled', reason: 'Dropped on the floor' }, kitchen)
  const cancelled = await tx.customerOrderItem.findUnique({ where: { id: line.id } })
  const after = await tx.branchStock.findUnique({ where: { branchId_itemId: { branchId: branch.id, itemId: item.id } } })
  const waste = await tx.stockMovement.findFirst({ where: { referenceId: order.id, movementType: 'wastage' } })
  check('dish cancelled after cooking is written off as wastage', () => {
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(cancelled.cancelReason, 'Dropped on the floor'); assert.ok(cancelled.wastedAt); assert.ok(cancelled.cancelledBy)
    assert.ok(waste); assert.ok(Math.abs(before.quantityOnHand - after.quantityOnHand - 0.55) < 0.0001, `${before.quantityOnHand} -> ${after.quantityOnHand}`)
  })
  const audit = await tx.auditLog.findFirst({ where: { resourceId: order.id, action: 'cancel_item' } })
  check('dish cancellation is in the audit log', () => assert.ok(audit))

  // ── cash closing: system cash, duplicates, negatives, separation of duties
  r = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: date, openingCash: 0, actualCashCounted: -5 }, cashier)
  check('negative cash counted is refused', () => assert.equal(r.status, 400))
  r = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: date, openingCash: 1000, cashSales: 999999, actualCashCounted: 1212.4 }, cashier)
  const closing = r.data
  check('cash sales come from the system, not the form', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.ok(Math.abs(closing.cashSales - 212.4) < 0.001, String(closing.cashSales)); assert.equal(closing.differenceType, 'balanced') })
  r = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: date }, manager)
  check('a second closing for the same branch and day is refused', () => { assert.equal(r.status, 409); assert.equal(r.data.code, 'DUPLICATE_CLOSING') })
  r = await api('PUT', `/cash-closing/${closing.id}`, { cashSales: 5 }, cashier)
  check('editing cannot override cash sales', () => assert.ok(Math.abs(r.data.cashSales - 212.4) < 0.001))
  await api('POST', `/cash-closing/${closing.id}/submit`, {}, cashier)
  r = await api('POST', `/cash-closing/${closing.id}/approve`, {}, cashier)
  check('cashier cannot approve a cash closing', () => assert.equal(r.status, 403))
  r = await api('POST', `/cash-closing/${closing.id}/approve`, {}, manager)
  check('another user with approval rights approves it', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
  r = await api('POST', `/cash-closing/${closing.id}/void`, { voidReason: 'Recount' }, manager)
  const own = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: date, actualCashCounted: 212.4 }, manager)
  await api('POST', `/cash-closing/${own.data.id}/submit`, {}, manager)
  r = await api('POST', `/cash-closing/${own.data.id}/approve`, {}, manager)
  check('nobody approves their own cash closing', () => { assert.equal(r.status, 403); assert.equal(r.data.code, 'SELF_APPROVAL') })
  // leave the organization with its original locations for the single-branch checks
  await tx.branch.update({ where: { id: branch.id }, data: { isActive: false } })
}
