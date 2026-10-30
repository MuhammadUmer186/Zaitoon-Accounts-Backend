// Real concurrency for split checks, on a throwaway database. Unlike the main
// suite (one rolled-back transaction, one request at a time), this runs the
// API with its own connection pool and fires requests in parallel, so
// PostgreSQL row and advisory locks are what keep the books right.
//
//   node tests/concurrency-checks.cjs            (builds nothing; run `npm run build` first)
//
// Creates database <current>_concurrency_<pid>, pushes the schema to it, runs
// each race several times, checks the invariants, then drops the database.
require('dotenv/config')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const path = require('node:path')
const { PrismaClient } = require('@prisma/client')

const baseUrl = process.env.DATABASE_URL
if (!baseUrl) throw new Error('DATABASE_URL is required')
const dbName = `fs_concurrency_${process.pid}`
const adminUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1')
const scratchUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)
const ROUNDS = Number(process.env.ROUNDS || 5)
let passed = 0, failed = 0
const outcomes = {} // which side won each race, to show both orders occurred
const tally = (race, winner) => { outcomes[race] = outcomes[race] || {}; outcomes[race][winner] = (outcomes[race][winner] || 0) + 1 }
const check = (name, fn) => { try { fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.log('FAIL', name); console.log(e.message) } }

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  await admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`)
  let server, db
  try {
    const prismaBin = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js')
    execFileSync(process.execPath, [prismaBin, 'db', 'push', '--skip-generate', '--schema', path.join(__dirname, '..', 'prisma', 'schema.prisma')], { env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: 'pipe' })
    process.env.DATABASE_URL = scratchUrl // the app's PrismaClient reads this when loaded
    db = new PrismaClient({ datasources: { db: { url: scratchUrl } } })

    const org = await db.organization.create({ data: { name: 'Concurrency', requireTillForCash: true, foodCostMethod: 'recipes', timezone: 'Asia/Karachi', maxStaffDiscountPct: 100 } })
    await db.role.create({ data: { organizationId: org.id, name: 'super_admin', displayName: 'Owner', isSystemRole: true } })
    execFileSync(process.execPath, [path.join(__dirname, '..', 'prisma', 'sync-permissions.js')], { env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: 'pipe' })
    const role = await db.role.findFirstOrThrow({ where: { organizationId: org.id, name: 'super_admin' } })
    const users = []
    for (const name of ['CashierA', 'CashierB', 'Approver']) {
      const u = await db.user.create({ data: { organizationId: org.id, email: `${name.toLowerCase()}@concurrency.invalid`, firstName: name, lastName: 'Test', passwordHash: 'unused' } })
      await db.userRole.create({ data: { userId: u.id, roleId: role.id } })
      users.push(u)
    }
    const cat = await db.menuCategory.create({ data: { organizationId: org.id, name: 'Food' } })
    const dish = await db.dish.create({ data: { organizationId: org.id, categoryId: cat.id, name: 'Meal', price: 116 } })
    const item = await db.item.create({ data: { organizationId: org.id, code: 'MEAL', name: 'Meal portion', costPrice: 10 } })
    await db.dishIngredient.create({ data: { dishId: dish.id, itemId: item.id, quantity: 1 } })

    const app = require('../dist/app').default
    const { signSimulatorEvent } = require('../dist/services/payments/adapters')
    const { signAccessToken } = require('../dist/utils/jwt')
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const base = `http://127.0.0.1:${server.address().port}/api/v1`
    const [A, B, approver] = users.map((u) => signAccessToken(u.id, org.id, u.email))
    const api = async (method, p, body, token) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
      const text = await res.text(); let data; try { data = JSON.parse(text) } catch { data = text }
      return { status: res.status, data }
    }
    const ok = (r) => r.status >= 200 && r.status < 300
    // the sandbox simulator as the payment integration
    await db.commerceSettings.create({ data: { organizationId: org.id, paymentAdapter: 'simulator', paymentEnvironment: 'sandbox', updatedBy: users[0].id } })
    // both requests in flight together; which starts first alternates and a
    // small random delay shifts the order, so either side can win the lock
    let flip = false
    const race = async (first, second, maxJitter = 25) => {
      flip = Math.random() < 0.5 // per race, so no race always gets the same leader
      const jitter = () => new Promise((res) => setTimeout(res, Math.floor(Math.random() * maxJitter)))
      const [a, b] = flip ? [first, second] : [second, first]
      const t0 = Date.now(), timed = (f) => f().then((x) => ({ ...x, ms: Date.now() - t0 }))
      const results = await Promise.all([timed(a), jitter().then(() => timed(b))])
      if (process.env.DEBUG_RACE) console.log('race', flip ? 'first-led' : 'second-led', JSON.stringify(results.map((x) => [x.status, x.data?.code, x.ms])))
      return flip ? results : [results[1], results[0]]
    }

    // one branch per race so cash days, tills and closings never interfere
    let branchNo = 0
    async function newBranch() {
      branchNo++
      const branch = await db.branch.create({ data: { organizationId: org.id, name: `Branch ${branchNo}`, code: `C${branchNo}`, vatRate: 16, vatEnabled: true } })
      await db.branchStock.create({ data: { organizationId: org.id, branchId: branch.id, itemId: item.id, quantityOnHand: 1000, totalValue: 10000, averageCost: 10 } })
      const tables = []
      for (let n = 1; n <= 4; n++) tables.push(await db.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: `T${n}`, orderToken: `${branch.id}-o${n}`, reviewToken: `${branch.id}-r${n}` } }))
      for (const t of [A, B]) assert.ok(ok(await api('POST', '/pos/tills', { branchId: branch.id, openingFloat: 0 }, t)))
      return { branch, tables }
    }
    async function splitOrder(branch, table, count = 2) {
      const o = await api('POST', '/pos/orders', { branchId: branch.id, tableId: table.id, orderType: 'dine_in', guestCount: count, items: [{ dishId: dish.id, quantity: count }] }, A)
      assert.ok(ok(o), JSON.stringify(o.data))
      const s = await api('POST', `/orders/${o.data.id}/checks`, { mode: 'equal', count }, A)
      assert.ok(ok(s), JSON.stringify(s.data))
      return s.data
    }
    const pay = (order, c, token, method = 'cash') => api('POST', `/orders/${order.id}/checks/${c.id}/pay`, { payments: [{ method, amount: c.totalAmount }], ...(method === 'cash' && { amountTendered: c.totalAmount }) }, token)
    const stock = async (branch) => (await db.branchStock.findUniqueOrThrow({ where: { branchId_itemId: { branchId: branch.id, itemId: item.id } } })).quantityOnHand

    for (let round = 1; round <= ROUNDS; round++) {
      // 1. two cashiers pay the two checks of one bill at the same moment
      {
        const { branch, tables } = await newBranch()
        const order = await splitOrder(branch, tables[0])
        const [ra, rb] = await race(() => pay(order, order.checks[0], A), () => pay(order, order.checks[1], B))
        const fresh = await db.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { checks: true } })
        const sales = await db.tillPayment.findMany({ where: { orderId: order.id, type: 'sale' } })
        const daily = await db.dailySale.findMany({ where: { branchId: branch.id } })
        check(`round ${round}: parallel payments of two checks by two cashiers`, () => {
          assert.ok(ok(ra) && ok(rb), JSON.stringify([ra.data, rb.data]))
          assert.equal(fresh.status, 'completed'); assert.equal(fresh.checks.filter((c) => c.status === 'paid').length, 2)
          assert.equal(sales.length, 2); assert.equal(new Set(sales.map((p) => p.sessionId)).size, 2)
          assert.equal(Math.round(sales.reduce((n, p) => n + p.amount, 0) * 100), Math.round(fresh.totalAmount * 100))
          assert.equal(Math.round(daily.reduce((n, s) => n + s.totalAmount, 0) * 100), Math.round(fresh.totalAmount * 100))
          assert.equal(Math.round(fresh.checks.reduce((n, c) => n + c.foodCost, 0) * 100), 2000)
        })
        const left = await stock(branch)
        check(`round ${round}: the recipe is consumed exactly once`, () => assert.equal(left, 998))
      }
      // 2. the same check sent twice at once (double tap / two devices)
      {
        const { branch, tables } = await newBranch()
        const order = await splitOrder(branch, tables[0])
        const [r1, r2] = await race(() => pay(order, order.checks[0], A), () => pay(order, order.checks[0], B))
        const events = await db.tillPayment.count({ where: { checkId: order.checks[0].id, type: 'sale' } })
        const left = await stock(branch)
        tally('same check twice', [r1, r2].filter(ok).length === 2 ? 'second returned the paid check' : 'second refused')
        check(`round ${round}: a check paid twice at once records one payment`, () => {
          assert.ok(ok(r1) || ok(r2)); assert.ok([r1, r2].every((r) => ok(r) || r.status === 409), JSON.stringify([r1.data, r2.data]))
          assert.equal(events, 1); assert.equal(left, 998)
        })
      }
      // 3. paying a check while someone resets the split
      {
        const { branch, tables } = await newBranch()
        const order = await splitOrder(branch, tables[0])
        const [rp, rr] = await race(() => pay(order, order.checks[0], A, 'card'), () => api('DELETE', `/orders/${order.id}/checks`, undefined, B))
        const checks = await db.orderCheck.findMany({ where: { orderId: order.id } })
        const events = await db.tillPayment.count({ where: { orderId: order.id } })
        tally('pay vs reset', ok(rp) ? 'payment won' : ok(rr) ? 'reset won' : 'neither')
        check(`round ${round}: pay and reset never both win`, () => {
          assert.ok(!(ok(rp) && ok(rr)), JSON.stringify([rp.data, rr.data]))
          if (ok(rr)) { assert.equal(checks.length, 0); assert.equal(events, 0) } else { assert.equal(checks.filter((c) => c.status === 'paid').length, 1); assert.equal(events, 1) }
        })
      }
      // 4. a group refund racing the last check's payment
      {
        const { branch, tables } = await newBranch()
        const order = await splitOrder(branch, tables[0])
        assert.ok(ok(await pay(order, order.checks[0], A, 'card')))
        const [rp, rf] = await race(() => pay(order, order.checks[1], B, 'card'), () => api('POST', `/orders/${order.id}/checks/refund`, { reason: 'Concurrency refund' }, A), 120)
        const fresh = await db.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { checks: true } })
        const events = await db.tillPayment.findMany({ where: { orderId: order.id } })
        const sum = (type) => Math.round(events.filter((e) => e.type === type).reduce((n, e) => n + e.amount, 0) * 100)
        const left = await stock(branch)
        tally('refund vs last payment', ok(rp) ? 'payment first, then refunded' : 'refund first')
        check(`round ${round}: refund racing a payment leaves no money or stock behind`, () => {
          assert.ok(ok(rf), JSON.stringify(rf.data)); assert.equal(fresh.status, 'refunded')
          assert.ok(!fresh.checks.some((c) => c.status === 'paid' || c.status === 'unpaid'))
          assert.equal(sum('refund'), sum('sale')); assert.equal(left, 1000)
          if (!ok(rp)) assert.ok([404, 409].includes(rp.status), JSON.stringify(rp.data))
        })
      }
      // 5. moving the table while a check is being paid
      {
        const { branch, tables } = await newBranch()
        const order = await splitOrder(branch, tables[0])
        const [rp, rt] = await race(() => pay(order, order.checks[0], A, 'card'), () => api('POST', `/orders/${order.id}/transfer`, { tableId: tables[1].id }, B))
        const fresh = await db.customerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { checks: true } })
        const [src, dst] = await Promise.all([db.diningTable.findUniqueOrThrow({ where: { id: tables[0].id } }), db.diningTable.findUniqueOrThrow({ where: { id: tables[1].id } })])
        const events = await db.tillPayment.count({ where: { orderId: order.id } })
        check(`round ${round}: transfer and payment stay consistent`, () => {
          assert.equal(events, fresh.checks.filter((c) => c.status === 'paid').length)
          if (ok(rp)) assert.equal(events, 1)
          // a split bill is frozen, so the transfer is refused either way
          assert.equal(ok(rt), false); assert.equal(fresh.tableId, tables[0].id); assert.ok(src.seatedAt); assert.equal(dst.seatedAt, null)
        })
      }
      // 6. a manager approves the cash closing while a cashier takes cash
      {
        const { branch, tables } = await newBranch()
        const order = await splitOrder(branch, tables[0])
        const { businessDate } = require('../dist/services/orderSales')
        const day = businessDate(org.timezone).toISOString().slice(0, 10)
        const closing = await api('POST', '/cash-closing', { branchId: branch.id, closingDate: day, openingCash: 0, actualCashCounted: 0 }, A)
        assert.ok(ok(closing), JSON.stringify(closing.data))
        assert.ok(ok(await api('POST', `/cash-closing/${closing.data.id}/submit`, {}, A)))
        const [rp, ra] = await race(() => pay(order, order.checks[0], B), () => api('POST', `/cash-closing/${closing.data.id}/approve`, {}, approver), 200)
        const final = await db.cashClosing.findUniqueOrThrow({ where: { id: closing.data.id } })
        const cash = await db.tillPayment.count({ where: { orderId: order.id, method: 'cash' } })
        tally('closing approval vs cash payment', ok(ra) ? 'approval won' : ok(rp) ? 'payment won' : 'neither')
        check(`round ${round}: closing approval and a cash payment cannot both succeed`, () => {
          assert.ok(!(ok(rp) && ok(ra)), JSON.stringify([rp.data, ra.data]))
          if (ok(ra)) { assert.equal(final.status, 'approved'); assert.equal(cash, 0); assert.equal(rp.data.code, 'CLOSING_APPROVED') }
          else { assert.equal(ra.data.code, 'CLOSING_CHANGED'); assert.equal(cash, 1) }
        })
      }
      // 7. two cashiers spend the same gift card at the same moment
      {
        const { branch } = await newBranch()
        const card = await db.giftCard.create({ data: { organizationId: org.id, code: `GC-RACE-${branchNo}`, initialAmount: 116, balance: 116, issuedBranchId: branch.id, createdBy: users[0].id } })
        const takeaway = async (token) => (await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, token)).data
        const [o1, o2] = [await takeaway(A), await takeaway(B)]
        const spend = (o, token) => api('POST', `/orders/${o.id}/complete`, { payments: [{ method: 'gift_card', amount: 116, giftCardCode: card.code }] }, token)
        const [s1, s2] = await race(() => spend(o1, A), () => spend(o2, B))
        const after = await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })
        const redeemed = await db.giftCardTransaction.count({ where: { giftCardId: card.id, type: 'redeem' } })
        tally('same gift card twice', [s1, s2].filter(ok).length === 1 ? 'one paid, one refused' : 'unexpected')
        check(`round ${round}: a gift card spent twice at once pays only once`, () => {
          assert.equal([s1, s2].filter(ok).length, 1, JSON.stringify([s1.data, s2.data])); assert.equal(after.balance, 0); assert.equal(redeemed, 1)
          assert.equal([s1, s2].find((x) => !ok(x)).data.code, 'GIFT_CARD_BALANCE')
        })
      }
      // 8. the gateway delivers the success callback twice at the same moment
      {
        const { branch } = await newBranch()
        const o = (await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, A)).data
        const t = await api('POST', '/payments/terminal', { orderId: o.id }, A)
        assert.ok(ok(t), JSON.stringify(t.data))
        const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: t.data.id } })
        const deliver = (eventId) => { const raw = JSON.stringify({ eventId, type: 'payment.succeeded', providerRef: intent.providerRef, organizationId: org.id, amount: intent.amount, currency: intent.currency, merchantId: '' }); return fetch(`${base}/payments/callbacks/simulator`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signSimulatorEvent(org.id, raw) }, body: raw }).then(async (r) => ({ status: r.status, data: await r.json() })) }
        // same event id twice, and a second event id for the same payment
        const [c1, c2] = await race(() => deliver(`evt-${round}-a`), () => deliver(Math.random() < 0.5 ? `evt-${round}-a` : `evt-${round}-b`))
        const sales = await db.tillPayment.count({ where: { orderId: o.id, type: 'sale' } })
        const after = await db.customerOrder.findUniqueOrThrow({ where: { id: o.id } })
        tally('callback twice', [c1, c2].map((c) => c.data.outcome).sort().join('+'))
        check(`round ${round}: a callback delivered twice at once settles once`, () => {
          assert.ok(ok(c1) && ok(c2), JSON.stringify([c1.data, c2.data])); assert.equal(sales, 1); assert.equal(after.status, 'completed')
        })
      }
      // 9. a guest approves the QR payment while the cashier takes cash
      {
        const { branch, tables } = await newBranch()
        const o = (await api('POST', '/pos/orders', { branchId: branch.id, tableId: tables[0].id, orderType: 'dine_in', guestCount: 1, items: [{ dishId: dish.id, quantity: 1 }] }, A)).data
        await db.customerOrderItem.updateMany({ where: { orderId: o.id }, data: { status: 'served' } })
        const qr = await api('POST', `/public/checkout/tables/${tables[0].orderToken}/pay`, {})
        assert.ok(ok(qr), JSON.stringify(qr.data))
        const [online, cash] = await race(
          () => api('POST', `/public/payments/${qr.data.id}/simulate`, { t: qr.data.accessToken, outcome: 'approve' }),
          () => api('POST', `/orders/${o.id}/complete`, { paymentMethod: 'cash', amountTendered: o.totalAmount }, B), 60)
        const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: qr.data.id } })
        const sales = await db.tillPayment.count({ where: { orderId: o.id, type: 'sale' } })
        let refund = null
        if (intent.status === 'needs_review') refund = await api('POST', `/payments/${intent.id}/refund`, {}, approver)
        const settled = await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })
        tally('QR vs cash at the till', intent.status === 'succeeded' ? 'QR won' : intent.status === 'needs_review' ? 'cash won, QR refunded' : 'cash won, QR cancelled')
        check(`round ${round}: a QR payment racing a cash payment is never applied twice`, () => {
          assert.equal(sales, 1, JSON.stringify([online.data, cash.data, intent.status]))
          if (intent.status === 'succeeded') assert.ok(!ok(cash))
          else { assert.ok(ok(cash)); assert.ok(['cancelled', 'needs_review'].includes(intent.status)) }
          if (refund) { assert.ok(ok(refund), JSON.stringify(refund.data)); assert.equal(settled.refundStatus, 'refunded') }
        })
      }
    }
  } finally {
    if (server) await new Promise((r) => server.close(r))
    try { await require('../dist/config').prisma.$disconnect() } catch { /* not loaded */ }
    if (db) await db.$disconnect()
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.$disconnect()
  }
  console.log('Race outcomes:', JSON.stringify(outcomes))
  console.log(`${passed} concurrency checks passed, ${failed} failed; scratch database ${dbName} dropped.`)
  if (failed) process.exitCode = 1
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
