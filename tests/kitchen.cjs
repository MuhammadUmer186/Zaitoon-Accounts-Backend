// Kitchen stations, routing, courses (hold / fire), recall and the customer
// "order ready" screen. Runs inside the caller's rolled-back transaction.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

module.exports = async function kitchenTests({ tx, api, signAccessToken, check }) {
  const org = await tx.organization.create({ data: { name: 'Kitchen tests', requireTillForCash: false } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Kitchen Main', code: 'KIT', vatRate: 16 } })
  const mkUser = async (name, perms) => {
    const u = await tx.user.create({ data: { organizationId: org.id, email: `${name}@kitchen.invalid`, passwordHash: 'x', firstName: name, lastName: 'K' } })
    const role = await tx.role.create({ data: { organizationId: org.id, name: perms ? `k_${name}` : 'super_admin', displayName: name } })
    for (const key of perms ?? []) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: (await tx.permission.findUniqueOrThrow({ where: { key } })).id } })
    await tx.userRole.create({ data: { roleId: role.id, userId: u.id } })
    return signAccessToken(u.id, org.id, u.email)
  }
  const admin = await mkUser('admin')
  const cook = await mkUser('cook', ['can_manage_kitchen'])
  const shift = await tx.menuShift.create({ data: { organizationId: org.id, name: 'All day', startTime: '00:00', endTime: '00:00' } })
  const grillCat = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Grill' } })
  const drinksCat = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Drinks' } })
  const mk = (name, categoryId, price) => tx.dish.create({ data: { organizationId: org.id, categoryId, name, price, shifts: { create: { shiftId: shift.id } } } })
  const tikka = await mk('Chicken Tikka', grillCat.id, 900)
  const kebab = await mk('Seekh Kebab', grillCat.id, 700)
  const lassi = await mk('Lassi', drinksCat.id, 250)
  const soup = await mk('Soup', drinksCat.id, 400)

  // ── stations and routing
  let r = await api('POST', '/kitchen/stations', { name: 'Grill', printerName: 'EPSON-GRILL' }, admin)
  const grill = r.data
  check('a kitchen station is created with its printer', () => { assert.equal(r.status, 201); assert.equal(grill.printerName, 'EPSON-GRILL') })
  r = await api('POST', '/kitchen/stations', { name: 'Grill' }, admin)
  check('station names are unique', () => assert.equal(r.status, 409))
  r = await api('POST', '/kitchen/stations', { name: 'Bar' }, cook)
  check('only menu managers configure stations', () => assert.equal(r.status, 403))
  const bar = (await api('POST', '/kitchen/stations', { name: 'Bar' }, admin)).data
  const tandoor = (await api('POST', '/kitchen/stations', { name: 'Tandoor' }, admin)).data
  r = await api('PUT', '/kitchen/routing', { categories: [{ id: grillCat.id, stationId: grill.id }, { id: drinksCat.id, stationId: bar.id }], dishes: [{ id: kebab.id, stationId: tandoor.id, prepMinutes: 12 }, { id: tikka.id, stationId: null, prepMinutes: 15 }] }, admin)
  check('categories route to stations and a dish overrides its category', () => assert.equal(r.status, 200))
  r = await api('PUT', '/kitchen/routing', { categories: [{ id: grillCat.id, stationId: 'nope' }] }, admin)
  check('routing refuses an unknown station', () => assert.equal(r.status, 400))
  await api('PUT', `/kitchen/stations/${bar.id}`, { isActive: false }, admin)
  r = await api('GET', '/kitchen/routing', undefined, admin)
  check('the routing screen lists stations, categories and dishes', () => { assert.equal(r.data.stations.length, 3); assert.equal(r.data.dishes.find((d) => d.id === kebab.id).prepMinutes, 12) })

  // ── POS order: lines carry their station; later courses are held
  r = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [
    { dishId: tikka.id, quantity: 1 }, { dishId: kebab.id, quantity: 2 }, { dishId: lassi.id, quantity: 1 }, { dishId: soup.id, quantity: 1, course: 2 },
  ] }, admin)
  const order = r.data
  const line = (dishId) => order.items.find((i) => i.dishId === dishId)
  check('each line is routed when ordered', () => {
    assert.equal(r.status, 201, JSON.stringify(r.data))
    assert.equal(line(tikka.id).stationId, grill.id); assert.equal(line(tikka.id).station.printerName, 'EPSON-GRILL')
    assert.equal(line(kebab.id).stationId, tandoor.id)
    assert.equal(line(lassi.id).stationId, null) // retired station
  })
  check('a later course is held until fired', () => { assert.equal(line(soup.id).course, 2); assert.equal(line(soup.id).held, true); assert.equal(line(tikka.id).held, false) })

  // Full payment releases the ticket; held courses remain held.
  r = await api('GET', `/kitchen/orders?branchId=${branch.id}`, undefined, cook)
  check('unpaid POS ticket stays off kitchen board', () => assert.equal(r.data.data.length, 0))
  r = await api('POST', `/kitchen/orders/${order.id}/advance`, { from: 'pending' }, cook)
  check('unpaid kitchen advance is blocked', () => assert.equal(r.data.code, 'PAYMENT_REQUIRED'))
  r = await api('POST', `/orders/${order.id}/fire`, { course: 2 }, admin)
  check('unpaid course fire is blocked', () => assert.equal(r.data.code, 'PAYMENT_REQUIRED'))
  r = await api('PATCH', `/orders/${order.id}/items/${line(tikka.id).id}`, { status: 'preparing' }, cook)
  check('unpaid individual preparation is blocked', () => assert.equal(r.data.code, 'PAYMENT_REQUIRED'))
  r = await api('POST', `/orders/${order.id}/complete`, { paymentMethod: 'mada' }, admin)
  check('full MADA settlement releases kitchen work', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.status, 'completed') })
  // ── kitchen board
  r = await api('GET', `/kitchen/orders?branchId=${branch.id}&stationId=${grill.id}`, undefined, cook)
  check('the board filters by station', () => { assert.equal(r.data.data.length, 1); assert.equal(r.data.data[0].items.find((i) => i.dishId === kebab.id).prepMinutes, 12) })
  r = await api('GET', `/kitchen/orders?branchId=${branch.id}&stationId=${bar.id}`, undefined, cook)
  check('a station with no work shows nothing', () => assert.equal(r.data.data.length, 0))
  r = await api('PATCH', `/orders/${order.id}/items/${line(soup.id).id}`, { status: 'preparing' }, cook)
  check('a held dish cannot be started', () => { assert.equal(r.status, 400); assert.equal(r.data.code, 'COURSE_HELD') })
  r = await api('POST', `/kitchen/orders/${order.id}/advance`, { from: 'pending', stationId: grill.id }, cook)
  const afterBump = await tx.customerOrderItem.findMany({ where: { orderId: order.id } })
  check('a station bumps only its own dishes', () => {
    assert.equal(r.data.updated, 1)
    assert.equal(afterBump.find((i) => i.dishId === tikka.id).status, 'preparing'); assert.equal(afterBump.find((i) => i.dishId === kebab.id).status, 'pending')
    assert.equal(afterBump.find((i) => i.dishId === soup.id).status, 'pending')
  })
  r = await api('POST', `/orders/${order.id}/fire`, { course: 3 }, admin)
  check('firing an empty course is refused', () => assert.equal(r.status, 409))
  r = await api('POST', `/orders/${order.id}/fire`, { course: 2 }, admin)
  check('firing a course releases its dishes to the kitchen', () => { assert.equal(r.status, 200); assert.deepEqual(r.data.firedItemIds, [line(soup.id).id]); assert.ok(r.data.items.find((i) => i.dishId === soup.id).firedAt) })
  r = await api('PATCH', `/orders/${order.id}/items/${line(soup.id).id}`, { status: 'preparing' }, cook)
  check('a fired dish can be started', () => assert.equal(r.status, 200))

  // ── order-ready screen
  r = await api('GET', `/kitchen/ready-display?branchId=${branch.id}`, undefined, cook)
  check('no ready screen link until one is made', () => assert.equal(r.data.token, null))
  r = await api('POST', '/kitchen/ready-display', { branchId: branch.id }, admin)
  const token = r.data.token
  check('a manager creates the ready screen link', () => { assert.equal(r.status, 200); assert.ok(token.length > 20) })
  const dine = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'T9', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
  await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'dine_in', tableId: dine.id, items: [{ dishId: tikka.id, quantity: 1 }] }, admin)
  r = await api('GET', `/public/ready/${token}`)
  check('the ready screen shows takeaway orders being prepared, never dine-in', () => { assert.equal(r.status, 200); assert.deepEqual(r.data.preparing, [order.orderNo]); assert.equal(r.data.ready.length, 0) })
  for (const from of ['pending', 'preparing']) await api('POST', `/kitchen/orders/${order.id}/advance`, { from }, cook)
  await api('POST', `/kitchen/orders/${order.id}/advance`, { from: 'pending' }, cook)
  await api('POST', `/kitchen/orders/${order.id}/advance`, { from: 'preparing' }, cook)
  r = await api('GET', `/public/ready/${token}`)
  check('an order moves to Ready when every dish is ready', () => { assert.equal(r.data.preparing.length, 0); assert.equal(r.data.ready[0].orderNo, order.orderNo) })
  await api('POST', `/kitchen/orders/${order.id}/advance`, { from: 'ready' }, cook)
  r = await api('GET', `/public/ready/${token}`)
  check('a handed-over order leaves the ready screen', () => assert.equal(r.data.ready.length, 0))
  r = await api('POST', `/kitchen/orders/${order.id}/recall`, {}, cook)
  const recalled = await tx.customerOrderItem.count({ where: { orderId: order.id, status: 'ready' } })
  check('recall brings back dishes bumped by mistake', () => { assert.equal(r.status, 200); assert.equal(recalled, 4) })
  await api('POST', '/kitchen/ready-display', { branchId: branch.id }, admin)
  r = await api('GET', `/public/ready/${token}`)
  check('a replaced ready screen link stops working', () => assert.equal(r.status, 404))

  // ── deleting a station unroutes its dishes
  r = await api('DELETE', `/kitchen/stations/${tandoor.id}`, undefined, admin)
  const kebabAfter = await tx.dish.findUnique({ where: { id: kebab.id } })
  check('deleting a station sends its dishes back to no station', () => { assert.equal(r.status, 200); assert.equal(kebabAfter.stationId, null) })
  // ── receipt details: staff names, VAT number, original vs reprint
  const adminUser = await tx.user.findFirstOrThrow({ where: { email: 'admin@kitchen.invalid' } })
  await tx.organization.update({ where: { id: org.id }, data: { vatNumber: '399999999900003' } })
  const unpaidReceipt = (await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: tikka.id, quantity: 1 }] }, admin)).data
  r = await api('POST', `/orders/${unpaidReceipt.id}/receipt`, {}, admin)
  check('an unpaid bill is not counted as a receipt copy', () => { assert.equal(r.status, 200); assert.equal(r.data.copy, 0) })
  await tx.customerOrder.update({ where: { id: order.id }, data: { status: 'completed', createdBy: adminUser.id, closedBy: adminUser.id } })
  const first = await api('POST', `/orders/${order.id}/receipt`, {}, admin)
  const second = await api('POST', `/orders/${order.id}/receipt`, {}, admin)
  const reprintLog = await tx.auditLog.count({ where: { resourceId: order.id, action: 'reprint_receipt' } })
  check('the receipt names creator and closer and shows the VAT number', () => { assert.equal(first.data.createdBy, 'admin K'); assert.equal(first.data.closedBy, 'admin K'); assert.equal(first.data.vatNumber, '399999999900003') })
  check('the first paid receipt is the original and the next is an audited reprint', () => { assert.equal(first.data.copy, 1); assert.equal(second.data.copy, 2); assert.equal(reprintLog, 1) })

  await tx.branch.update({ where: { id: branch.id }, data: { isActive: false } })
}
