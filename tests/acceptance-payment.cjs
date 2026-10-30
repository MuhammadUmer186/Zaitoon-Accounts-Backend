const assert = require('node:assert/strict')
const crypto = require('node:crypto')

module.exports = async ({ tx, api, org, branch, dish, check }) => {
  await tx.$executeRawUnsafe('SAVEPOINT acceptance_payment_scenarios')
  try {
    let r = await api('PUT', '/commerce-settings', { loyaltyEarnPerUnit: 0, loyaltyPointValue: 0, promotionsStack: false, providerName: '', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '', paymentAdapter: 'simulator' }, true)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const board = async () => (await api('GET', `/kitchen/orders?branchId=${branch.id}`, undefined, true)).data.data
    for (const orderType of ['delivery', 'takeaway', 'dine_in']) {
      r = await api('POST', `/public/online/branches/${branch.id}/orders`, { requestId: crypto.randomUUID(), orderType, customerName: 'Payment customer', customerPhone: '+923001234567', deliveryAddress: orderType === 'delivery' ? 'Test Road, House 123' : undefined, items: [{ dishId: dish.id, quantity: 1 }] })
      assert.equal(r.status, 201, JSON.stringify(r.data))
      const placed = r.data, path = `/public/online/orders/${placed.trackingCode}`
      r = await api('GET', path)
      check(`${orderType}: pending online order cannot pay or confirm preparation`, () => { assert.equal(r.data.order.payable, false); assert.equal(r.data.order.paid, false) })
      r = await api('POST', path + '/pay', { amount: 1 })
      check(`${orderType}: checkout requires restaurant acceptance`, () => assert.equal(r.data.code, 'NOT_ACCEPTED'))
      r = await api('POST', '/payments/terminal', { orderId: placed.order.id }, true)
      check(`${orderType}: terminal cannot bypass acceptance`, () => assert.equal(r.data.code, 'NOT_ACCEPTED'))
      r = await api('POST', `/orders/${placed.order.id}/accept`, { estimatedMinutes: 20 }, true)
      assert.equal(r.status, 200, JSON.stringify(r.data))
      // Time spent waiting for payment must not consume the preparation estimate.
      const acceptedAt = new Date(Date.now() - 30 * 60000)
      await tx.customerOrder.update({ where: { id: placed.order.id }, data: { acceptedAt, estimatedReadyAt: new Date(acceptedAt.getTime() + 20 * 60000) } })
      r = await api('GET', path)
      check(`${orderType}: acceptance opens checkout before food is served`, () => { assert.equal(r.data.order.payable, true); assert.equal(r.data.order.paymentsAvailable, true); assert.equal(r.data.order.served, false); assert.equal(r.data.order.paid, false) })
      assert.ok(!(await board()).some((order) => order.id === placed.order.id))
      r = await api('POST', path + '/pay', { amount: 1 })
      const payment = r.data
      check(`${orderType}: tracking checkout uses the server's full amount`, () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(payment.amount, placed.order.totalAmount); assert.ok(payment.payPath.startsWith('/pay/')) })
      r = await api('POST', `/public/payments/${payment.id}/simulate`, { t: payment.accessToken, outcome: 'approve' })
      assert.equal(r.data.status, 'succeeded', JSON.stringify(r.data))
      const paid = (await api('GET', path)).data.order, tickets = await board()
      check(`${orderType}: verified payment confirms the order for kitchen preparation`, () => { assert.equal(paid.paid, true); assert.equal(paid.payable, false); assert.ok(tickets.some((order) => order.id === placed.order.id)); assert.equal(paid.served, false) })
      check(`${orderType}: preparation estimate starts after full payment`, () => assert.equal(new Date(paid.estimatedReadyAt) - new Date(paid.closedAt), 20 * 60000))
      r = await api('POST', path + '/pay', {})
      check(`${orderType}: paid tracking link cannot charge again`, () => assert.equal(r.data.code, 'INVALID_STATUS'))
      r = await api('POST', path + 'x/pay', {})
      check(`${orderType}: tampering with a tracking link grants no checkout access`, () => assert.equal(r.status, 404))
    }
    const table = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Payment first QR', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
    const path = `/public/checkout/tables/${table.orderToken}`
    const tableState = async () => {
      const admin = await api('GET', `/tables?branchId=${branch.id}`, undefined, true)
      const floor = await api('GET', `/floor?branchId=${branch.id}`, undefined, true)
      assert.equal(admin.status, 200, JSON.stringify(admin.data))
      assert.equal(floor.status, 200, JSON.stringify(floor.data))
      const a = admin.data.data.find(t => t.id === table.id), f = floor.data.data.find(t => t.id === table.id)
      assert.equal(a.floorStatus, f.floorStatus)
      return a
    }
    const initialTable = await tableState()
    check('QR and portal start with a genuinely free table', () => assert.equal(initialTable.floorStatus, 'free'))
    r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 2 }] })
    assert.equal(r.status, 201, JSON.stringify(r.data))
    const order = r.data.order
    const occupied = await tableState()
    check('mobile order immediately occupies the same portal and floor table', () => { assert.equal(occupied.floorStatus, 'ordered'); assert.equal(occupied.openOrder.id, order.id) })
    r = await api('POST', path + '/pay', {})
    check('QR checkout blocks dishes awaiting acceptance', () => assert.equal(r.data.code, 'NOT_ACCEPTED'))
    r = await api('POST', `/public/tables/${table.orderToken}/bill`, {})
    check('payment assistance waits for dish acceptance', () => assert.equal(r.data.code, 'NOT_ACCEPTED'))
    await api('POST', `/orders/${order.id}/accept`, {}, true)
    r = await api('GET', path)
    check('QR bill can pay and split after acceptance without served food', () => { assert.equal(r.data.payable, true); assert.equal(r.data.canSplit, true); assert.equal(r.data.order.served, false) })
    r = await api('POST', `/public/tables/${table.orderToken}/bill`, {})
    check('staff payment assistance is available before preparation', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
    r = await api('POST', path + '/split', { mode: 'equal', count: 2 })
    assert.equal(r.status, 201, JSON.stringify(r.data))
    const checks = r.data.checks
    for (let index = 0; index < checks.length; index++) {
      const payment = (await api('POST', path + '/pay', { checkId: checks[index].id })).data
      r = await api('POST', `/public/payments/${payment.id}/simulate`, { t: payment.accessToken, outcome: 'approve' })
      assert.equal(r.data.status, 'succeeded', JSON.stringify(r.data))
      const tickets = await board()
      check(index ? 'final QR check confirms preparation' : 'partial QR payment cannot release any dishes', () => assert.equal(tickets.some((ticket) => ticket.id === order.id), index === checks.length - 1))
    }
    const paidTable = await tableState()
    check('paid QR table is shown as needing clearing instead of free', () => { assert.equal(paidTable.floorStatus, 'paid_awaiting_clear'); assert.equal(paidTable.openOrder, null); assert.equal(paidTable.needsClearing, true) })
    r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
    check('uncleared table cannot start a mobile order', () => assert.equal(r.data.code, 'TABLE_NEEDS_CLEARING'))
    r = await api('POST', `/floor/tables/${table.id}/clear`, {}, true)
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const cleared = await tableState()
    check('staff clearing makes the table free on both portal screens', () => { assert.equal(cleared.floorStatus, 'free'); assert.equal(cleared.needsClearing, false); assert.equal(cleared.seatedAt, null) })
    r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
    check('mobile can place a fresh order after staff clears the table', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.notEqual(r.data.order.id, order.id) })
    const newOrder = r.data.order
    r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: dish.id, quantity: 1 }] })
    check('another guest joins the active table order without a reservation error', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.order.id, newOrder.id); assert.equal(r.data.order.items.length, 2) })
  } finally {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT acceptance_payment_scenarios')
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT acceptance_payment_scenarios')
  }
}
