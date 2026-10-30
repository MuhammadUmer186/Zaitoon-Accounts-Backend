// Phase 6 promotions: server-side pricing, stacking, conditions, coupons,
// the manual-discount rule from Settings and every place totals are used.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
module.exports = async ({ tx, api, signAccessToken, check }) => {
  const perm = {}
  for (const [key, module] of [['can_manage_orders', 'orders'], ['can_use_pos', 'pos'], ['can_manage_menu', 'menu']]) perm[key] = await tx.permission.upsert({ where: { key }, create: { key, module }, update: {} })
  const org = await tx.organization.create({ data: { name: 'Promotion tests', country: 'PK', timezone: 'Asia/Karachi', requireTillForCash: false, maxStaffDiscountPct: 5 } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Promo branch', code: 'PRM', vatRate: 16, vatEnabled: true } })
  const other = await tx.branch.create({ data: { organizationId: org.id, name: 'Other promo branch', code: 'PRM2', vatRate: 16, vatEnabled: true } })
  const staff = async (name, roleName, keys = []) => {
    const u = await tx.user.create({ data: { organizationId: org.id, email: `${name}-${crypto.randomUUID()}@promo.invalid`, firstName: name, lastName: 'Test', passwordHash: 'unused' } })
    const role = await tx.role.create({ data: { organizationId: org.id, name: roleName, displayName: name } })
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } })
    for (const k of keys) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: perm[k].id } })
    return { ...u, token: signAccessToken(u.id, org.id, u.email) }
  }
  const manager = await staff('Manager', 'super_admin'), cashier = await staff('Cashier', 'promo_cashier', ['can_manage_orders', 'can_use_pos'])
  const mains = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Mains' } })
  const sides = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Sides' } })
  const drinks = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Drinks' } })
  const dish = (name, categoryId, price) => tx.dish.create({ data: { organizationId: org.id, categoryId, name, price } })
  const burger = await dish('Burger', mains.id, 100), fries = await dish('Fries', sides.id, 50), cola = await dish('Cola', drinks.id, 30)
  const promo = async (body) => { const r = await api('POST', '/promotions', { name: 'Promo', ...body }, manager.token); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data }
  const off = (p) => api('PUT', `/promotions/${p.id}`, { ...strip(p), isActive: false }, manager.token)
  const strip = (p) => { const { id, organizationId, createdAt, updatedAt, ...rest } = p; return { ...rest, startsAt: rest.startsAt, endsAt: rest.endsAt } }
  const order = async (items, extra = {}, branchId = branch.id) => {
    const r = await api('POST', '/pos/orders', { branchId, orderType: 'takeaway', items: items.map(([d, q]) => ({ dishId: d.id, quantity: q })), ...extra }, manager.token)
    assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data
  }

  let r = await api('POST', '/promotions', { name: 'X', type: 'percent', value: 10 }, cashier.token)
  check('only menu managers set up promotions', () => assert.equal(r.status, 403))
  r = await api('POST', '/promotions', { name: 'Bad', type: 'percent', value: 150 }, manager.token)
  check('a percentage promotion above 100% is refused', () => assert.equal(r.status, 400))

  // ── percent on a category; best single vs stacking
  const sidesPct = await promo({ name: '10% off sides', type: 'percent', value: 10, scope: 'categories', categoryIds: [sides.id] })
  let o = await order([[burger, 1], [fries, 1]])
  check('a category promotion is priced by the server', () => { assert.equal(o.promotionAmount, 5); assert.equal(o.totalAmount, 145); assert.equal(o.promotions[0].name, '10% off sides') })
  const bigSpend = await promo({ name: '20 off over 120', type: 'fixed', value: 20, minimumSpend: 120 })
  o = await order([[burger, 1], [fries, 1]])
  check('without stacking the single best promotion applies', () => { assert.equal(o.promotionAmount, 20); assert.equal(o.promotions.length, 1); assert.equal(o.promotions[0].name, '20 off over 120') })
  o = await order([[burger, 1]])
  check('a minimum spend is respected', () => assert.equal(o.promotionAmount, 0))
  await api('PUT', `/promotions/${sidesPct.id}`, { ...strip(sidesPct), stackable: true }, manager.token)
  await api('PUT', `/promotions/${bigSpend.id}`, { ...strip(bigSpend), stackable: true }, manager.token)
  o = await order([[burger, 1], [fries, 1]])
  check('stackable promotions add up', () => { assert.equal(o.promotionAmount, 25); assert.equal(o.totalAmount, 125); assert.equal(o.promotions.length, 2) })
  await off({ ...sidesPct, stackable: true }); await off({ ...bigSpend, stackable: true })

  // ── buy x get y, free item, special price
  const colaDeal = await promo({ name: 'Cola 2+1', type: 'buy_x_get_y', scope: 'dishes', dishIds: [cola.id], buyQuantity: 2, getQuantity: 1 })
  o = await order([[cola, 3]])
  check('buy two get one free takes off one unit', () => { assert.equal(o.promotionAmount, 30); assert.equal(o.totalAmount, 60) })
  o = await order([[cola, 2]])
  check('buy-x-get-y needs the full group', () => assert.equal(o.promotionAmount, 0))
  await off(colaDeal)
  const freeFries = await promo({ name: 'Free fries over 200', type: 'free_item_over', freeDishId: fries.id, minimumSpend: 200 })
  o = await order([[burger, 2], [fries, 1]])
  check('a free dish is given once the spend is reached', () => assert.equal(o.promotionAmount, 50))
  await off(freeFries)
  const special = await promo({ name: 'Burger at 80', type: 'price_override', value: 80, scope: 'dishes', dishIds: [burger.id] })
  o = await order([[burger, 2]])
  check('a special price applies per unit', () => assert.equal(o.promotionAmount, 40))
  await off(special)

  // ── conditions: branch, weekday, customer tag
  const todayLocal = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', weekday: 'short' }).format(new Date()))
  const tomorrowOnly = await promo({ name: 'Tomorrow only', type: 'percent', value: 50, daysOfWeek: [(todayLocal + 1) % 7] })
  o = await order([[burger, 1]])
  check('a promotion for another weekday does not apply', () => assert.equal(o.promotionAmount, 0))
  await off(tomorrowOnly)
  const otherBranch = await promo({ name: 'Other branch only', type: 'percent', value: 50, branchIds: [other.id] })
  o = await order([[burger, 1]])
  check('a promotion limited to another branch does not apply', () => assert.equal(o.promotionAmount, 0))
  await off(otherBranch)
  const vip = await promo({ name: 'VIP 15%', type: 'percent', value: 15, customerTags: ['VIP'] })
  o = await order([[burger, 1]], { customerPhone: '03001112233', customerName: 'Guest' })
  check('a customer-tag promotion needs the tag', () => assert.equal(o.promotionAmount, 0))
  await tx.customer.update({ where: { id: o.customerId }, data: { tags: ['vip'] } })
  o = await order([[burger, 1]], { customerPhone: '03001112233', customerName: 'Guest' })
  check('a tagged customer gets their promotion', () => assert.equal(o.promotionAmount, 15))
  // attaching the customer at payment re-prices the bill before it is charged
  const tagged = o.customerId
  // on the second branch, so this paid bill stays out of the Daily Sales checks below
  let walkIn = await order([[burger, 1]], {}, other.id)
  check('a walk-in bill has no customer promotion', () => assert.equal(walkIn.promotionAmount, 0))
  r = await api('PUT', `/orders/${walkIn.id}/customer`, { customerId: tagged }, cashier.token)
  check('attaching a tagged customer applies their promotion and shows who it is', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.customerId, tagged); assert.equal(r.data.customer.phone.endsWith('3001112233'), true); assert.equal(r.data.promotionAmount, 15); assert.equal(r.data.totalAmount, 85) })
  r = await api('PUT', `/orders/${walkIn.id}/customer`, { customerId: null }, cashier.token)
  check('detaching the customer removes their promotion', () => { assert.equal(r.status, 200); assert.equal(r.data.customerId, null); assert.equal(r.data.promotionAmount, 0); assert.equal(r.data.totalAmount, 100) })
  const foreignOrg = await tx.organization.create({ data: { name: 'Other promo org', country: 'PK' } })
  const foreign = await tx.customer.create({ data: { organizationId: foreignOrg.id, phone: '+923009998877', name: 'Elsewhere' } })
  r = await api('PUT', `/orders/${walkIn.id}/customer`, { customerId: foreign.id }, cashier.token)
  check('a customer of another organization cannot be attached', () => assert.equal(r.status, 404))
  const audits = await tx.auditLog.count({ where: { resourceId: walkIn.id, action: { in: ['attach_customer', 'detach_customer'] } } })
  check('customer changes on a bill are audited', () => assert.equal(audits, 2))
  r = await api('POST', `/orders/${walkIn.id}/complete`, { paymentMethod: 'cash' }, cashier.token)
  r = await api('PUT', `/orders/${walkIn.id}/customer`, { customerId: tagged }, cashier.token)
  check('a paid bill cannot change customer', () => assert.equal(r.data.code, 'INVALID_STATUS'))
  await off(vip)

  // ── coupons
  const welcome = await promo({ name: 'Welcome coupon', type: 'percent', value: 10, couponCode: 'welcome10' })
  o = await order([[burger, 1], [fries, 1]])
  check('a coupon promotion needs its code', () => assert.equal(o.promotionAmount, 0))
  r = await api('POST', `/orders/${o.id}/coupon`, { code: 'NOPE' }, cashier.token)
  check('an unknown coupon is refused', () => assert.equal(r.data.code, 'COUPON_NOT_FOUND'))
  r = await api('POST', `/orders/${o.id}/coupon`, { code: 'Welcome10' }, cashier.token)
  check('a coupon is applied by code, any case', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.couponCode, 'WELCOME10'); assert.equal(r.data.promotionAmount, 15); assert.equal(r.data.totalAmount, 135) })
  r = await api('DELETE', `/orders/${o.id}/coupon`, undefined, cashier.token)
  check('a coupon can be taken off an open bill', () => { assert.equal(r.data.couponCode, null); assert.equal(r.data.totalAmount, 150) })
  const minCoupon = await promo({ name: 'Big order coupon', type: 'fixed', value: 30, couponCode: 'BIG30', minimumSpend: 500 })
  r = await api('POST', `/orders/${o.id}/coupon`, { code: 'BIG30' }, cashier.token)
  const unchanged = await tx.customerOrder.findUniqueOrThrow({ where: { id: o.id } })
  check('a coupon that does not apply is refused and changes nothing', () => { assert.equal(r.data.code, 'COUPON_NOT_APPLICABLE'); assert.equal(unchanged.couponCode, null); assert.equal(unchanged.totalAmount, 150) })
  r = await api('POST', '/promotions', { name: 'Clash', type: 'percent', value: 5, couponCode: 'BIG30' }, manager.token)
  check('coupon codes are unique', () => assert.equal(r.status, 409))
  await off(minCoupon)

  // ── checkout: manual discount rule, staff limit, Daily Sales
  await api('POST', `/orders/${o.id}/coupon`, { code: 'WELCOME10' }, cashier.token)
  r = await api('POST', `/orders/${o.id}/complete`, { paymentMethod: 'card', discountAmount: 5, discountReason: 'Regular guest' }, cashier.token)
  check('without permission in Settings a manual discount cannot be added to a promotion', () => assert.equal(r.data.code, 'PROMOTION_DISCOUNT_CONFLICT'))
  await api('PUT', '/commerce-settings', { loyaltyEarnPerUnit: 0, loyaltyPointValue: 0, promotionsStack: true, providerName: '', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '' }, manager.token)
  r = await api('POST', `/orders/${o.id}/complete`, { paymentMethod: 'card', discountAmount: 7.5, discountReason: 'Regular guest' }, cashier.token)
  check('with Settings allowing it, both apply and the promotion does not count toward the staff limit', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.promotionAmount, 15); assert.equal(r.data.discountAmount, 7.5); assert.equal(r.data.totalAmount, 127.5) })
  await off(welcome)
  const paid = await tx.customerOrder.findUniqueOrThrow({ where: { id: o.id } })
  const sale = await tx.dailySale.findUniqueOrThrow({ where: { id: paid.dailySaleId } })
  check('Daily Sales counts promotions as discount and the bill once', () => { assert.equal(sale.discountAmount, 22.5); assert.equal(sale.totalAmount, 127.5); assert.equal(Math.round(sale.vatAmount * 100), Math.round(paid.vatAmount * 100)) })
  r = await api('POST', `/orders/${o.id}/coupon`, { code: 'WELCOME10' }, cashier.token)
  check('a paid bill keeps its price; coupons apply only to open bills', () => assert.equal(r.data.code, 'INVALID_STATUS'))

  // ── offline sales keep the device's price; split checks share promotions
  const always = await promo({ name: 'Always 10%', type: 'percent', value: 10 })
  const device = crypto.randomUUID()
  const boot = (await api('POST', '/pos/offline/bootstrap', { deviceId: device, branchId: branch.id, name: 'Promo offline' }, manager.token)).data
  r = await api('POST', '/pos/orders/sync', { orders: [{ clientUuid: crypto.randomUUID(), deviceId: device, sequence: 1, lease: boot.lease, createdAt: new Date().toISOString(), orderType: 'takeaway', items: [{ dishId: burger.id, quantity: 1 }], expectedTotal: 100, vatRate: 16 }] }, manager.token)
  check('an offline sale keeps the price the device charged', () => { assert.equal(r.data.results[0].status, 'synced', JSON.stringify(r.data)); assert.equal(r.data.results[0].order.promotionAmount, 0); assert.equal(r.data.results[0].order.totalAmount, 100) })
  const table = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'P1', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  const dine = (await api('POST', '/pos/orders', { branchId: branch.id, tableId: table.id, orderType: 'dine_in', guestCount: 2, items: [{ dishId: burger.id, quantity: 2 }] }, manager.token)).data
  r = await api('POST', `/orders/${dine.id}/checks`, { mode: 'equal', count: 2 }, manager.token)
  check('split checks share the promotion and add up to the bill', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.totalAmount, 180); assert.equal(Math.round(r.data.checks.reduce((n, c) => n + c.totalAmount, 0) * 100), 18000); assert.equal(Math.round(r.data.checks.reduce((n, c) => n + c.discountAmount, 0) * 100), 2000) })
  await off(always)
  await tx.branch.updateMany({ where: { organizationId: org.id }, data: { isActive: false } })
}
