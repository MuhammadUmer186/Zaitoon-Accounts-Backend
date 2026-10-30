// Sizes, modifiers and combos: admin rules, server-side pricing and
// validation, recipe-scaled stock. Runs inside the caller's rolled-back
// transaction.
const assert = require('node:assert/strict')

module.exports = async function menuOptionsTests({ tx, api, signAccessToken, check }) {
  const org = await tx.organization.create({ data: { requireTillForCash: false, name: 'Pizza Point', foodCostMethod: 'recipes' } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Main', code: 'PZ1', vatRate: 16 } })
  const user = await tx.user.create({ data: { organizationId: org.id, email: 'menu@example.invalid', passwordHash: 'x', firstName: 'M', lastName: 'Admin' } })
  const role = await tx.role.create({ data: { organizationId: org.id, name: 'super_admin', displayName: 'SA' } })
  await tx.userRole.create({ data: { roleId: role.id, userId: user.id } })
  const t = signAccessToken(user.id, org.id, user.email)
  const shift = await tx.menuShift.create({ data: { organizationId: org.id, name: 'All day', startTime: '00:00', endTime: '00:00' } })
  const cat = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Pizza' } })
  const mk = (name, price) => tx.dish.create({ data: { organizationId: org.id, categoryId: cat.id, name, price, shifts: { create: { shiftId: shift.id } } } })
  const pizza = await mk('Pizza', 800)
  const pepsi = await mk('Pepsi', 100)
  const deal = await mk('Pizza Deal', 1000)
  const flour = await tx.item.create({ data: { organizationId: org.id, code: 'FLR', name: 'Flour', unit: 'kg', costPrice: 100 } })
  const cheese = await tx.item.create({ data: { organizationId: org.id, code: 'CHZ', name: 'Cheese', unit: 'kg', costPrice: 2000 } })
  const cola = await tx.item.create({ data: { organizationId: org.id, code: 'COL', name: 'Cola syrup', unit: 'litre', costPrice: 300 } })
  for (const it of [flour, cheese, cola]) await tx.branchStock.create({ data: { organizationId: org.id, branchId: branch.id, itemId: it.id, quantityOnHand: 100, averageCost: it.costPrice, totalValue: 100 * it.costPrice } })
  await tx.dishIngredient.create({ data: { dishId: pizza.id, itemId: flour.id, quantity: 0.3, wastePct: 0 } })
  await tx.dishIngredient.create({ data: { dishId: pepsi.id, itemId: cola.id, quantity: 0.05, wastePct: 0 } })

  // ── admin
  let r = await api('POST', '/menu/modifier-groups', { name: 'Spice', minSelect: 1, maxSelect: 1, options: [{ name: 'Mild' }, { name: 'Hot' }] }, t)
  const spice = r.data
  check('a modifier group with options is created', () => { assert.equal(r.status, 201); assert.equal(spice.options.length, 2) })
  r = await api('POST', '/menu/modifier-groups', { name: 'Extras', minSelect: 0, maxSelect: 3, options: [{ name: 'Cheese', price: 50, itemId: cheese.id, itemQuantity: 0.03 }, { name: 'Olives', price: 30 }, { name: 'Jalapeño', price: 20 }] }, t)
  const extras = r.data
  r = await api('POST', '/menu/modifier-groups', { name: 'Bad', minSelect: 3, maxSelect: 1, options: [{ name: 'x' }] }, t)
  check('a group cannot require more than it allows', () => assert.equal(r.status, 400))
  const jalapeno = extras.options.find((o) => o.name === 'Jalapeño')
  r = await api('PUT', `/menu/dishes/${pizza.id}/options`, {
    sizes: [{ name: 'Medium', price: 800, recipeFactor: 1, isDefault: true }, { name: 'Large', price: 1200, recipeFactor: 1.5 }],
    modifierGroups: [{ groupId: spice.id }, { groupId: extras.id, freeCount: 1, excludedOptionIds: [jalapeno.id] }],
  }, t)
  check('a dish takes sizes and modifier groups with per-dish rules', () => { assert.equal(r.status, 200); assert.equal(r.data.sizes.length, 2); assert.equal(r.data.modifierGroups[1].freeCount, 1) })
  const sizes = (await tx.dishSize.findMany({ where: { dishId: pizza.id }, orderBy: { sortOrder: 'asc' } }))
  const [medium, large] = sizes
  r = await api('PUT', `/menu/dishes/${pepsi.id}/options`, { sizes: [{ name: 'Regular', price: 100 }, { name: 'Large', price: 150 }] }, t)
  const pepsiSizes = await tx.dishSize.findMany({ where: { dishId: pepsi.id }, orderBy: { sortOrder: 'asc' } })
  check('the first size becomes the default when none is chosen', () => assert.equal(pepsiSizes[0].isDefault, true))
  r = await api('PUT', `/menu/dishes/${deal.id}/options`, { isCombo: true, comboGroups: [{ name: 'Pizza', options: [{ dishId: deal.id }] }] }, t)
  check('a combo cannot contain itself', () => assert.equal(r.status, 400))
  r = await api('PUT', `/menu/dishes/${deal.id}/options`, {
    isCombo: true,
    comboGroups: [
      { name: 'Pizza', options: [{ dishId: pizza.id, sizeId: medium.id }, { dishId: pizza.id, sizeId: large.id, priceDelta: 300 }] },
      { name: 'Drink', options: [{ dishId: pepsi.id, sizeId: pepsiSizes[0].id, isDefault: true }, { dishId: pepsi.id, sizeId: pepsiSizes[1].id, priceDelta: 40 }] },
    ],
  }, t)
  check('a combo is built from choice groups of dishes and sizes', () => { assert.equal(r.status, 200); assert.equal(r.data.isCombo, true); assert.equal(r.data.comboGroups.length, 2) })
  const mega = await mk('Mega Deal', 2000)
  r = await api('PUT', `/menu/dishes/${mega.id}/options`, { isCombo: true, comboGroups: [{ name: 'Deal', options: [{ dishId: deal.id }] }] }, t)
  check('a combo cannot contain another combo', () => assert.equal(r.status, 400))

  // ── menu payloads
  r = await api('GET', `/pos/menu?branchId=${branch.id}`, undefined, t)
  const posPizza = r.data.categories[0].dishes.find((d) => d.id === pizza.id)
  check('the POS menu carries sizes and modifier rules', () => {
    assert.equal(posPizza.options.sizes.length, 2); assert.equal(posPizza.options.groups.length, 2)
    assert.ok(!posPizza.options.groups[1].options.some((o) => o.name === 'Jalapeño')); assert.equal(posPizza.options.groups[1].options[0].itemId, undefined)
  })
  const table = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'P1', orderToken: require('node:crypto').randomUUID(), reviewToken: require('node:crypto').randomUUID() } })
  r = await api('GET', `/public/tables/${table.orderToken}/menu`)
  check('the table QR menu carries the same options', () => assert.ok(r.data.categories?.[0]?.dishes.find((d) => d.id === deal.id)?.options?.isCombo, JSON.stringify(r.data).slice(0, 300)))
  r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: pizza.id, quantity: 1 }] })
  check('table QR orders are validated the same way', () => assert.equal(r.status, 400))

  // ── pricing and validation
  const hot = spice.options.find((o) => o.name === 'Hot')
  const cheeseOpt = extras.options.find((o) => o.name === 'Cheese')
  const olives = extras.options.find((o) => o.name === 'Olives')
  r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: pizza.id, quantity: 1, sizeId: large.id, modifiers: [spice.options[1].id] }] })
  check('a table QR order prices its size and choices', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.order.items[0].unitPrice, 1200) })
  check('guest order selections retain kitchen details without inventory fields', () => {
    const selection = r.data.order.items[0].selection
    assert.equal(selection.size.name, 'Large')
    assert.equal(selection.modifiers[0].name, 'Hot')
    assert.equal(Object.hasOwn(selection.modifiers[0], 'itemId'), false)
    assert.equal(Object.hasOwn(selection.modifiers[0], 'itemQuantity'), false)
  })
  const send = (items) => api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items }, t)
  r = await send([{ dishId: pizza.id, quantity: 1 }])
  check('a required choice must be made', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Spice/) })
  r = await send([{ dishId: pizza.id, quantity: 1, modifiers: [hot.id, jalapeno.id] }])
  check('an option excluded on this dish is refused', () => assert.equal(r.status, 400))
  r = await send([{ dishId: pizza.id, quantity: 1, modifiers: [hot.id, spice.options[0].id] }])
  check('more choices than allowed are refused', () => assert.equal(r.status, 400))
  r = await send([{ dishId: pizza.id, quantity: 2, sizeId: large.id, modifiers: [hot.id, cheeseOpt.id, olives.id] }])
  const pizzaLine = r.data.items?.[0]
  check('size and modifiers are priced on the server, the dearest free option first', () => {
    assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(pizzaLine.unitPrice, 1230); assert.equal(pizzaLine.lineTotal, 2460)
    assert.equal(pizzaLine.selection.size.name, 'Large'); assert.equal(pizzaLine.selection.modifiers.find((m) => m.name === 'Cheese').free, true)
  })
  const pizzaOrder = r.data
  r = await send([{ dishId: pizza.id, quantity: 1, modifiers: [hot.id] }])
  check('the default size applies when none is sent', () => assert.equal(r.data.items[0].unitPrice, 800))
  const dealGroups = await tx.comboGroup.findMany({ where: { dishId: deal.id }, include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' } })
  r = await send([{ dishId: deal.id, quantity: 1, combo: [{ groupId: dealGroups[0].id, optionId: dealGroups[0].options[1].id }] }])
  check('every combo choice must be made', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Drink/) })
  r = await send([{ dishId: deal.id, quantity: 1, combo: [{ groupId: dealGroups[0].id, optionId: dealGroups[0].options[1].id }, { groupId: dealGroups[1].id, optionId: dealGroups[1].options[1].id }] }])
  const dealOrder = r.data
  check('a combo is priced with its upgrades', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.items[0].unitPrice, 1340); assert.equal(r.data.items[0].selection.combo.length, 2) })
  await tx.dishOutOfStock.create({ data: { organizationId: org.id, branchId: branch.id, dishId: pepsi.id, markedBy: user.id } })
  r = await send([{ dishId: deal.id, quantity: 1, combo: [{ groupId: dealGroups[0].id, optionId: dealGroups[0].options[0].id }, { groupId: dealGroups[1].id, optionId: dealGroups[1].options[0].id }] }])
  check('a combo choice that is out of stock is refused', () => { assert.equal(r.status, 400); assert.match(r.data.message, /out of stock/) })
  r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: deal.id, quantity: 1, combo: dealGroups.map((g) => ({ groupId: g.id, optionId: g.options[0].id })) }] })
  check('table QR also refuses an out-of-stock component outside the cart dish IDs', () => { assert.equal(r.status, 400); assert.match(r.data.message, /out of stock/) })
  await tx.dishOutOfStock.deleteMany({ where: { branchId: branch.id, dishId: pepsi.id } })

  // ── recipes follow the selection
  await api('POST', `/orders/${pizzaOrder.id}/complete`, { paymentMethod: 'cash' }, t)
  await api('POST', `/orders/${dealOrder.id}/complete`, { paymentMethod: 'cash' }, t)
  const used = async (itemId, orderId) => -(await tx.stockMovement.findMany({ where: { itemId, referenceId: orderId, movementType: 'sale' } })).reduce((s, m) => s + m.quantity, 0)
  const flourPizza = await used(flour.id, pizzaOrder.id), cheesePizza = await used(cheese.id, pizzaOrder.id)
  const flourDeal = await used(flour.id, dealOrder.id), colaDeal = await used(cola.id, dealOrder.id)
  check('size scales the recipe and modifiers draw their stock', () => { assert.ok(Math.abs(flourPizza - 0.9) < 1e-6, String(flourPizza)); assert.ok(Math.abs(cheesePizza - 0.06) < 1e-6, String(cheesePizza)) })
  check('a combo draws the recipes of the chosen components', () => { assert.ok(Math.abs(flourDeal - 0.45) < 1e-6, String(flourDeal)); assert.ok(Math.abs(colaDeal - 0.05) < 1e-6, String(colaDeal)) })
  const costed = await tx.customerOrderItem.findFirst({ where: { orderId: pizzaOrder.id } })
  check('food cost includes size and modifiers', () => assert.ok(Math.abs(costed.unitCost - (0.45 * 100 + 0.03 * 2000)) < 0.01, String(costed.unitCost)))

  // Editing a component must not silently remove the size from existing deals.
  const configured = (await api('GET', `/menu/dishes/${pizza.id}/options`, undefined, t)).data
  configured.sizes[1].name = 'Family'
  r = await api('PUT', `/menu/dishes/${pizza.id}/options`, configured, t)
  check('editing sizes keeps their IDs for combo references and carts', () => {
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.sizes[1].id, large.id)
    assert.equal(r.data.sizes[1].name, 'Family')
  })
  r = await api('PUT', `/menu/dishes/${pizza.id}/options`, { ...configured, sizes: [configured.sizes[0]] }, t)
  check('a size used by a combo cannot be removed', () => { assert.equal(r.status, 400); assert.match(r.data.message, /combo/) })
  r = await api('PUT', `/menu/dishes/${pizza.id}/options`, { ...configured, sizes: [{ ...configured.sizes[0], id: pepsiSizes[0].id }] }, t)
  check('another dish size ID cannot be overwritten', () => assert.equal(r.status, 400))
  const selectedCombo = dealGroups.map((g) => ({ groupId: g.id, optionId: g.options[0].id }))
  r = await api('POST', `/public/tables/${table.orderToken}/orders`, { items: [{ dishId: deal.id, quantity: 1, combo: selectedCombo }] })
  check('table QR combos retain both chosen components in tracking', () => {
    assert.equal(r.status, 201, JSON.stringify(r.data))
    const line = r.data.order.items.find((i) => i.dishName === deal.name)
    assert.equal(line.unitPrice, 1000)
    assert.equal(line.selection.combo.length, 2)
    assert.equal(line.selection.combo[0].sizeName, 'Medium')
  })
  await tx.comboGroup.update({ where: { id: dealGroups[0].id }, data: { maxSelect: 2 } })
  r = await send([{ dishId: deal.id, quantity: 1, combo: [...selectedCombo, selectedCombo[0]] }])
  check('repeated combo option IDs are refused', () => { assert.equal(r.status, 400); assert.match(r.data.message, /twice/) })
  await tx.comboOption.update({ where: { id: dealGroups[0].options[0].id }, data: { priceDelta: -2000 } })
  r = await send([{ dishId: deal.id, quantity: 1, combo: selectedCombo }])
  check('combo discounts cannot produce negative line prices', () => { assert.equal(r.status, 400); assert.match(r.data.message, /negative/) })
  await tx.branch.update({ where: { id: branch.id }, data: { isActive: false } })
}
