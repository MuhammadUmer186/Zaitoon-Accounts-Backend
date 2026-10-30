// Payments and customer-facing checkout: integration status, payment
// intents, signed callbacks (forged, stale, mismatched, repeated), settlement
// of whole bills and checks, refunds through the integration, payments that
// need review, card terminal, table QR split/pay, customer display and kiosk.
// The only integration is the sandbox simulator; no real gateway is called.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
module.exports = async ({ tx, api, signAccessToken, check, base }) => {
  const { signSimulatorEvent } = require('../dist/services/payments/adapters')
  const perm = {}
  for (const [key, module] of [['can_manage_orders', 'orders'], ['can_use_pos', 'pos'], ['can_manage_payments', 'payments'], ['can_manage_checkout_devices', 'settings'], ['can_manage_settings', 'settings']]) perm[key] = await tx.permission.upsert({ where: { key }, create: { key, module }, update: {} })
  const org = await tx.organization.create({ data: { name: 'Payment tests', country: 'PK', currency: 'PKR', timezone: 'Asia/Karachi', requireTillForCash: false } })
  const otherOrg = await tx.organization.create({ data: { name: 'Other payment org', country: 'PK', currency: 'PKR' } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Pay branch', code: 'PAY', vatRate: 16, vatEnabled: true } })
  for (const [key, accountClass, normalBalance] of [['CASH_ON_HAND', 'ASSET', 'DEBIT'], ['CARD_CLEARING', 'ASSET', 'DEBIT'], ['SALES_REVENUE', 'REVENUE', 'CREDIT'], ['OUTPUT_VAT', 'LIABILITY', 'CREDIT'], ['COST_OF_SALES', 'EXPENSE', 'DEBIT'], ['INVENTORY', 'ASSET', 'DEBIT']]) {
    const account = await tx.account.create({ data: { organizationId: org.id, code: `P-${key}`, name: key, accountClass, normalBalance } })
    await tx.accountingMapping.create({ data: { organizationId: org.id, key, accountId: account.id } })
  }
  const staff = async (orgId, name, roleName, keys = []) => {
    const u = await tx.user.create({ data: { organizationId: orgId, email: `${name}-${crypto.randomUUID()}@payments.invalid`, firstName: name, lastName: 'Test', passwordHash: 'unused' } })
    const role = await tx.role.create({ data: { organizationId: orgId, name: roleName, displayName: name } })
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } })
    for (const k of keys) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: perm[k].id } })
    return { ...u, token: signAccessToken(u.id, orgId, u.email) }
  }
  const manager = await staff(org.id, 'Manager', 'super_admin'), cashier = await staff(org.id, 'Cashier', 'pay_cashier', ['can_manage_orders', 'can_use_pos'])
  const outsider = await staff(otherOrg.id, 'Outsider', 'super_admin')
  const shift = await tx.menuShift.create({ data: { organizationId: org.id, name: 'All day', startTime: '00:00', endTime: '00:00' } })
  const cat = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Mains' } })
  const dish = await tx.dish.create({ data: { organizationId: org.id, categoryId: cat.id, name: 'Karahi', price: 116, shifts: { create: { shiftId: shift.id } } } })
  const soldOut = await tx.dish.create({ data: { organizationId: org.id, categoryId: cat.id, name: 'Sold out', price: 50, shifts: { create: { shiftId: shift.id } } } })
  await tx.dishOutOfStock.create({ data: { organizationId: org.id, branchId: branch.id, dishId: soldOut.id, markedBy: manager.id } })
  const table = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Q1', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  const table2 = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Q2', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  const settings = (extra = {}) => ({ loyaltyEarnPerUnit: 0, loyaltyPointValue: 0, promotionsStack: false, providerName: '', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '', paymentAdapter: 'none', ...extra })
  const tableOrder = async (t, quantity = 2) => {
    // a paid table is cleared before the next visit
    await tx.diningTable.update({ where: { id: t.id }, data: { needsClearing: false } })
    const r = await api('POST', '/pos/orders', { branchId: branch.id, tableId: t.id, orderType: 'dine_in', guestCount: 2, items: [{ dishId: dish.id, quantity }] }, manager.token)
    assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data
  }
  const serve = (o) => tx.customerOrderItem.updateMany({ where: { orderId: o.id }, data: { status: 'served' } })
  const callback = async (body, headers) => {
    const raw = JSON.stringify(body)
    const res = await fetch(`${base}/payments/callbacks/simulator`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.77.0.1', ...(headers ?? signSimulatorEvent(org.id, raw)) }, body: raw })
    return { status: res.status, data: await res.json() }
  }
  const simulate = (intent, outcome = 'approve') => api('POST', `/public/payments/${intent.id}/simulate`, { t: intent.accessToken, outcome })
  const intentRow = (id) => tx.paymentIntent.findUniqueOrThrow({ where: { id } })

  // ── nothing is collected without an integration
  let r = await api('GET', '/payments/status', undefined, cashier.token)
  check('without an integration payments are off and say so', () => { assert.equal(r.status, 200); assert.equal(r.data.active, false); assert.equal(r.data.adapter, 'none'); assert.match(r.data.reason, /at the till/) })
  let o = await tableOrder(table); await serve(o)
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, {})
  check('a table cannot pay by QR without an integration', () => assert.equal(r.data.code, 'PAYMENTS_UNAVAILABLE'))
  r = await api('GET', `/public/checkout/tables/${table.orderToken}`)
  check('the guest bill shows that paying here is unavailable', () => { assert.equal(r.status, 200); assert.equal(r.data.payable, false); assert.equal(r.data.paymentsAvailable, false); assert.equal(r.data.order.id, o.id) })

  // ── Settings: the simulator is sandbox only and never reported as live
  r = await api('PUT', '/commerce-settings', settings({ paymentAdapter: 'simulator', paymentEnvironment: 'production' }), manager.token)
  check('the simulator cannot be used in production', () => assert.equal(r.data.code, 'SANDBOX_ONLY'))
  r = await api('PUT', '/commerce-settings', settings({ paymentAdapter: 'stripe-guess' }), manager.token)
  check('an integration that is not built in cannot be selected', () => assert.equal(r.status, 400))
  r = await api('PUT', '/commerce-settings', settings({ paymentAdapter: 'simulator' }), cashier.token)
  check('cashiers cannot change the payment integration', () => assert.equal(r.status, 403))
  r = await api('PUT', '/commerce-settings', settings({ paymentAdapter: 'simulator' }), manager.token)
  check('the sandbox simulator is selected and reported as sandbox only, not live', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.paymentAdapter, 'simulator'); assert.equal(r.data.paymentStatus, 'sandbox_only') })
  r = await api('GET', '/payments/status', undefined, cashier.token)
  check('payment status lists the simulator channels', () => { assert.equal(r.data.active, true); assert.equal(r.data.live, false); assert.deepEqual(r.data.channels, ['qr', 'kiosk', 'terminal']) })

  // ── table QR: pay the whole bill
  const unserved = await tableOrder(table2)
  r = await api('POST', `/public/checkout/tables/${table2.orderToken}/pay`, {})
  check('accepted table order can pay before any food is served', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.amount, unserved.totalAmount) })
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, { amount: 1 })
  const first = r.data
  check('a QR payment is created for the server’s bill total, whatever the phone sends', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(first.amount, o.totalAmount); assert.equal(first.status, 'pending'); assert.ok(first.payPath.startsWith(`/pay/${first.id}?t=`)) })
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, {})
  const again = r.data
  check('a second tap reuses the same payment and keeps its distributed link valid', () => { assert.equal(again.id, first.id); assert.equal(again.accessToken, first.accessToken) })
  r = await api('GET', `/public/payments/${first.id}?t=${first.accessToken}`)
  check('the first payment link still works after a second tap', () => assert.equal(r.status, 200))
  r = await api('GET', `/public/payments/${first.id}?t=${again.accessToken}`)
  check('the payment page shows the merchant, order and amount', () => { assert.equal(r.status, 200); assert.equal(r.data.merchant, 'Payment tests'); assert.equal(r.data.amount, o.totalAmount); assert.equal(r.data.simulator, true); assert.equal(r.data.environment, 'sandbox') })

  // forged, stale and mismatched callbacks never settle
  const row = await intentRow(again.id)
  const event = (extra = {}) => ({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', providerRef: row.providerRef, organizationId: org.id, amount: row.amount, currency: 'PKR', merchantId: '', ...extra })
  r = await callback(event(), { 'x-simulator-timestamp': String(Date.now()), 'x-simulator-signature': crypto.randomBytes(32).toString('hex') })
  check('a callback with a forged signature is refused and logged', () => assert.equal(r.data.code, 'SIGNATURE_INVALID'))
  const stale = event(); const staleRaw = JSON.stringify(stale)
  r = await callback(stale, signSimulatorEvent(org.id, staleRaw, Date.now() - 10 * 60_000))
  check('a replayed old callback is refused', () => assert.equal(r.data.code, 'STALE_CALLBACK'))
  const otherSigned = event(); const otherRaw = JSON.stringify(otherSigned)
  r = await callback(otherSigned, signSimulatorEvent(otherOrg.id, otherRaw))
  check('a callback signed with another merchant’s key is refused', () => assert.equal(r.data.code, 'SIGNATURE_INVALID'))
  const rejected = await tx.paymentEvent.count({ where: { adapter: 'simulator', signatureValid: false } })
  const stillOpen = await tx.customerOrder.findUniqueOrThrow({ where: { id: o.id } })
  check('refused callbacks are all recorded and the bill stays open', () => { assert.ok(rejected >= 3); assert.equal(stillOpen.status, 'open'); })

  r = await simulate(again, 'decline')
  const afterDecline = await tx.customerOrder.findUniqueOrThrow({ where: { id: o.id } })
  check('a declined card leaves the bill open', () => assert.equal(afterDecline.status, 'open'))
  let ir = await intentRow(again.id)
  check('a declined payment is recorded as failed', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(ir.status, 'failed'); assert.match(ir.failureReason, /declined/) })
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, {})
  const retry = r.data
  check('after a decline the guest can try again with a new payment', () => { assert.equal(r.status, 201); assert.notEqual(retry.id, again.id) })
  r = await simulate(retry)
  const paidOrder = await tx.customerOrder.findUniqueOrThrow({ where: { id: o.id } })
  ir = await intentRow(retry.id)
  const sysUser = await tx.user.findFirst({ where: { organizationId: org.id, email: { endsWith: '@system.foodsync.invalid' } } })
  const till = await tx.tillPayment.findMany({ where: { orderId: o.id } })
  check('an approved QR payment closes the bill as a card payment by the online-payments actor', () => {
    assert.equal(ir.status, 'succeeded'); assert.ok(ir.settledAt); assert.equal(paidOrder.status, 'completed'); assert.equal(paidOrder.totalAmount, ir.amount)
    assert.deepEqual(paidOrder.payments, [{ method: 'card', amount: ir.amount }]); assert.ok(sysUser); assert.equal(sysUser.isActive, false)
    assert.equal(till.length, 1); assert.equal(till[0].userId, sysUser.id); assert.equal(till[0].method, 'card')
  })
  const sale = await tx.dailySale.findFirst({ where: { branchId: branch.id, orders: { some: { id: o.id } } } })
  check('the online payment reaches Daily Sales as card', () => { assert.ok(sale); assert.equal(sale.cardAmount, ir.amount) })
  r = await api('GET', '/users', undefined, manager.token)
  check('the online-payments actor is not a staff account', () => assert.ok(!r.data.data.some((u) => u.email.endsWith('@system.foodsync.invalid'))))
  r = await api('GET', `/users/${sysUser.id}`, undefined, manager.token)
  check('the online-payments actor cannot be opened or edited', () => assert.equal(r.status, 404))

  // the same callback delivered again changes nothing
  const settledEvent = await tx.paymentEvent.findFirst({ where: { intentId: retry.id, outcome: 'settled' } })
  const replay = { eventId: settledEvent.providerEventId, type: 'payment.succeeded', providerRef: ir.providerRef, organizationId: org.id, amount: ir.amount, currency: 'PKR', merchantId: '' }
  r = await callback(replay)
  const tillAfter = await tx.tillPayment.count({ where: { orderId: o.id } })
  check('a repeated callback is acknowledged as a duplicate and pays nothing twice', () => { assert.equal(r.status, 200); assert.equal(r.data.outcome, 'duplicate'); assert.equal(tillAfter, 1) })
  const another = { ...replay, eventId: `evt_${crypto.randomUUID()}` }
  r = await callback(another)
  const tillAfterSecond = await tx.tillPayment.count({ where: { orderId: o.id } })
  check('a second success event for a settled payment does not pay again', () => { assert.equal(r.status, 200); assert.equal(tillAfterSecond, 1) })

  // a FoodSync refund returns the money through the integration
  r = await api('POST', `/orders/${o.id}/refund`, { reason: 'Guest complaint' }, manager.token)
  ir = await intentRow(retry.id)
  check('refunding the order refunds the online payment', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'refunded'); assert.equal(ir.refundStatus, 'refunded'); assert.equal(ir.refundedAmount, ir.amount); assert.match(ir.refundRef, /^simr_/) })

  // ── a callback whose amount differs never settles
  const mism = await tableOrder(table); await serve(mism)
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, {})
  const mi = await intentRow(r.data.id)
  r = await callback({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', providerRef: mi.providerRef, organizationId: org.id, amount: mi.amount - 10, currency: 'PKR', merchantId: '' })
  const mrow = await intentRow(mi.id)
  const mOrder = await tx.customerOrder.findUniqueOrThrow({ where: { id: mism.id } })
  check('a different amount from the gateway is held for review and the bill stays open', () => { assert.equal(r.data.outcome, 'mismatch'); assert.equal(mrow.status, 'needs_review'); assert.match(mrow.failureReason, /amount/); assert.equal(mOrder.status, 'open') })
  r = await callback({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', providerRef: mi.providerRef, organizationId: org.id, amount: mi.amount, currency: 'SAR', merchantId: '' })
  check('a different currency from the gateway is refused', () => assert.equal(r.data.outcome, 'mismatch'))

  // ── paid at the till while the guest is paying by QR: needs review, refund
  r = await api('POST', `/orders/${mism.id}/complete`, { paymentMethod: 'cash' }, cashier.token)
  check('the cashier can still take the bill at the till', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
  const raceOrder = await tableOrder(table); await serve(raceOrder)
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, {})
  const raceIntent = r.data
  r = await api('POST', `/orders/${raceOrder.id}/complete`, { paymentMethod: 'cash' }, cashier.token)
  let race = await intentRow(raceIntent.id)
  check('taking payment at the till cancels open QR payments for that bill', () => { assert.equal(r.status, 200); assert.equal(race.status, 'cancelled') })
  r = await simulate(raceIntent)
  check('a cancelled payment page cannot be approved', () => assert.equal(r.data.status, 'cancelled'))
  r = await callback({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', providerRef: race.providerRef, organizationId: org.id, amount: race.amount, currency: 'PKR', merchantId: '' })
  race = await intentRow(raceIntent.id)
  const raceTill = await tx.tillPayment.count({ where: { orderId: raceOrder.id, type: 'sale' } })
  check('money that arrives after the bill was paid is held for review, never applied twice', () => { assert.equal(r.data.outcome, 'needs_review'); assert.equal(race.status, 'needs_review'); assert.equal(raceTill, 1) })
  r = await api('GET', '/payments?status=attention', undefined, cashier.token)
  check('only payment managers see the payments list', () => assert.equal(r.status, 403))
  r = await api('GET', '/payments?status=attention', undefined, manager.token)
  check('payments needing attention are listed with their order and history', () => { assert.equal(r.status, 200); const p = r.data.data.find((x) => x.id === raceIntent.id); assert.ok(p); assert.equal(p.orderNo, raceOrder.orderNo); assert.ok(p.events.length >= 1); assert.equal(p.accessTokenHash, undefined) })
  r = await api('POST', `/payments/${raceIntent.id}/refund`, {}, manager.token)
  race = await intentRow(raceIntent.id)
  check('a payment that could not be applied is refunded and closed', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(race.refundStatus, 'refunded'); assert.equal(race.status, 'cancelled') })
  r = await api('POST', `/payments/${raceIntent.id}/refund`, {}, manager.token)
  check('it cannot be refunded twice', () => assert.equal(r.status, 409))
  const refundAudit = await tx.auditLog.count({ where: { action: 'refund_online_payment', resourceId: raceIntent.id } })
  check('the refund is audited', () => assert.equal(refundAudit, 1))

  // ── guests split the bill and pay their own check
  const group = await tableOrder(table, 3); await serve(group)
  r = await api('GET', `/public/checkout/tables/${table.orderToken}`)
  check('a served bill can be split from the table', () => { assert.equal(r.data.canSplit, true); assert.equal(r.data.payable, true) })
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/split`, { mode: 'equal', count: 3 })
  const checks = r.data.checks
  check('guests split equally into checks that add up to the bill', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(checks.length, 3); assert.equal(Math.round(checks.reduce((n, c) => n + c.totalAmount, 0) * 100) / 100, group.totalAmount) })
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/split`, { mode: 'equal', count: 2 })
  check('a split bill cannot be split again from the table', () => assert.equal(r.data.code, 'CHECKS_EXIST'))
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, {})
  check('a split bill is paid one check at a time', () => assert.equal(r.data.code, 'CHECKS_EXIST'))
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, { checkId: checks[0].id })
  const c1 = r.data
  check('one guest pays exactly their check', () => { assert.equal(r.status, 201); assert.equal(c1.amount, checks[0].totalAmount); assert.equal(c1.checkId, checks[0].id) })
  r = await simulate(c1)
  let g = await tx.customerOrder.findUniqueOrThrow({ where: { id: group.id }, include: { checks: true } })
  check('their check is paid and the bill stays open for the others', () => { assert.equal(g.status, 'open'); assert.equal(g.checks.find((c) => c.id === checks[0].id).status, 'paid') })
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, { checkId: checks[0].id })
  check('a paid check cannot be paid again', () => assert.equal(r.data.code, 'CHECK_ALREADY_PAID'))
  r = await api('POST', `/orders/${group.id}/checks/${checks[1].id}/pay`, { payments: [{ method: 'cash', amount: checks[1].totalAmount }] }, manager.token)
  check('another check can be paid in cash at the till', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
  r = await api('POST', `/public/checkout/tables/${table.orderToken}/pay`, { checkId: checks[2].id })
  r = await simulate(r.data)
  g = await tx.customerOrder.findUniqueOrThrow({ where: { id: group.id }, include: { checks: true } })
  check('the last check paid by QR completes the order', () => { assert.equal(g.status, 'completed'); assert.ok(g.checks.every((c) => c.status === 'paid')) })
  r = await api('POST', `/orders/${group.id}/refund`, { reason: 'Refund all checks' }, manager.token)
  const groupIntents = await tx.paymentIntent.findMany({ where: { orderId: group.id, status: 'succeeded' } })
  check('refunding a split bill refunds each check paid online', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(groupIntents.length, 2); assert.ok(groupIntents.every((i) => i.refundStatus === 'refunded')) })

  // ── card terminal from the POS
  const take = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, cashier.token)
  r = await api('POST', '/payments/terminal', { orderId: take.data.id }, cashier.token)
  const term = r.data
  check('the cashier sends the bill to the card terminal', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(term.channel, 'terminal'); assert.equal(term.amount, take.data.totalAmount) })
  r = await api('GET', `/payments/${term.id}/state`, undefined, outsider.token)
  check('another organization cannot see the terminal payment', () => assert.equal(r.status, 404))
  r = await api('GET', `/payments/${term.id}/state`, undefined, cashier.token)
  check('the till waits for the terminal', () => assert.equal(r.data.status, 'pending'))
  r = await simulate(term)
  r = await api('GET', `/payments/${term.id}/state`, undefined, cashier.token)
  const takeAfter = await tx.customerOrder.findUniqueOrThrow({ where: { id: take.data.id } })
  check('an approved terminal payment completes the order', () => { assert.equal(r.data.status, 'succeeded'); assert.equal(takeAfter.status, 'completed') })
  r = await api('POST', `/payments/${term.id}/cancel`, {}, cashier.token)
  check('a payment the gateway answered cannot be cancelled', () => assert.equal(r.status, 409))
  const take2 = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, cashier.token)
  r = await api('POST', '/payments/terminal', { orderId: take2.data.id }, cashier.token)
  const term2 = r.data
  r = await api('POST', `/payments/${term2.id}/cancel`, {}, cashier.token)
  check('the cashier can stop waiting for the terminal', () => assert.equal(r.data.status, 'cancelled'))

  // ── customer display
  r = await api('POST', '/checkout-devices', { branchId: branch.id, kind: 'customer_display', name: 'Till 1 display' }, cashier.token)
  check('only device managers pair displays and kiosks', () => assert.equal(r.status, 403))
  r = await api('POST', '/checkout-devices', { branchId: branch.id, kind: 'customer_display', name: 'Till 1 display' }, manager.token)
  const display = r.data
  check('a paired display gets a one-time link', () => { assert.equal(r.status, 201); assert.ok(display.token.length >= 30); assert.equal(display.path, `/display/${display.token}`) })
  const stored = await tx.checkoutDevice.findUniqueOrThrow({ where: { id: display.id } })
  check('only a hash of the device link is stored', () => { assert.notEqual(stored.tokenHash, display.token); assert.equal(stored.tokenHash.length, 64) })
  r = await api('GET', '/checkout-devices', undefined, cashier.token)
  check('the device list never shows links', () => { assert.equal(r.status, 200); assert.ok(r.data.data.every((d) => d.token === undefined && d.tokenHash === undefined)) })
  r = await api('GET', `/public/checkout/display/${display.token}`)
  check('an idle display shows the restaurant only', () => { assert.equal(r.status, 200); assert.equal(r.data.order, null); assert.equal(r.data.restaurant.name, 'Payment tests') })
  const shown = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 2 }] }, cashier.token)
  r = await api('PUT', `/checkout-devices/${display.id}/show`, { orderId: shown.data.id }, cashier.token)
  r = await api('GET', `/public/checkout/display/${display.token}`)
  check('the display shows the cashier’s current bill', () => { assert.equal(r.data.order.orderNo, shown.data.orderNo); assert.equal(r.data.order.totalAmount, shown.data.totalAmount); assert.equal(r.data.order.lines[0].quantity, 2) })
  const foreignOrg = await tx.branch.create({ data: { organizationId: otherOrg.id, name: 'Foreign', code: 'FPAY' } })
  const foreignOrder = await tx.customerOrder.create({ data: { organizationId: otherOrg.id, branchId: foreignOrg.id, orderNo: 990001, orderType: 'takeaway', source: 'pos' } })
  r = await api('PUT', `/checkout-devices/${display.id}/show`, { orderId: foreignOrder.id }, cashier.token)
  check('a display cannot show another organization’s order', () => assert.equal(r.status, 404))
  r = await api('PUT', `/checkout-devices/${display.id}/show`, { orderId: shown.data.id }, outsider.token)
  check('another organization cannot drive this display', () => assert.equal(r.status, 404))
  r = await api('DELETE', `/checkout-devices/${display.id}`, undefined, manager.token)
  r = await api('GET', `/public/checkout/display/${display.token}`)
  check('a revoked display stops at once', () => assert.equal(r.status, 404))

  // ── self-service kiosk
  r = await api('POST', '/checkout-devices', { branchId: branch.id, kind: 'kiosk', name: 'Entrance kiosk' }, manager.token)
  const kiosk = r.data
  r = await api('GET', `/public/checkout/kiosk/${kiosk.token}/menu`)
  check('the kiosk shows the branch menu without sold-out dishes', () => { assert.equal(r.status, 200); const names = r.data.categories.flatMap((c) => c.dishes.map((d) => d.name)); assert.ok(names.includes('Karahi')); assert.ok(!names.includes('Sold out')); assert.equal(r.data.payOnline, true) })
  r = await api('GET', `/public/checkout/display/${kiosk.token}`)
  check('a kiosk link does not open the customer display', () => assert.equal(r.status, 404))
  r = await api('POST', `/public/checkout/kiosk/${kiosk.token}/orders`, { requestId: crypto.randomUUID(), customerName: 'Sara', payment: 'counter', items: [{ dishId: soldOut.id, quantity: 1 }] })
  check('a sold-out dish is refused at the kiosk', () => assert.equal(r.data.code, 'DISH_UNAVAILABLE'))
  r = await api('POST', `/public/checkout/kiosk/${kiosk.token}/orders`, { requestId: crypto.randomUUID(), customerName: 'Sara', payment: 'counter', items: [{ dishId: dish.id, quantity: 1, unitPrice: 1 }] })
  const counter = r.data.order
  r = await api('GET', `/orders/online/pending?branchId=${branch.id}`, undefined, cashier.token)
  check('a pay-at-counter kiosk order waits for staff like an online order, priced by the server', () => { assert.equal(counter.status, 'pending'); assert.equal(counter.payment, 'counter'); assert.equal(counter.totalAmount, 116); assert.ok(r.data.data.some((x) => x.id === counter.id)) })
  const requestId = crypto.randomUUID()
  r = await api('POST', `/public/checkout/kiosk/${kiosk.token}/orders`, { requestId, customerName: 'Omar', payment: 'online', items: [{ dishId: dish.id, quantity: 2 }] })
  const online = r.data
  check('a kiosk card order gets a payment link and is not in the kitchen yet', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(online.order.payment, 'online'); assert.ok(online.pay.payPath.startsWith('/pay/')) })
  r = await api('POST', `/public/checkout/kiosk/${kiosk.token}/orders`, { requestId, customerName: 'Omar', payment: 'online', items: [{ dishId: dish.id, quantity: 2 }] })
  check('a repeated tap returns the same kiosk order and payment', () => { assert.equal(r.status, 200); assert.equal(r.data.order.id, online.order.id); assert.equal(r.data.pay.intentId, online.pay.intentId) })
  const tokenOf = (pay) => ({ id: pay.intentId, accessToken: new URL('http://x' + pay.payPath).searchParams.get('t') })
  const oldLink = await simulate(tokenOf(online.pay))
  check('the first kiosk payment link remains usable after a repeated tap', () => assert.equal(oldLink.status, 200))
  r = await simulate(tokenOf(r.data.pay))
  r = await api('GET', `/public/checkout/kiosk/${kiosk.token}/orders/${online.order.id}`)
  const kitchen = await tx.customerOrder.findUniqueOrThrow({ where: { id: online.order.id }, include: { items: true } })
  check('once paid the kiosk order goes to the kitchen and shows as paid', () => { assert.equal(r.data.order.payment, 'paid'); assert.equal(kitchen.status, 'completed'); assert.ok(kitchen.acceptedAt); assert.ok(kitchen.items.every((i) => i.status === 'pending')) })
  const decl = await api('POST', `/public/checkout/kiosk/${kiosk.token}/orders`, { requestId: crypto.randomUUID(), customerName: 'Ali', payment: 'online', items: [{ dishId: dish.id, quantity: 1 }] })
  await simulate({ id: decl.data.pay.intentId, accessToken: new URL('http://x' + decl.data.pay.payPath).searchParams.get('t') }, 'decline')
  r = await api('POST', `/public/checkout/kiosk/${kiosk.token}/orders/${decl.data.order.id}/counter`, {})
  check('after a declined card the guest can pay at the counter instead', () => { assert.equal(r.status, 200); assert.equal(r.data.order.payment, 'counter') })
  await api('DELETE', `/checkout-devices/${kiosk.id}`, undefined, manager.token)
  r = await api('GET', `/public/checkout/kiosk/${kiosk.token}/menu`)
  check('a revoked kiosk stops at once', () => assert.equal(r.status, 404))
  r = await callback({ eventId: 'x', type: 'payment.succeeded' }, {})
  check('a callback without a signature is refused', () => assert.equal(r.data.code, 'SIGNATURE_MISSING'))
  const res = await fetch(`${base}/payments/callbacks/unknown-gateway`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  check('callbacks for integrations that do not exist are refused', () => assert.equal(res.status, 404))
  void unserved
  await api('PUT', '/commerce-settings', settings(), manager.token)
}
