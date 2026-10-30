const assert = require('node:assert/strict')

module.exports = async ({ tx, api, signAccessToken, check }) => {
  const org = await tx.organization.create({ data: { name: 'Till tests', requireTillForCash: true } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Till Main', code: 'TILL', vatRate: 16 } })
  const other = await tx.branch.create({ data: { organizationId: org.id, name: 'Other till branch', code: 'TILL2' } })
  const makeUser = async (name, admin) => {
    const u = await tx.user.create({ data: { organizationId: org.id, email: `${name}@tills.invalid`, firstName: name, lastName: 'Test', passwordHash: 'unused' } })
    const role = await tx.role.create({ data: { organizationId: org.id, name: admin ? 'super_admin' : `till_${name}`, displayName: name } })
    if (!admin) for (const key of ['can_use_pos', 'can_manage_orders', 'can_create_cash_closing']) {
      const p = await tx.permission.findUniqueOrThrow({ where: { key } })
      await tx.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } })
    }
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } })
    await tx.userBranchAccess.create({ data: { organizationId: org.id, branchId: branch.id, userId: u.id } })
    return { ...u, token: signAccessToken(u.id, org.id, u.email) }
  }
  const manager = await makeUser('manager', true), cashier = await makeUser('cashier', false), second = await makeUser('second', false)
  const category = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Till food' } })
  const dish = await tx.dish.create({ data: { organizationId: org.id, categoryId: category.id, name: 'Meal', price: 116 } })
  const pos = async () => {
    const r = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, cashier.token)
    assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data
  }
  const order = await pos()
  let r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'cash' }, cashier.token)
  check('with the till rule on, cash is blocked without an open till', () => { assert.equal(r.status, 409); assert.equal(r.data.code, 'TILL_REQUIRED') })
  r = await api('POST', '/pos/tills', { branchId: other.id, openingFloat: 500 }, cashier.token)
  check('a cashier cannot open a till outside their branch', () => assert.equal(r.status, 403))
  r = await api('POST', '/pos/tills', { branchId: branch.id, openingFloat: 500, deviceName: 'Counter 1' }, cashier.token)
  const session = r.data
  check('opening a till returns a blind session', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(session.expectedCash, undefined); assert.equal(session.countedCash, undefined) })
  r = await api('POST', '/pos/tills', { branchId: branch.id, openingFloat: 0 }, cashier.token)
  check('a cashier cannot open two concurrent sessions at one branch', () => assert.equal(r.status, 409))
  r = await api('GET', `/pos/tills/${session.id}/report`, undefined, cashier.token)
  check('expected cash cannot be read before the blind count by cashier', () => assert.equal(r.status, 403))
  r = await api('POST', `/orders/${order.id}/complete`, { payments: [{ method: 'cash', amount: 50 }, { method: 'card', amount: 66 }], amountTendered: 100 }, cashier.token)
  check('split cash/card payment links to the till and excludes change', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.tillSessionId, session.id); assert.equal(r.data.changeAmount, 50) })
  for (const [type, amount] of [['pay_in', 20], ['pay_out', 10], ['drop', 30]]) {
    r = await api('POST', `/pos/tills/${session.id}/movements`, { type, amount, reason: 'Manager cash movement' }, manager.token)
    check(`manager can record ${type}`, () => assert.equal(r.status, 201, JSON.stringify(r.data)))
  }
  r = await api('GET', `/pos/tills/${session.id}/report`, undefined, manager.token)
  check('X report reconciles float, split cash and drawer movements', () => assert.equal(r.data.report.kpis[0].value, 530))
  r = await api('POST', `/pos/tills/${session.id}/close`, { countedCash: 525 }, second.token)
  check('another cashier cannot close this session', () => assert.equal(r.status, 403))
  r = await api('POST', `/pos/tills/${session.id}/close`, { countedCash: 525 }, cashier.token)
  const closed = r.data
  check('blind close reveals expected cash and records the shortage', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(closed.expectedCash, 530); assert.equal(closed.difference, -5); assert.equal(closed.zReport.number, 1) })
  r = await api('POST', `/pos/tills/${session.id}/close`, { countedCash: 999 }, cashier.token)
  check('a Z close cannot be replaced by a recount', () => assert.equal(r.status, 409))
  r = await api('POST', `/pos/tills/${session.id}/movements`, { type: 'drop', amount: 1, reason: 'Late drop' }, manager.token)
  check('a closed till cannot receive movements', () => assert.equal(r.status, 409))
  r = await api('POST', '/pos/tills', { branchId: branch.id, openingFloat: 100 }, cashier.token)
  const later = r.data
  // PIN setup is organization-scoped, unique, hashed and absent from responses.
  r = await api('PUT', `/pos/users/${manager.id}/pin`, { pin: '246810' }, manager.token)
  check('a manager PIN can be configured', () => assert.equal(r.status, 200))
  const saved = await tx.user.findUniqueOrThrow({ where: { id: manager.id } })
  check('PIN is stored as bcrypt and never clear text', () => { assert.ok(saved.posPin.startsWith('$2')); assert.notEqual(saved.posPin, '246810') })
  r = await api('PUT', `/pos/users/${cashier.id}/pin`, { pin: '123456' }, manager.token)
  r = await api('PUT', `/pos/users/${second.id}/pin`, { pin: '123456' }, manager.token)
  check('shared-terminal PINs are unique within the organization', () => assert.equal(r.status, 409))
  const approval = async (action, resourceId) => {
    const result = await api('POST', '/pos/authorize', { branchId: branch.id, pin: '246810', action, resourceId }, cashier.token, '10.31.0.2')
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.approvalToken
  }
  let token = await approval('refund', order.id)
  r = await api('POST', `/orders/${order.id}/refund`, { reason: 'Guest returned meal', approvalToken: token }, cashier.token)
  check('manager PIN authorizes a cash refund into the current till', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
  const refund = await tx.tillPayment.findFirst({ where: { orderId: order.id, type: 'refund', method: 'cash' } })
  check('refund cash is deducted from the new session rather than the closed one', () => { assert.equal(refund.sessionId, later.id); assert.equal(refund.amount, 50) })
  const snapshot = await tx.zReport.findUniqueOrThrow({ where: { sessionId: session.id } })
  check('later refunds leave the original Z report immutable', () => assert.deepEqual(snapshot.report, closed.zReport.report))
  const discounted = await pos()
  token = await approval('discount', discounted.id)
  r = await api('POST', `/orders/${discounted.id}/complete`, { discountAmount: 58, discountReason: 'Service recovery', approvalToken: token }, cashier.token)
  check('PIN override permits a discount above cashier limit', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.totalAmount, 58) })
  const audit = await tx.auditLog.findFirst({ where: { resourceId: discounted.id, action: 'complete' } })
  check('discount audit identifies the approver without recording the PIN or token', () => { assert.equal(audit.newData.approvedBy, manager.id); assert.ok(!JSON.stringify(audit.newData).includes('246810')); assert.equal(audit.newData.approvalToken, undefined) })
  const unpaid = await pos()
  r = await api('POST', `/orders/${unpaid.id}/complete`, { discountAmount: 58, discountReason: 'Replay attempt', approvalToken: token }, cashier.token)
  check('approval is not reusable or transferable to another order', () => assert.equal(r.status, 403))
  token = await approval('void', unpaid.id)
  r = await api('POST', `/orders/${unpaid.id}/cancel`, { reason: 'Wrong cashier', approvalToken: token }, second.token)
  check('manager approval is bound to the requesting cashier', () => assert.equal(r.status, 403))
  r = await api('POST', `/orders/${unpaid.id}/complete`, { discountAmount: 58, discountReason: 'Wrong action', approvalToken: token }, cashier.token)
  check('void approval cannot authorize a discount', () => assert.equal(r.status, 403))
  const reasons = (await api('GET', '/pos/void-reasons', undefined, cashier.token)).data.data
  r = await api('POST', `/orders/${unpaid.id}/cancel`, { voidReasonId: reasons.find((v) => v.name === 'Wrong item').id, approvalToken: token }, cashier.token)
  check('voids save a configured reason and manager approval', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.cancelReason, 'Wrong item') })
  const expiredOrder = await pos()
  const expiredToken = await approval('void', expiredOrder.id)
  await tx.posApproval.updateMany({ where: { resourceId: expiredOrder.id }, data: { expiresAt: new Date(Date.now() - 1000) } })
  r = await api('POST', `/orders/${expiredOrder.id}/cancel`, { reason: 'Expired manager approval', approvalToken: expiredToken }, cashier.token)
  check('expired approvals cannot authorize a later action', () => assert.equal(r.status, 403))
  r = await api('POST', `/pos/tills/${later.id}/close`, { countedCash: 108 }, cashier.token)
  check('cash refunds, discount receipts and sequential Z numbers reconcile', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.expectedCash, 108); assert.equal(r.data.zReport.number, 2); assert.equal(r.data.difference, 0) })
  r = await api('GET', `/pos/tills/${session.id}/report`, undefined, cashier.token)
  check('closed Z reports can be read by their cashier', () => { assert.equal(r.status, 200); assert.equal(r.data.zNumber, 1) })
  r = await api('POST', '/auth/pin-login', { branchId: branch.id, pin: '123456' }, false, '10.31.0.3')
  const login = r.data
  check('PIN sign-in returns a POS-only token without PIN material', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(login.tokens.accessToken); assert.equal(login.tokens.refreshToken, ''); assert.equal(login.user.posPin, undefined); assert.equal(login.user.posPinLookup, undefined) })
  r = await api('GET', '/accounting/trial-balance', undefined, login.tokens.accessToken)
  check('a PIN token cannot access accounting', () => { assert.equal(r.status, 403); assert.equal(r.data.code, 'POS_SCOPE') })
  r = await api('GET', `/pos/menu?branchId=${other.id}`, undefined, login.tokens.accessToken)
  check('a PIN session is bound to its terminal branch', () => assert.equal(r.status, 403))
  r = await api('GET', '/auth/me', undefined, login.tokens.accessToken)
  check('PIN identity refresh preserves restricted navigation and branch', () => { assert.equal(r.status, 200); assert.deepEqual(r.data.permissionMatrix.branchIds, [branch.id]); assert.ok(!r.data.permissionMatrix.moduleAccess.includes('settings')); assert.equal(r.data.branches.length, 1) })
  for (let i = 0; i < 6; i++) r = await api('POST', '/auth/pin-login', { branchId: branch.id, pin: '000000' }, false, '10.31.0.99')
  check('wrong PIN attempts are rate limited', () => assert.equal(r.status, 429))
  // ── void reasons are managed per organization
  r = await api('GET', '/pos/void-reasons/all', undefined, cashier.token)
  check('only till managers see the reason settings', () => assert.equal(r.status, 403))
  const all = (await api('GET', '/pos/void-reasons/all', undefined, manager.token)).data.data
  const quality = all.find((v) => v.name === 'Quality issue'), otherReason = all.find((v) => v.name === 'Other')
  r = await api('PUT', `/pos/void-reasons/${quality.id}`, { isActive: false }, manager.token)
  const offered = (await api('GET', '/pos/void-reasons', undefined, cashier.token)).data.data
  check('a retired reason is no longer offered and is not re-created', () => { assert.equal(r.status, 200); assert.ok(!offered.some((v) => v.name === 'Quality issue')) })
  r = await api('PUT', `/pos/void-reasons/${otherReason.id}`, { isActive: false }, manager.token)
  check('"Other" cannot be retired', () => assert.equal(r.status, 400))
  r = await api('POST', '/pos/void-reasons', { name: 'Overcooked' }, manager.token)
  check('a manager adds a reason', () => assert.equal(r.status, 201))

  // ── the till rule can be switched off
  await tx.organization.update({ where: { id: org.id }, data: { requireTillForCash: false } })
  const noTill = await pos()
  r = await api('POST', `/orders/${noTill.id}/complete`, { paymentMethod: 'cash' }, second.token)
  const recorded = await tx.tillPayment.findFirst({ where: { orderId: noTill.id } })
  check('with the till rule off, cash is taken and still recorded', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(recorded); assert.equal(recorded.sessionId, null) })
  const secondTill = (await api('POST', '/pos/tills', { branchId: branch.id, openingFloat: 0 }, second.token)).data
  r = await api('POST', `/pos/tills/${secondTill.id}/drawer`, { reason: 'Need change' }, second.token)
  check('opening the drawer needs drawer permission or a manager PIN', () => { assert.equal(r.status, 403); assert.equal(r.data.code, 'APPROVAL_REQUIRED') })

  await tx.branch.updateMany({ where: { organizationId: org.id }, data: { isActive: false } })
}
