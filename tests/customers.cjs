// Phase 6: customers, gift cards, loyalty and house accounts — balances,
// refunds, idempotency, permissions, Daily Sales, the ledger and cash closing.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
module.exports = async ({ tx, api, signAccessToken, check, base }) => {
  const perm = {}
  for (const [key, module] of [['can_manage_customers', 'customers'], ['can_manage_orders', 'orders'], ['can_use_pos', 'pos']]) perm[key] = await tx.permission.upsert({ where: { key }, create: { key, module }, update: {} })
  const org = await tx.organization.create({ data: { name: 'Customer tests', country: 'PK', timezone: 'Asia/Karachi', requireTillForCash: true } })
  const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Customers branch', code: 'CUS', vatRate: 16, vatEnabled: true } })
  const accounts = {}
  for (const [key, accountClass, normalBalance] of [
    ['CASH_ON_HAND', 'ASSET', 'DEBIT'], ['CARD_CLEARING', 'ASSET', 'DEBIT'], ['DEFAULT_BANK', 'ASSET', 'DEBIT'], ['ACCOUNTS_RECEIVABLE', 'ASSET', 'DEBIT'],
    ['SALES_REVENUE', 'REVENUE', 'CREDIT'], ['OUTPUT_VAT', 'LIABILITY', 'CREDIT'], ['GIFT_CARD_LIABILITY', 'LIABILITY', 'CREDIT'], ['LOYALTY_LIABILITY', 'LIABILITY', 'CREDIT'],
    ['COST_OF_SALES', 'EXPENSE', 'DEBIT'], ['INVENTORY', 'ASSET', 'DEBIT'],
  ]) {
    const account = await tx.account.create({ data: { organizationId: org.id, code: `C-${key}`, name: key, accountClass, normalBalance } })
    accounts[key] = account.id
    await tx.accountingMapping.create({ data: { organizationId: org.id, key, accountId: account.id } })
  }
  const staff = async (name, roleName, keys = []) => {
    const u = await tx.user.create({ data: { organizationId: org.id, email: `${name}-${crypto.randomUUID()}@customers.invalid`, firstName: name, lastName: 'Test', passwordHash: 'unused' } })
    const role = await tx.role.create({ data: { organizationId: org.id, name: roleName, displayName: name } })
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } })
    for (const k of keys) await tx.rolePermission.create({ data: { roleId: role.id, permissionId: perm[k].id } })
    return { ...u, token: signAccessToken(u.id, org.id, u.email) }
  }
  const manager = await staff('Manager', 'super_admin'), cashier = await staff('Cashier', 'cust_cashier', ['can_manage_orders', 'can_use_pos'])
  const cat = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Meals' } })
  const dish = await tx.dish.create({ data: { organizationId: org.id, categoryId: cat.id, name: 'Customer meal', price: 116 } })
  const till = await tx.tillSession.create({ data: { organizationId: org.id, branchId: branch.id, userId: manager.id, openingFloat: 0 } })
  const order = async (phone, name = 'Ayesha') => {
    const r = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', customerPhone: phone, customerName: name, items: [{ dishId: dish.id, quantity: 1 }] }, manager.token)
    assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data
  }
  const pay = (o, body) => api('POST', `/orders/${o.id}/complete`, body, manager.token)
  const customerRow = (id) => tx.customer.findUniqueOrThrow({ where: { id } })

  // ── customers are linked by normalized phone across orders
  const first = await order('0300-555 0001')
  const second = await order('+92 300 5550001')
  const ayesha = await customerRow(first.customerId)
  check('a POS order with a phone number links one customer per normalized phone', () => { assert.ok(first.customerId); assert.equal(second.customerId, first.customerId); assert.equal(ayesha.phone, '+923005550001'); assert.equal(ayesha.name, 'Ayesha') })
  let r = await api('GET', '/customers/lookup?phone=03005550001', undefined, cashier.token)
  check('the till looks a customer up by phone with recent orders', () => { assert.equal(r.status, 200); assert.equal(r.data.customer.id, ayesha.id); assert.equal(r.data.recentOrders.length, 2); assert.equal(r.data.loyalty.active, false) })

  r = await pay(first, { paymentMethod: 'card' })
  let c = await customerRow(ayesha.id)
  check('a completed order counts one visit and its spend', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(c.visitCount, 1); assert.equal(c.totalSpend, 116); assert.ok(c.lastVisitAt) })
  const noEarn = await tx.loyaltyTransaction.count({ where: { customerId: ayesha.id } })
  check('loyalty stays off until its rates are set in Settings', () => assert.equal(noEarn, 0))

  // ── loyalty: manual rates, earn, redeem, refund
  r = await api('PUT', '/commerce-settings', { loyaltyEarnPerUnit: 0.1, loyaltyPointValue: 1, promotionsStack: false, providerName: '', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '' }, manager.token)
  check('loyalty rates are saved manually in Settings and loyalty reports running', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.loyaltyStatus, 'active') })
  r = await pay(second, { paymentMethod: 'card' })
  c = await customerRow(ayesha.id)
  check('a completed order earns points at the manual rate', () => { assert.equal(r.status, 200); assert.equal(c.loyaltyPoints, 11.6); assert.equal(c.visitCount, 2) })
  r = await pay(second, { paymentMethod: 'card' })
  const earnRows = await tx.loyaltyTransaction.count({ where: { orderId: second.id, type: 'earn' } })
  check('points are earned once per order', () => { assert.notEqual(r.status, 200); assert.equal(earnRows, 1) })
  const third = await order('03005550001')
  r = await pay(third, { payments: [{ method: 'loyalty', amount: 50 }, { method: 'card', amount: 66 }] })
  c = await customerRow(ayesha.id)
  const thirdOpen = await tx.customerOrder.findUniqueOrThrow({ where: { id: third.id } })
  check('points cannot be spent beyond the balance, and nothing is charged', () => { assert.equal(r.data.code, 'LOYALTY_BALANCE'); assert.equal(c.loyaltyPoints, 11.6); assert.equal(thirdOpen.status, 'open') })
  r = await pay(third, { payments: [{ method: 'loyalty', amount: 11.6 }, { method: 'card', amount: 104.4 }] })
  c = await customerRow(ayesha.id)
  check('points pay part of a bill; points are earned on the money part only', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(c.loyaltyPoints, 10.44) })
  r = await api('POST', `/orders/${third.id}/refund`, { reason: 'Customer returned it' }, manager.token)
  c = await customerRow(ayesha.id)
  const reversals = await tx.loyaltyTransaction.findMany({ where: { orderId: third.id }, orderBy: { createdAt: 'asc' } })
  check('a refund returns spent points and takes back earned points', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(c.loyaltyPoints, 11.6); assert.deepEqual(reversals.map((t) => t.type).sort(), ['earn', 'redeem', 'reverse_earn', 'reverse_redeem']); assert.equal(c.visitCount, 2); assert.equal(c.totalSpend, 232) })

  // ── gift cards
  const sale = { requestId: crypto.randomUUID(), branchId: branch.id, method: 'cash', amount: 200 }
  r = await api('POST', '/gift-cards', sale, cashier.token)
  check('selling a gift card for cash needs the cashier’s own till', () => assert.equal(r.data.code, 'TILL_REQUIRED'))
  r = await api('POST', '/gift-cards', sale, manager.token)
  const card = r.data
  check('a gift card is sold with a readable code and its full balance', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.match(card.code, /^GC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/); assert.equal(card.balance, 200); assert.equal(card.usable, true) })
  r = await api('POST', '/gift-cards', sale, manager.token)
  check('a retried gift card sale returns the same card', () => { assert.equal(r.status, 200); assert.equal(r.data.id, card.id); assert.equal(r.data.duplicate, true) })
  r = await api('POST', '/gift-cards', { ...sale, amount: 250 }, manager.token)
  check('a sale request ID cannot be reused for another amount', () => assert.equal(r.data.code, 'RECEIPT_REQUEST_CONFLICT'))
  const { tillTotals } = require('../dist/services/tills')
  const tillAfterCard = await tillTotals(tx, till.id)
  check('gift card cash is in the till’s expected cash', () => assert.equal(tillAfterCard.expectedCash, 200))
  const cardJournal = await tx.journalLine.findMany({ where: { journalEntry: { organizationId: org.id, sourceType: 'CUSTOMER_RECEIPT' } } })
  check('selling a gift card is a liability, not revenue', () => {
    assert.equal(Number(cardJournal.find((l) => l.accountId === accounts.CASH_ON_HAND).debitAmount), 200)
    assert.equal(Number(cardJournal.find((l) => l.accountId === accounts.GIFT_CARD_LIABILITY).creditAmount), 200)
    assert.ok(!cardJournal.some((l) => l.accountId === accounts.SALES_REVENUE))
  })
  r = await api('GET', `/gift-cards/lookup?code=${card.code.toLowerCase()}`, undefined, cashier.token)
  check('the till checks a gift card balance by code', () => { assert.equal(r.status, 200); assert.equal(r.data.balance, 200) })
  const giftA = await order('03005550002', 'Bilal')
  r = await pay(giftA, { payments: [{ method: 'gift_card', amount: 116, giftCardCode: card.code }] })
  let cardRow = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } })
  check('a gift card pays a bill and its balance goes down', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(cardRow.balance, 84) })
  const giftB = await order('03005550002', 'Bilal')
  r = await pay(giftB, { payments: [{ method: 'gift_card', amount: 116, giftCardCode: card.code }] })
  cardRow = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } })
  check('a gift card can never be spent below zero', () => { assert.equal(r.data.code, 'GIFT_CARD_BALANCE'); assert.equal(cardRow.balance, 84) })
  r = await pay(giftB, { payments: [{ method: 'gift_card', amount: 84, giftCardCode: card.code }, { method: 'card', amount: 32 }] })
  cardRow = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } })
  check('the rest of a bill is paid another way once the card is used up', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(cardRow.balance, 0) })
  r = await api('POST', `/orders/${giftB.id}/refund`, { reason: 'Wrong order' }, manager.token)
  cardRow = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } })
  check('a refund puts the money back on the gift card', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(cardRow.balance, 84) })
  r = await pay(await order('03005550003', 'Sana'), { payments: [{ method: 'gift_card', amount: 116, giftCardCode: 'GC-ZZZZ-ZZZZ' }] })
  check('an unknown gift card code is refused', () => assert.equal(r.data.code, 'GIFT_CARD_NOT_FOUND'))
  const constraint = await tx.$queryRaw`SELECT conname FROM pg_constraint WHERE conname = 'GiftCard_balance_nonnegative'`
  check('the database itself refuses a negative gift card balance', () => assert.equal(constraint.length, 1))

  // ── house accounts
  const houseCustomer = ayesha
  r = await api('PUT', `/customers/${houseCustomer.id}`, { name: 'Ayesha', houseAccountEnabled: true, creditLimit: 150, tags: ['VIP'] }, cashier.token)
  check('only customer managers open house accounts', () => assert.equal(r.status, 403))
  r = await api('PUT', `/customers/${houseCustomer.id}`, { name: 'Ayesha', houseAccountEnabled: true, creditLimit: 150, tags: ['VIP'] }, manager.token)
  check('a manager opens a house account with a credit limit', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.deepEqual(r.data.tags, ['vip']) })
  const onAccount = await order('03005550001')
  r = await pay(onAccount, { paymentMethod: 'house_account' })
  c = await customerRow(houseCustomer.id)
  check('a bill is charged to the house account and still earns points', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(c.houseBalance, 116); assert.equal(c.loyaltyPoints, 23.2) })
  const overLimit = await order('03005550001')
  r = await pay(overLimit, { paymentMethod: 'house_account' })
  check('a charge cannot exceed the credit limit', () => assert.equal(r.data.code, 'CREDIT_LIMIT'))
  const payment = { requestId: crypto.randomUUID(), branchId: branch.id, amount: 100, method: 'cash' }
  r = await api('POST', `/customers/${houseCustomer.id}/payments`, payment, manager.token)
  c = await customerRow(houseCustomer.id)
  check('a house account payment reduces what the customer owes', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(c.houseBalance, 16) })
  r = await api('POST', `/customers/${houseCustomer.id}/payments`, payment, manager.token)
  c = await customerRow(houseCustomer.id)
  check('a retried account payment is not taken twice', () => { assert.equal(r.status, 200); assert.equal(r.data.duplicate, true); assert.equal(c.houseBalance, 16) })
  r = await api('POST', `/customers/${houseCustomer.id}/payments`, { ...payment, requestId: crypto.randomUUID(), amount: 50 }, manager.token)
  check('a customer cannot pay more than they owe', () => assert.equal(r.data.code, 'OVERPAYMENT'))
  r = await api('GET', `/customers/${houseCustomer.id}/statement`, undefined, manager.token)
  const kpi = (label) => r.data.report.kpis.find((k) => k.label === label).value
  check('the statement shows charges, payments and the balance owed', () => { assert.equal(r.status, 200); assert.equal(kpi('Charged'), 116); assert.equal(kpi('Paid / refunded'), 100); assert.equal(kpi('Balance owed'), 16); assert.equal(r.data.report.sections[0].rows.length, 2) })
  const pdf = await fetch(`${base}/customers/${houseCustomer.id}/statement?format=pdf`, { headers: { Authorization: `Bearer ${manager.token}` } })
  const pdfBytes = Buffer.from(await pdf.arrayBuffer())
  check('the statement exports as a real PDF', () => { assert.equal(pdf.status, 200); assert.equal(pdfBytes.subarray(0, 4).toString(), '%PDF') })
  r = await api('GET', `/customers/${houseCustomer.id}`, undefined, cashier.token)
  check('the customer profile shows history, points and the account', () => { assert.equal(r.status, 200); assert.ok(r.data.orders.length >= 4); assert.equal(r.data.loyalty.points, 23.2); assert.equal(r.data.customer.houseBalance, 16) })

  // ── Daily Sales, the ledger and cash closing
  const daily = await tx.dailySale.findFirstOrThrow({ where: { organizationId: org.id, branchId: branch.id, source: 'orders' } })
  const completed = await tx.customerOrder.findMany({ where: { organizationId: org.id, dailySaleId: daily.id, status: 'completed' } })
  const byMethod = (m) => Math.round(completed.flatMap((o) => Array.isArray(o.payments) ? o.payments : [{ method: o.paymentMethod, amount: o.totalAmount }]).filter((p) => p.method === m).reduce((n, p) => n + p.amount, 0) * 100) / 100
  check('Daily Sales keeps gift card, points and house account money apart from cash', () => {
    assert.equal(daily.giftCardAmount, byMethod('gift_card')); assert.equal(daily.loyaltyAmount, byMethod('loyalty')); assert.equal(daily.houseAccountAmount, byMethod('house_account'))
    assert.equal(daily.giftCardAmount, 116); assert.equal(daily.houseAccountAmount, 116)
  })
  const { businessDate } = require('../dist/services/orderSales')
  const today = businessDate(org.timezone)
  r = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: today.toISOString(), openingCash: 0, actualCashCounted: 300 }, manager.token)
  check('cash closing expects gift card and account payment cash', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.cashSales, Math.round((daily.cashAmount + 300) * 100) / 100) })
  r = await api('POST', `/sales/${daily.id}/submit`, {}, manager.token)
  check('the day is finalized into the ledger', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
  const balance = async (key) => {
    const lines = await tx.journalLine.findMany({ where: { accountId: accounts[key], journalEntry: { status: 'posted' } } })
    return Math.round(lines.reduce((n, l) => n + Number(l.creditAmount) - Number(l.debitAmount), 0) * 100) / 100
  }
  const cards = await tx.giftCard.aggregate({ where: { organizationId: org.id, status: 'active' }, _sum: { balance: true } })
  const owed = await tx.customer.aggregate({ where: { organizationId: org.id }, _sum: { houseBalance: true, loyaltyPoints: true } })
  const [giftLiability, loyaltyLiability, receivable] = [await balance('GIFT_CARD_LIABILITY'), await balance('LOYALTY_LIABILITY'), await balance('ACCOUNTS_RECEIVABLE')]
  check('the gift card liability equals the unspent card balances', () => assert.equal(giftLiability, cards._sum.balance))
  check('the receivable equals what house account customers owe', () => assert.equal(-receivable, owed._sum.houseBalance))
  check('the loyalty liability equals the value of points customers hold', () => assert.equal(loyaltyLiability, owed._sum.loyaltyPoints * 1))
  const entries = await tx.journalEntry.findMany({ where: { organizationId: org.id }, include: { lines: true } })
  check('every journal entry balances', () => { for (const e of entries) assert.equal(Math.round(e.lines.reduce((n, l) => n + Number(l.debitAmount) - Number(l.creditAmount), 0) * 100), 0, e.description) })

  // ── tenant isolation
  const outsider = await tx.organization.create({ data: { name: 'Other restaurant' } })
  const outUser = await tx.user.create({ data: { organizationId: outsider.id, email: `out-${crypto.randomUUID()}@customers.invalid`, firstName: 'Out', lastName: 'Sider', passwordHash: 'unused' } })
  const outRole = await tx.role.create({ data: { organizationId: outsider.id, name: 'super_admin', displayName: 'Owner' } })
  await tx.userRole.create({ data: { userId: outUser.id, roleId: outRole.id } })
  const outToken = signAccessToken(outUser.id, outsider.id, outUser.email)
  const [theirLookup, theirCard, theirProfile] = await Promise.all([
    api('GET', '/customers/lookup?phone=03005550001', undefined, outToken), api('GET', `/gift-cards/lookup?code=${card.code}`, undefined, outToken), api('GET', `/customers/${houseCustomer.id}`, undefined, outToken),
  ])
  check('another restaurant cannot see these customers or gift cards', () => { assert.equal(theirLookup.data.customer, null); assert.equal(theirCard.status, 404); assert.equal(theirProfile.status, 404) })
  await tx.organization.update({ where: { id: outsider.id }, data: { isActive: false } })
  await tx.branch.updateMany({ where: { organizationId: org.id }, data: { isActive: false } })
}
