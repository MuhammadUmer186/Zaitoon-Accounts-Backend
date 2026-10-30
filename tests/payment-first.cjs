const assert = require('node:assert/strict')
const crypto = require('node:crypto')

module.exports = async ({ tx, api, signAccessToken, check }) => {
  const org = await tx.organization.create({ data: { name: 'Payment-first tests', country: 'SA', currency: 'SAR', requireTillForCash: false } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Main', code: 'PF', vatRate: 15 } })
  const user = await tx.user.create({ data: { organizationId: org.id, email: 'cashier@payment-first.invalid', firstName: 'Cashier', lastName: 'Test', passwordHash: 'x' } })
  const role = await tx.role.create({ data: { organizationId: org.id, name: 'super_admin', displayName: 'Admin' } })
  await tx.userRole.create({ data: { userId: user.id, roleId: role.id } })
  const token = signAccessToken(user.id, org.id, user.email)
  const shift = await tx.menuShift.create({ data: { organizationId: org.id, name: 'All day', startTime: '00:00', endTime: '00:00' } })
  const category = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Food' } })
  const dish = await tx.dish.create({ data: { organizationId: org.id, categoryId: category.id, name: 'Meal', price: 115, shifts: { create: { shiftId: shift.id } } } })
  for (const counterCode of ['main', 'counter-2']) await tx.zatcaDevice.create({ data: { organizationId: org.id, branchId: branch.id, counterCode, environment: 'sandbox', status: 'failed', egsSerial: crypto.randomUUID(), commonName: counterCode, street: 'Test Road', building: '1234', district: 'Test', city: 'Riyadh', postalCode: '12345' } })
  const create = async (orderType = 'takeaway', extra = {}) => {
    const r = await api('POST', '/pos/orders', { branchId: branch.id, orderType, deliveryAddress: orderType === 'delivery' ? 'Test Street 123' : undefined, items: [{ dishId: dish.id, quantity: 1 }], ...extra }, token)
    assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data
  }
  const board = async () => (await api('GET', `/kitchen/orders?branchId=${branch.id}`, undefined, token)).data.data
  for (const orderType of ['takeaway', 'delivery', 'dine_in']) {
    const table = orderType === 'dine_in' ? await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Split', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } }) : null
    const order = await create(orderType, table ? { tableId: table.id } : {})
    const unpaidBoard = await board()
    check(`${orderType}: unpaid order is hidden from kitchen`, () => assert.ok(!unpaidBoard.some(o => o.id === order.id)))
    if (table) {
      let r = await api('POST', `/orders/${order.id}/checks`, { mode: 'equal', count: 2 }, token)
      assert.equal(r.status, 201, JSON.stringify(r.data))
      const checks = r.data.checks
      r = await api('POST', `/orders/${order.id}/checks/${checks[0].id}/pay`, { counterCode: 'counter-2', payments: [{ method: 'mada', amount: checks[0].totalAmount }] }, token)
      check('partial MADA check leaves parent unpaid', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'open'); assert.equal(r.data.checks[0].counterCode, 'counter-2') })
      assert.ok(!(await board()).some(o => o.id === order.id))
      r = await api('POST', `/kitchen/orders/${order.id}/advance`, { from: 'pending' }, token)
      check('partially paid split cannot prepare any dish', () => assert.equal(r.data.code, 'PAYMENT_REQUIRED'))
      r = await api('POST', `/orders/${order.id}/checks/${checks[1].id}/pay`, { counterCode: 'main', payments: [{ method: 'cash', amount: checks[1].totalAmount }] }, token)
      check('final check releases the complete ticket', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'completed') })
    } else {
      const r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'mada', counterCode: 'counter-2' }, token)
      check(`${orderType}: full MADA payment captures counter`, () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.counterCode, 'counter-2') })
      const sale = await tx.dailySale.findUniqueOrThrow({ where: { id: r.data.dailySaleId } })
      check('MADA settlements reconcile to card totals', () => assert.ok(sale.cardAmount >= order.totalAmount))
    }
    assert.ok((await board()).some(o => o.id === order.id))
  }
  const invalid = await create()
  let r = await api('POST', `/orders/${invalid.id}/complete`, { paymentMethod: 'cash', counterCode: 'unknown' }, token)
  check('unregistered counter cannot silently select a different certificate', () => assert.equal(r.data.code, 'INVALID_COUNTER'))
  const nativeFetch = global.fetch, previousBase = process.env.PAYMENT_CALLBACK_BASE_URL
  const invoices = new Map()
  process.env.PAYMENT_CALLBACK_BASE_URL = 'https://api.foodsync.invalid/api/v1'
  global.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.moyasar.com/v1/')) return nativeFetch(url, options)
    assert.match(options.headers.Authorization, /^Basic /)
    const path = new URL(url).pathname
    let data
    if (path === '/v1/invoices') {
      const body = JSON.parse(options.body), id = crypto.randomUUID()
      data = { ...body, id, status: 'initiated', url: `https://checkout.moyasar.com/invoices/${id}`, payments: [] }
      invoices.set(id, data)
    } else if (path.startsWith('/v1/invoices/')) data = invoices.get(path.split('/').pop())
    else if (path.endsWith('/refund')) { const id = path.split('/')[3]; data = { id, status: 'refunded', refunded: JSON.parse(options.body).amount } }
    assert.ok(data, path)
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    r = await api('PUT', '/commerce-settings', { loyaltyEarnPerUnit: 0, loyaltyPointValue: 0, promotionsStack: false, providerName: 'Moyasar', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '', paymentAdapter: 'moyasar', secret: 'sk_test_fixture' }, token)
    check('Moyasar is configurable without exposing its secret', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.paymentStatus, 'sandbox_only'); assert.ok(!JSON.stringify(r.data).includes('sk_test_fixture')) })
    const order = await create()
    const start = await api('POST', '/payments/terminal', { orderId: order.id, counterCode: 'counter-2' }, token)
    check('MADA checkout creates a secure hosted payment URL', () => { assert.equal(start.status, 201, JSON.stringify(start.data)); assert.match(start.data.checkoutUrl, /^https:\/\/checkout.moyasar.com\//) })
    const intent = await tx.paymentIntent.findUniqueOrThrow({ where: { id: start.data.id } }), invoice = invoices.get(intent.providerRef)
    r = await api('POST', `/payments/callbacks/moyasar?organizationId=${org.id}`, { id: invoice.id, status: 'paid' })
    check('forged callback cannot mark an unpaid provider invoice paid', () => assert.equal(r.data.code, 'PAYMENT_PENDING'))
    assert.ok(!(await board()).some(o => o.id === order.id))
    invoice.status = 'paid'; invoice.payments = [{ id: crypto.randomUUID(), status: 'paid', amount: invoice.amount, currency: 'SAR', source: { company: 'mada' } }]
    r = await api('GET', `/payments/${intent.id}/state`, undefined, token)
    check('provider verification settles MADA payment', () => assert.equal(r.data.status, 'succeeded', JSON.stringify(r.data)))
    const paid = await tx.customerOrder.findUniqueOrThrow({ where: { id: order.id } })
    check('verified MADA tender retains the selected counter', () => { assert.equal(paid.paymentMethod, 'mada'); assert.equal(paid.counterCode, 'counter-2'); assert.equal(paid.status, 'completed') })
    r = await api('POST', `/payments/callbacks/moyasar?organizationId=${org.id}`, { id: invoice.id })
    check('duplicate provider callback settles only once', () => assert.equal(r.data.outcome, 'duplicate'))
    const events = await tx.tillPayment.count({ where: { orderId: order.id } })
    check('duplicate callback does not duplicate till money', () => assert.equal(events, 1))
    r = await api('POST', `/orders/${order.id}/refund`, { reason: 'Customer refund' }, token)
    check('MADA refund returns money through the original provider', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
    const returned = await tx.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
    check('MADA refund is recorded against the original payment', () => { assert.equal(returned.refundStatus, 'refunded'); assert.equal(returned.refundedAmount, 115) })
    for (const scenario of ['stopped', 'wrong_amount']) {
      const waitingOrder = await create()
      const opened = await api('POST', '/payments/terminal', { orderId: waitingOrder.id, counterCode: 'main' }, token)
      assert.equal(opened.status, 201, JSON.stringify(opened.data))
      const row = await tx.paymentIntent.findUniqueOrThrow({ where: { id: opened.data.id } })
      const remote = invoices.get(row.providerRef)
      if (scenario === 'stopped') await api('POST', `/payments/${row.id}/cancel`, {}, token)
      else remote.amount -= 100
      remote.status = 'paid'; remote.payments = [{ id: crypto.randomUUID(), status: 'paid', amount: remote.amount, currency: 'SAR', source: { company: 'mada' } }]
      r = await api('POST', `/payments/callbacks/moyasar?organizationId=${org.id}`, { id: remote.id })
      const reviewed = await tx.paymentIntent.findUniqueOrThrow({ where: { id: row.id } })
      const unchanged = await tx.customerOrder.findUniqueOrThrow({ where: { id: waitingOrder.id } })
      const tickets = await board()
      check(`${scenario}: provider money needs review and cannot release kitchen work`, () => {
        assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(reviewed.status, 'needs_review'); assert.equal(unchanged.status, 'open'); assert.ok(!tickets.some(o => o.id === waitingOrder.id))
      })
    }
  } finally {
    global.fetch = nativeFetch
    if (previousBase === undefined) delete process.env.PAYMENT_CALLBACK_BASE_URL; else process.env.PAYMENT_CALLBACK_BASE_URL = previousBase
  }
}
