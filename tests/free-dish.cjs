// Real PostgreSQL + HTTP integration tests, including concurrent requests.
// Uses a dedicated scratch database; never changes the configured database.
require('dotenv/config')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const { PrismaClient } = require('@prisma/client')
const domain = require('../dist/utils/freeDish')
let passed = 0
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`) }
const guest = { fullName: '  Ada Guest  ', country: 'GB', dialingCountry: 'GB', whatsapp: '07911 123423', dateOfBirth: '1990-02-28', email: '  ADA@EXAMPLE.COM ' }
check('normalizes phone, name, email; country differs from dialing country', () => { const g = domain.normalizeGuest({ ...guest, country: 'PK' }, '2026-10-26'); assert.equal(g.normalizedWhatsApp, '+447911123423'); assert.equal(g.normalizedEmail, 'ada@example.com'); assert.equal(g.fullName, 'Ada Guest'); assert.equal(g.country, 'PK') })
check('rejects impossible, future, ancient birth dates and invalid country / phone', () => { for (const b of [{ dateOfBirth: '2025-02-29' }, { dateOfBirth: '2027-01-01' }, { dateOfBirth: '1900-01-01' }, { country: 'XX' }, { whatsapp: '123' }]) assert.throws(() => domain.normalizeGuest({ ...guest, ...b }, '2026-10-26')) })
check('expiry boundary is exclusive and redeemed state survives expiry', () => { const now = new Date(); assert.equal(domain.voucherState({ status: 'issued', expiresAt: now }, now), 'expired'); assert.equal(domain.voucherState({ status: 'issued', expiresAt: null }, now), 'valid'); assert.equal(domain.voucherState({ status: 'redeemed', expiresAt: now }, now), 'redeemed') })
check('business timezone boundaries include daylight saving', () => { assert.equal(domain.dayBoundary('2026-10-26', 'Asia/Karachi').toISOString(), '2026-10-25T19:00:00.000Z'); assert.equal(domain.dayBoundary('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z'); assert.equal(domain.dayBoundary('2026-03-09', 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z') })
process.env.PUBLIC_APP_URL = 'https://guest.example.test'
check('strict scanner parsing supports compact code and only configured URL', () => { assert.equal(domain.parseVoucher('fdabcdefghjk'), 'FD-ABCDE-FGHJK'); assert.equal(domain.parseVoucher('https://guest.example.test/fd/v/FD-ABCDE-FGHJK'), 'FD-ABCDE-FGHJK'); for (const input of ['other text', 'https://evil.test/fd/v/FD-ABCDE-FGHJK', 'https://guest.example.test/fd/v/FD-ABCDE-FGHJK?x=1']) assert.throws(() => domain.parseVoucher(input)); for (let i = 0; i < 100; i++) assert.match(domain.voucherCode(), /^FD-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/) })
if (process.argv.includes('--unit')) process.exit(0)

const baseUrl = process.env.DATABASE_URL
if (!baseUrl) throw new Error('DATABASE_URL is required')
const dbName = `fs_free_dish_${process.pid}`
const adminUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1')
const scratchUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`)
async function main() {
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } })
  let server, db, configDb, created = false
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`); created = true
    const prismaBin = path.join(__dirname, '..', 'node_modules', 'prisma', 'build', 'index.js')
    // Apply the host schema without Free Dish, then the actual incremental SQL migration.
    const fs = require('node:fs'), schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8')
    const baseline = schema.slice(0, schema.indexOf('model FreeDishItem')).replace(/^\s*freeDish(?:Items|Qrs|Submissions)\s+FreeDish\w+\[\]\r?\n/gm, '')
    const baselineFile = path.join(__dirname, '../prisma/free-dish-test-baseline.prisma')
    fs.writeFileSync(baselineFile, baseline)
    try { execFileSync(process.execPath, [prismaBin, 'db', 'push', '--skip-generate', '--schema', baselineFile], { env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: 'pipe' }) } finally { fs.unlinkSync(baselineFile) }
    execFileSync(process.execPath, [prismaBin, 'db', 'execute', '--file', path.join(__dirname, '../prisma/additions/20261026-free-dish.sql'), '--schema', path.join(__dirname, '../prisma/schema.prisma')], { env: { ...process.env, DATABASE_URL: scratchUrl }, stdio: 'pipe' })
    process.env.DATABASE_URL = scratchUrl
    process.env.FREE_DISH_RATE_LIMIT = '1000'
    db = new PrismaClient({ datasources: { db: { url: scratchUrl } } })
    const org = await db.organization.create({ data: { name: 'Free Dish test', timezone: 'Asia/Karachi' } })
    const foreignOrg = await db.organization.create({ data: { name: 'Other organization' } })
    const branch = await db.branch.create({ data: { organizationId: org.id, name: 'Main', code: 'MAIN' } })
    const otherBranch = await db.branch.create({ data: { organizationId: org.id, name: 'Other', code: 'OTHER' } })
    const section = await db.branchSection.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Counter A' } })
    const otherSection = await db.branchSection.create({ data: { organizationId: org.id, branchId: otherBranch.id, name: 'Counter B' } })
    for (const key of ['free_dish_manage', 'free_dish_redeem']) await db.permission.create({ data: { key, module: 'free_dish' } })
    const { signAccessToken } = require('../dist/utils/jwt')
    const staff = async (name, permissions, organizationId = org.id, scoped = null) => {
      const user = await db.user.create({ data: { organizationId, email: name + '@test.invalid', firstName: name, lastName: 'Tester', passwordHash: 'unused' } })
      const role = await db.role.create({ data: { organizationId, name, displayName: name } })
      await db.userRole.create({ data: { userId: user.id, roleId: role.id } })
      for (const key of permissions) { const p = await db.permission.findUnique({ where: { key } }); await db.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }) }
      if (scoped) await db.userBranchAccess.create({ data: { userId: user.id, branchId: scoped, organizationId } })
      return { user, token: signAccessToken(user.id, organizationId, user.email) }
    }
    const manager = await staff('manager', ['free_dish_manage']), collector = await staff('collector', ['free_dish_redeem']), restricted = await staff('restricted', ['free_dish_redeem', 'free_dish_manage'], org.id, otherBranch.id), foreign = await staff('foreign', ['free_dish_redeem', 'free_dish_manage'], foreignOrg.id)
    const app = require('../dist/app').default; configDb = require('../dist/config').prisma
    server = await new Promise((resolve, reject) => { const s = app.listen(process.argv.includes('--preview') ? 4000 : 0, () => resolve(s)); s.once('error', reject) })
    const base = `http://127.0.0.1:${server.address().port}/api/v1`
    const api = async (method, url, body, who) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(who && { Authorization: 'Bearer ' + who.token }) }, ...(body && { body: JSON.stringify(body) }) })
      const raw = await r.text(); let data; try { data = JSON.parse(raw) } catch { data = raw }
      return { status: r.status, data, raw, headers: r.headers }
    }
    const create = async (url, body, who = manager) => { const r = await api('POST', url, body, who); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data }
    const item = await create('/free-dish/items', { name: 'Fruit bowl' })
    const offerBody = { name: 'Lunch offer', branchId: branch.id, sectionId: section.id, itemId: item.id, quantity: 3, voucherValidDays: 2 }
    const q = await create('/free-dish/qr-codes', offerBody)
    const submit = b => api('POST', `/public/free-dish/qr/${q.publicToken}/submit`, b)
    const issued = await submit(guest); assert.equal(issued.status, 200); const code = issued.data.voucherCode
    check('registration returns minimal public data and snapshots', () => { assert.equal(issued.data.quantity, 3); for (const k of ['fullName', 'normalizedWhatsApp', 'normalizedEmail', 'dateOfBirth', 'organizationId', 'redeemedBy']) assert.equal(issued.data[k], undefined) })
    const original = await db.freeDishSubmission.findUnique({ where: { voucherCode: code } })
    check('expiry is exactly configured 24 hour days', () => assert.equal(+original.expiresAt - +original.createdAt, 2 * 86400000))
    const repeat = await submit({ ...guest, fullName: 'Changed name', email: 'changed@example.test' })
    const after = await db.freeDishSubmission.findUnique({ where: { voucherCode: code } })
    check('repeat phone returns same voucher without modifying guest or expiry', () => { assert.equal(repeat.data.voucherCode, code); assert.deepEqual(after, original) })
    const dupEmail = await submit({ ...guest, whatsapp: '07911123424' })
    check('email cannot issue voucher for another phone', () => assert.equal(dupEmail.data.code, 'DUPLICATE_EMAIL'))
    const b = { ...guest, whatsapp: '07911123425', email: 'b@example.test' }; const bv = await submit(b)
    const conflict = await submit({ ...guest, email: b.email })
    check('conflicting identifiers reject instead of selecting a voucher', () => assert.equal(conflict.data.code, 'DUPLICATE_EMAIL'))
    const c = { ...guest, whatsapp: '07911123426', email: 'c@example.test' }
    const simultaneous = await Promise.all(Array.from({ length: 8 }, () => submit(c)))
    check('concurrent duplicate registration issues exactly one voucher', () => { assert(simultaneous.every(r => r.status === 200)); assert.equal(new Set(simultaneous.map(r => r.data.voucherCode)).size, 1) })
    const mixed = await Promise.all([submit({ ...guest, whatsapp: '07911123427', email: 'race@example.test' }), submit({ ...guest, whatsapp: '07911123428', email: 'race@example.test' })])
    check('concurrent duplicate email deterministically permits one phone', () => { assert.equal(mixed.filter(r => r.status === 200).length, 1); assert.equal(mixed.find(r => r.status !== 200).data.code, 'DUPLICATE_EMAIL') })
    const verify = await api('POST', '/free-dish/verify', { input: code.replaceAll('-', '') }, collector)
    check('scanning verifies without redeeming', () => { assert.equal(verify.data.state, 'valid'); assert.equal(verify.data.fullName, 'Ada Guest'); assert.equal(verify.data.status, 'issued') })
    const denied = await api('POST', '/free-dish/redeem', { input: code }, manager), collectorDenied = await api('GET', '/free-dish/items', null, collector), anonymous = await api('GET', '/free-dish/submissions')
    check('management and redemption permissions are separate; staff APIs require login', () => { assert.equal(denied.status, 403); assert.equal(collectorDenied.status, 403); assert.equal(anonymous.status, 401) })
    const isolated = await api('POST', '/free-dish/verify', { input: code }, foreign), wrongBranch = await api('POST', '/free-dish/verify', { input: code }, restricted), wrongRedemption = await api('POST', '/free-dish/redeem', { input: code }, restricted)
    check('tenant and branch isolation hides all private voucher data', () => { assert.equal(isolated.status, 404); assert.equal(wrongBranch.data.code, 'BRANCH_FORBIDDEN'); assert.equal(wrongRedemption.status, 403); assert(!wrongBranch.raw.includes('Ada')); assert(!wrongBranch.raw.includes('@example')) })
    const invalidSection = await api('POST', '/free-dish/qr-codes', { ...offerBody, sectionId: otherSection.id }, manager)
    check('offer section must belong to branch', () => assert.equal(invalidSection.data.code, 'VALIDATION_ERROR'))
    const locked = await api('PUT', '/free-dish/qr-codes/' + q.id, { ...offerBody, quantity: 4 }, manager)
    check('server locks promised offer details after registration', () => assert.equal(locked.data.code, 'QR_IN_USE'))
    await api('PUT', '/free-dish/qr-codes/' + q.id, { ...offerBody, voucherValidDays: null }, manager)
    const future = await submit({ ...guest, whatsapp: '07911123429', email: 'future@example.test' })
    check('validity change affects only future vouchers', () => { assert.equal(future.data.expiresAt, null); assert(issued.data.expiresAt) })
    const races = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/free-dish/redeem', { input: code }, collector)))
    check('concurrent redemption: exactly one succeeds; rest already redeemed', () => { assert.equal(races.filter(r => r.status === 200).length, 1); assert(races.filter(r => r.status !== 200).every(r => r.data.code === 'ALREADY_REDEEMED')) })
    check('redemption timestamp is UTC even when PostgreSQL runs in a different timezone', () => assert(Math.abs(Date.parse(races.find(r => r.status === 200).data.redeemedAt) - Date.now()) < 60000))
    const audits = await db.auditLog.count({ where: { resourceId: original.id, action: 'redeem_free_dish' } })
    check('redemption audit event committed exactly once', () => assert.equal(audits, 1))
    await db.freeDishSubmission.update({ where: { voucherCode: bv.data.voucherCode }, data: { expiresAt: new Date(Date.now() - 1000) } })
    const expired = await api('POST', '/free-dish/redeem', { input: bv.data.voucherCode }, collector)
    check('expired voucher cannot redeem', () => assert.equal(expired.data.code, 'EXPIRED'))
    const expiredRepeat = await submit(b), redeemedRepeat = await submit(guest)
    check('expired and redeemed vouchers are never replaced', () => { assert.equal(expiredRepeat.data.voucherCode, bv.data.voucherCode); assert.equal(expiredRepeat.data.state, 'expired'); assert.equal(redeemedRepeat.data.voucherCode, code); assert.equal(redeemedRepeat.data.state, 'redeemed') })
    await api('PUT', '/free-dish/items/' + item.id, { name: 'Renamed', isActive: false }, manager)
    const inactiveItem = await submit({ ...guest, whatsapp: '07911123430', email: 'inactive-item@example.test' })
    check('inactive item does not close existing offers; promised snapshots persist', () => { assert.equal(inactiveItem.status, 200); assert.equal((races.find(r => r.status === 200)).data.itemName, 'Fruit bowl') })
    const inactiveNew = await api('POST', '/free-dish/qr-codes', { ...offerBody, name: 'Blocked' }, manager)
    check('inactive item cannot be selected for a new offer', () => assert.equal(inactiveNew.data.code, 'VALIDATION_ERROR'))
    const summary = await api('GET', '/free-dish/submissions?status=waiting&pageSize=1&qrId=' + q.id, null, manager)
    check('status filters table only; quantities differ from redeemed vouchers', () => { assert.equal(summary.data.data.length, 1); assert.equal(summary.data.metrics.redeemedVouchers, 1); assert.equal(summary.data.metrics.itemUnitsGiven, 3); assert.equal(summary.data.metrics.expired, 1); assert(summary.data.total > 1); assert(summary.data.data.every(v => v.state === 'valid')) })
    const filtered = await api('GET', '/free-dish/submissions?search=inactive-item', null, manager), phoneSearch = await api('GET', '/free-dish/submissions?search=07911%20123430', null, manager), scopedList = await api('GET', '/free-dish/submissions', null, restricted)
    check('search and branch filters apply to summary and paginated records', () => { assert.equal(filtered.data.metrics.registrations, 1); assert.equal(phoneSearch.data.total, 1); assert.equal(scopedList.data.total, 0); assert.equal(scopedList.data.metrics.registrations, 0) })
    const historic = new Date('2026-01-01T20:00:00Z')
    await db.freeDishSubmission.update({ where: { voucherCode: inactiveItem.data.voucherCode }, data: { createdAt: historic } })
    const dateFilter = await api('GET', '/free-dish/submissions?from=2026-01-02&to=2026-01-02&search=inactive-item', null, manager)
    const excludedDate = await api('GET', '/free-dish/submissions?from=2026-01-01&to=2026-01-01&search=inactive-item', null, manager)
    check('date filters follow business timezone across UTC date boundary', () => { assert.equal(dateFilter.data.total, 1); assert.equal(dateFilter.data.metrics.registrations, 1); assert.equal(excludedDate.data.total, 0); assert.equal(excludedDate.data.metrics.registrations, 0) })
    const csv = await api('GET', '/free-dish/submissions?format=csv&pageSize=1&status=waiting', null, manager)
    const excel = await api('GET', '/free-dish/submissions?format=excel&search=inactive-item', null, manager), pdf = await api('GET', '/free-dish/submissions?format=pdf&search=inactive-item', null, manager)
    check('exports use all filtered rows independently of pagination', () => { assert.equal(csv.status, 200); assert(csv.raw.includes('inactive-item@example.test')); assert(csv.raw.split('\r\n').length > 2); assert(!csv.raw.includes(code)); assert(excel.headers.get('content-type').includes('spreadsheet')); assert(pdf.raw.startsWith('%PDF')) })
    const datedExport = await api('GET', '/free-dish/submissions?format=csv&from=2026-01-01&to=2026-01-01&search=inactive-item', null, manager)
    check('export date filters match table and summary', () => assert(!datedExport.raw.includes('inactive-item@example.test')))
    const realCode = domain.voucherCode
    let collisions = 0
    domain.voucherCode = () => { collisions++; return collisions === 1 ? code : realCode() }
    const collision = await submit({ ...guest, whatsapp: '07911123434', email: 'collision@example.test' })
    domain.voucherCode = realCode
    check('rare voucher-code collision retries without duplicate issuance', () => { assert.equal(collision.status, 200); assert.notEqual(collision.data.voucherCode, code); assert.equal(collisions, 2) })
    // Hold the voucher row so redemption starts while valid, waits, then expires.
    const expiresDuringWait = new Date(Date.now() + 3000)
    await db.freeDishSubmission.update({ where: { voucherCode: collision.data.voucherCode }, data: { expiresAt: expiresDuringWait } })
    let pending, sawValid = false, notifyVerified
    const verifiedWhileLocked = new Promise(resolve => { notifyVerified = resolve })
    const realState = domain.voucherState
    domain.voucherState = (v, ...args) => { const result = realState(v, ...args); if (v.voucherCode === collision.data.voucherCode && result === 'valid') { sawValid = true; notifyVerified() } return result }
    try {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "FreeDishSubmission" WHERE "voucherCode" = ${collision.data.voucherCode} FOR UPDATE`
        pending = api('POST', '/free-dish/redeem', { input: collision.data.voucherCode }, collector)
        await Promise.race([verifiedWhileLocked, new Promise((_, reject) => setTimeout(() => reject(new Error('Request did not verify before expiry')), 2500))])
        await new Promise(resolve => setTimeout(resolve, Math.max(0, +expiresDuringWait - Date.now() + 100)))
      }, { timeout: 10000 })
    } finally { domain.voucherState = realState }
    const expiryAfterWait = await pending
    check('expiry is checked at mutation after waiting for a row lock', () => { assert(sawValid); assert.equal(expiryAfterWait.data.code, 'EXPIRED') })
    await db.branch.update({ where: { id: branch.id }, data: { isActive: false } })
    const branchClosed = await submit({ ...guest, whatsapp: '07911123431', email: 'closed-branch@example.test' })
    check('disabled branch blocks registration', () => assert.equal(branchClosed.data.code, 'OFFER_CLOSED'))
    await db.branch.update({ where: { id: branch.id }, data: { isActive: true } })
    await api('DELETE', '/free-dish/qr-codes/' + q.id, null, manager)
    const closed = await submit({ ...guest, whatsapp: '07911123432', email: 'closed@example.test' }), stillValid = await api('POST', '/free-dish/verify', { input: future.data.voucherCode }, collector)
    check('deleting used QR closes offer but preserves unexpired vouchers', () => { assert.equal(closed.data.code, 'OFFER_CLOSED'); assert.equal(stillValid.data.state, 'valid') })
    const redeemAfterClose = await api('POST', '/free-dish/redeem', { input: future.data.voucherCode }, collector)
    check('no-expiry voucher remains redeemable after QR closure and item deactivation', () => assert.equal(redeemAfterClose.status, 200))
    const itemDelete = await api('DELETE', '/free-dish/items/' + item.id, null, manager)
    check('referenced item is deactivated instead of removed', () => assert.equal(itemDelete.data.isActive, false))
    process.env.FREE_DISH_RATE_LIMIT = '1'
    const limited = await submit(guest)
    check('database-backed rate limiter returns stable error and retry header', () => { assert.equal(limited.status, 429); assert.equal(limited.data.code, 'TOO_MANY_ATTEMPTS'); assert(Number(limited.headers.get('retry-after')) > 0) })
    console.log(`\n${passed} Free Dish checks passed`)
    if (process.argv.includes('--preview')) {
      process.env.FREE_DISH_RATE_LIMIT = '1000'
      const pi = await create('/free-dish/items', { name: 'Welcome dessert' })
      const pq = await create('/free-dish/qr-codes', { ...offerBody, name: 'Welcome', itemId: pi.id, voucherValidDays: 7, quantity: 2 })
      const pv = await api('POST', `/public/free-dish/qr/${pq.publicToken}/submit`, { ...guest, whatsapp: '07911123433', email: 'preview@example.test' })
      console.log('PREVIEW registration: http://localhost:3106/fd/' + pq.publicToken)
      console.log('PREVIEW voucher: http://localhost:3106/fd/v/' + pv.data.voucherCode)
      console.log('Send any stdin input to stop and delete the disposable preview database.')
      await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve) }); process.stdin.pause()
    }
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    await configDb?.$disconnect(); await db?.$disconnect()
    if (created) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await admin.$disconnect()
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
