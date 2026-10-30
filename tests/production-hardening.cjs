// Real HTTP/database regressions for the 27 October audit. Never uses app data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createScratch } = require('./scratch-db.cjs');
const output = path.resolve(__dirname, '../../outputs/production-hardening-2026-10-28');
let scratch, db, appDb, server, uploadDir, passes = 0;
const storedFiles = [], results = [];
function check(name, verify) { verify(); passes++; results.push(name); console.log('PASS ' + name); }
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  scratch = await createScratch();
  const appUrl = new URL(scratch.url);
  appUrl.searchParams.set('connection_limit', '4');
  Object.assign(process.env, { DATABASE_URL: appUrl.toString(), NODE_ENV: 'test' });
  delete process.env.FOODSYNC_DEPLOYMENT_MODE;
  db = scratch.client();
  const app = require('../dist/app').default;
  appDb = require('../dist/config').prisma;
  const { signAccessToken } = require('../dist/utils/jwt');
  const { signSimulatorEvent } = require('../dist/services/payments/adapters');
  const { createIntent, intentByToken } = require('../dist/services/payments');
  const org = await db.organization.create({ data: { name: 'Synthetic hardening', requireTillForCash: false } });
  const foreign = await db.organization.create({ data: { name: 'Other synthetic tenant' } });
  const a = await db.branch.create({ data: { organizationId: org.id, code: 'A', name: 'Allowed' } });
  const b = await db.branch.create({ data: { organizationId: org.id, code: 'B', name: 'Restricted' } });
  const owner = await db.user.create({ data: { organizationId: org.id, email: 'owner@example.invalid', passwordHash: '!', firstName: 'QA', lastName: 'Owner' } });
  const staff = await db.user.create({ data: { organizationId: org.id, email: 'staff@example.invalid', passwordHash: '!', firstName: 'QA', lastName: 'Scoped' } });
  for (const [user, name] of [[owner, 'owner'], [staff, 'store_keeper']]) {
    const role = await db.role.create({ data: { organizationId: org.id, name, displayName: name } });
    await db.userRole.create({ data: { userId: user.id, roleId: role.id } });
    if (user === staff) for (const key of ['can_create_purchase_order', 'can_approve_purchase_order']) {
      const perm = await db.permission.create({ data: { key, module: 'purchase_orders' } });
      await db.rolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
    }
  }
  await db.userBranchAccess.create({ data: { userId: staff.id, organizationId: org.id, branchId: a.id } });
  const token = signAccessToken(staff.id, org.id, staff.email);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function api(method, route, body) {
    const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  }
  let poSeq = 0;
  const seedPO = (branch = a, status = 'draft') => db.purchaseOrder.create({ data: { organizationId: org.id, branchId: branch.id, poNo: `QA-${++poSeq}`, orderDate: new Date(), createdBy: owner.id, status, items: { create: { description: 'Original', quantity: 7 } } } });
  const body = (branchId = a.id, itemId) => ({ branchId, orderDate: '2026-10-28', items: [{ description: 'Replacement', quantity: 1, ...(itemId && { itemId }) }] });
  const restricted = await seedPO(b, 'submitted');
  const me = await api('GET', '/auth/me');
  check('fixture verifies branch A is the only assigned branch', () => assert.deepEqual(me.data.permissionMatrix.branchIds, [a.id]));
  for (const route of ['/purchase-orders', '/purchase-orders/pending-approval']) {
    const r = await api('GET', route);
    check(route + ' excludes restricted rows', () => { assert.equal(r.status, 200); assert.ok(!r.data.data.some(x => x.id === restricted.id)); });
    const filtered = await api('GET', route + '?branchId=' + b.id);
    check(route + ' rejects an explicit restricted filter', () => assert.equal(filtered.status, 403));
  }
  for (const [method, suffix, payload] of [['GET', '', undefined], ['PUT', '', body()], ['POST', '/submit', {}], ['POST', '/approve', {}], ['POST', '/reject', { rejectionReason: 'QA refusal' }], ['POST', '/void', { voidReason: 'QA void' }]]) {
    const r = await api(method, '/purchase-orders/' + restricted.id + suffix, payload);
    check(method + ' restricted PO ' + suffix + ' is forbidden', () => assert.equal(r.status, 403));
  }
  const restrictedState = await db.purchaseOrder.findUnique({ where: { id: restricted.id } });
  check('restricted PO remains unchanged', () => assert.equal(restrictedState.status, 'submitted'));
  assert.equal((await api('POST', '/purchase-orders', body(b.id))).status, 403);
  const foreignItem = await db.item.create({ data: { organizationId: foreign.id, code: 'SECRET', name: 'Private item' } });
  const localItem = await db.item.create({ data: { organizationId: org.id, code: 'LOCAL', name: 'Allowed item' } });
  const draft = await seedPO();
  for (const itemId of [foreignItem.id, 'nonexistent-item']) {
    const before = await db.purchaseOrder.count();
    const create = await api('POST', '/purchase-orders', body(a.id, itemId));
    const edit = await api('PUT', '/purchase-orders/' + draft.id, { items: body(a.id, itemId).items });
    check('foreign or missing inventory reference is rejected atomically: ' + itemId.slice(0, 5), () => { assert.equal(create.status, 400); assert.equal(edit.status, 400); });
    assert.equal(await db.purchaseOrder.count(), before);
    assert.equal((await db.purchaseOrderItem.findMany({ where: { purchaseOrderId: draft.id } }))[0].description, 'Original');
  }
  for (const branchId of [b.id, 'missing-branch']) {
    const r = await api('PUT', '/purchase-orders/' + draft.id, { branchId, items: body().items });
    check('invalid branch edit preserves original lines', () => assert.ok([403, 404].includes(r.status)));
    assert.equal((await db.purchaseOrderItem.findMany({ where: { purchaseOrderId: draft.id } }))[0].description, 'Original');
  }
  // Fail after child deletion and after replacement insertion, not just input validation.
  await db.$executeRawUnsafe(`CREATE FUNCTION qa_fail_line() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.description = 'QA_FAIL_INSERT' THEN RAISE EXCEPTION 'QA injected child failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER qa_fail_line BEFORE INSERT ON "PurchaseOrderItem" FOR EACH ROW EXECUTE FUNCTION qa_fail_line()`);
  await db.$executeRawUnsafe(`CREATE FUNCTION qa_fail_header() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.notes = 'QA_FAIL_HEADER' THEN RAISE EXCEPTION 'QA injected header failure'; END IF; RETURN NEW; END $$`);
  await db.$executeRawUnsafe(`CREATE TRIGGER qa_fail_header BEFORE UPDATE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION qa_fail_header()`);
  for (const payload of [{ items: [{ description: 'QA_FAIL_INSERT', quantity: 1 }] }, { notes: 'QA_FAIL_HEADER', items: body().items }]) {
    const r = await api('PUT', '/purchase-orders/' + draft.id, payload);
    const saved = await db.purchaseOrder.findUnique({ where: { id: draft.id }, include: { items: true } });
    check('injected database failure rolls back the entire edit', () => { assert.equal(r.status, 500); assert.equal(saved.notes, null); assert.equal(saved.items.length, 1); assert.equal(saved.items[0].description, 'Original'); assert.equal(saved.items[0].quantity, 7); });
  }
  const valid = await api('PUT', '/purchase-orders/' + draft.id, { items: body(a.id, localItem.id).items });
  check('valid same-tenant edit succeeds', () => { assert.equal(valid.status, 200); assert.equal(valid.data.items[0].item.id, localItem.id); });
  assert.equal((await api('POST', '/purchase-orders/' + draft.id + '/submit', {})).status, 200);
  assert.equal((await api('POST', '/purchase-orders/' + draft.id + '/approve', {})).status, 200);
  const approvedEdit = await api('PUT', '/purchase-orders/' + draft.id, { notes: 'Too late' });
  check('approved PO refuses subsequent edits', () => assert.equal(approvedEdit.status, 400));
  const creations = await Promise.all(Array.from({ length: 4 }, () => api('POST', '/purchase-orders', body())));
  check('concurrent PO creation allocates four unique numbers', () => { assert.ok(creations.every(r => r.status === 201)); assert.equal(new Set(creations.map(r => r.data.poNo)).size, 4); });
  const racing = await seedPO();
  let unlock, locked;
  const ready = new Promise(r => locked = r), release = new Promise(r => unlock = r);
  const transition = db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${racing.id} FOR UPDATE`;
    locked(); await release;
    await tx.purchaseOrder.update({ where: { id: racing.id }, data: { status: 'submitted' } });
  }, { timeout: 15000 });
  await ready;
  const editRace = api('PUT', '/purchase-orders/' + racing.id, { items: body().items });
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const rows = await db.$queryRaw`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%PurchaseOrder%'`;
      if (rows.length) { waiting = true; break; } await delay(20);
    }
    assert.ok(waiting, 'edit must actually wait on the transition lock');
  } finally { unlock(); }
  await transition;
  const raced = await editRace;
  check('an edit waiting for a transition rechecks the document state', () => assert.equal(raced.status, 400));
  assert.equal((await db.purchaseOrderItem.findMany({ where: { purchaseOrderId: racing.id } }))[0].description, 'Original');

  const category = await db.menuCategory.create({ data: { organizationId: org.id, name: 'Meals' } });
  const dish = await db.dish.create({ data: { organizationId: org.id, categoryId: category.id, name: 'Meal', price: 25 } });
  await db.commerceSettings.create({ data: { organizationId: org.id, paymentAdapter: 'simulator', paymentEnvironment: 'sandbox', merchantId: 'QA-merchant', updatedBy: owner.id } });
  const order = await db.customerOrder.create({ data: { organizationId: org.id, branchId: a.id, orderNo: 1, orderType: 'takeaway', status: 'open', acceptedAt: new Date(), subtotal: 25, itemsTotal: 25, totalAmount: 25, items: { create: { dishId: dish.id, dishName: dish.name, quantity: 1, unitPrice: 25, lineTotal: 25, status: 'accepted' } } } });
  const input = { organizationId: org.id, branchId: a.id, orderId: order.id, channel: 'qr' };
  const first = await createIntent(input), second = await createIntent(input);
  await intentByToken(first.intent.id, first.accessToken); await intentByToken(second.intent.id, second.accessToken);
  check('payment retries preserve both distributed checkout links', () => { assert.equal(first.intent.id, second.intent.id); assert.equal(first.accessToken, second.accessToken); });
  await assert.rejects(intentByToken(first.intent.id, 'wrong-token'), e => e.code === 'NOT_FOUND');
  const legacy = crypto.randomBytes(24).toString('base64url');
  await db.paymentIntent.update({ where: { id: first.intent.id }, data: { accessTokenHash: crypto.createHash('sha256').update(legacy).digest('hex') } });
  const retry = await createIntent(input);
  const legacyLookup = await intentByToken(first.intent.id, legacy), retriedLookup = await intentByToken(first.intent.id, retry.accessToken);
  check('existing legacy random links survive deployment and reuse', () => { assert.equal(legacyLookup.id, first.intent.id); assert.equal(retriedLookup.id, first.intent.id); });
  async function callback(extra) {
    const raw = JSON.stringify({ eventId: crypto.randomUUID(), type: 'payment.succeeded', organizationId: org.id, providerRef: first.intent.providerRef, amount: 25, currency: first.intent.currency, merchantId: 'QA-merchant', ...extra });
    const r = await fetch(base + '/payments/callbacks/simulator', { method: 'POST', headers: { 'Content-Type': 'application/json', ...signSimulatorEvent(org.id, raw) }, body: raw });
    return { status: r.status, data: await r.json() };
  }
  for (const amount of [undefined, null, '25', -1, 0, 25.001]) {
    const r = await callback({ amount });
    check('malformed signed callback amount is refused: ' + String(amount), () => assert.equal(r.status, 401));
    assert.equal((await db.customerOrder.findUnique({ where: { id: order.id } })).status, 'open');
  }
  const paid = await callback({});
  check('correct signed payment still settles once', () => { assert.equal(paid.status, 200); assert.equal(paid.data.outcome, 'settled'); });
  await db.paymentIntent.update({ where: { id: first.intent.id }, data: { refundStatus: 'pending' } });
  for (const extra of [{ amount: 999 }, { currency: 'WRONG' }, { merchantId: 'wrong' }]) {
    const r = await callback({ type: 'refund.succeeded', ...extra });
    const saved = await db.paymentIntent.findUnique({ where: { id: first.intent.id } });
    check('refund mismatches do not alter refund totals: ' + Object.keys(extra)[0], () => { assert.equal(r.data.outcome, 'mismatch'); assert.equal(saved.refundedAmount, 0); assert.equal(saved.refundStatus, 'pending'); });
  }
  assert.equal((await callback({ type: 'refund.succeeded' })).data.outcome, 'refund.succeeded');
  assert.equal((await callback({ type: 'refund.failed', reason: 'late failure' })).data.outcome, 'already_refunded');
  const refunded = await db.paymentIntent.findUnique({ where: { id: first.intent.id } });
  check('a valid refund succeeds and a late failure cannot undo it', () => { assert.equal(refunded.refundedAmount, 25); assert.equal(refunded.refundStatus, 'refunded'); });

  const { UPLOAD_ROOT } = require('../dist/middleware/upload'); uploadDir = path.join(UPLOAD_ROOT, org.id);
  async function upload(name, type, bytes) {
    const form = new FormData(); form.set('branchId', a.id); form.set('file', new Blob([bytes], { type }), name);
    const r = await fetch(base + '/documents/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    return { status: r.status, data: await r.json() };
  }
  for (const [name, type, bytes] of [['fake.html', 'application/pdf', '<html>QA</html>'], ['fake.pdf', 'application/pdf', '<html>QA</html>'], ['fake.png', 'image/png', 'not a png'], ['cut.pdf', 'application/pdf', '%PDF-1.7\ntruncated']]) {
    const r = await upload(name, type, bytes);
    check('spoofed or truncated upload rejected: ' + name, () => assert.equal(r.status, 400));
    assert.equal(await db.document.count({ where: { organizationId: org.id } }), 0);
    assert.deepEqual(await fs.readdir(uploadDir).catch(() => []), []);
  }
  const pdf = await new Promise(resolve => { const PDF = require('pdfkit'), doc = new PDF(), chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.text('Synthetic audit document'); doc.end(); });
  const good = await upload('valid.PDF', 'application/pdf', pdf);
  assert.equal(good.status, 201);
  const document = await db.document.findUnique({ where: { id: good.data.id } }); storedFiles.push(document.filePath);
  const download = await fetch(base + `/documents/${document.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  check('real PDF uploads and downloads with safe headers', () => { assert.equal(download.status, 200); assert.ok(download.headers.get('content-type').startsWith('application/pdf')); assert.ok(download.headers.get('content-disposition').startsWith('attachment;')); assert.equal(download.headers.get('x-content-type-options'), 'nosniff'); });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf);
  // An old record with an unsafe original extension must not reset the MIME header.
  await db.document.update({ where: { id: document.id }, data: { originalFilename: 'legacy.html', fileType: 'application/pdf' } });
  const old = await fetch(base + `/documents/${document.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
  check('legacy filenames cannot force HTML response types', () => assert.ok(old.headers.get('content-type').startsWith('application/pdf')));
  const noRole = await db.user.create({ data: { organizationId: org.id, email: 'no-role@example.invalid', passwordHash: '!', firstName: 'No', lastName: 'Role' } });
  const deniedDelete = await fetch(base + `/documents/${document.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${signAccessToken(noRole.id, org.id, noRole.email)}` } });
  const stillPresent = await db.document.count({ where: { id: document.id } });
  check('a user without roles cannot delete another uploader\'s document', () => { assert.equal(deniedDelete.status, 403); assert.equal(stillPresent, 1); });
  await fs.access(document.filePath);
  const adminDelete = await fetch(base + `/documents/${document.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${signAccessToken(owner.id, org.id, owner.email)}` } });
  const removed = await db.document.count({ where: { id: document.id } });
  check('organization administrators can remove another uploader\'s document', () => { assert.equal(adminDelete.status, 200); assert.equal(removed, 0); });
  // The same app is now an enrolled local branch. Block every outgoing HTTP
  // address except its loopback listener: these PO operations must not need cloud.
  await db.branchRuntime.create({ data: { id: 'local', nodeId: crypto.randomUUID(), organizationId: org.id, branchId: a.id, numberSeries: 'P1' } });
  process.env.FOODSYNC_DEPLOYMENT_MODE = 'branch';
  const realFetch = global.fetch;
  global.fetch = (url, options) => {
    if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('QA offline: outgoing network unavailable');
    return realFetch(url, options);
  };
  try {
    const local = await api('POST', '/purchase-orders', body(a.id, localItem.id));
    check('branch runtime creates a PO without any cloud HTTP access', () => { assert.equal(local.status, 201); assert.ok(local.data.poNo.includes('-P1-')); });
    const denied = await api('POST', '/purchase-orders', body(a.id, foreignItem.id));
    check('local branch also rejects foreign-tenant item references', () => assert.equal(denied.status, 400));
    const failed = await api('PUT', '/purchase-orders/' + local.data.id, { notes: 'QA_FAIL_HEADER', items: [{ description: 'Must roll back offline', quantity: 9 }] });
    const saved = await db.purchaseOrder.findUnique({ where: { id: local.data.id }, include: { items: true } });
    check('local branch rolls back a database failure while cloud is unavailable', () => { assert.equal(failed.status, 500); assert.equal(saved.notes, null); assert.equal(saved.items[0].description, 'Replacement'); assert.equal(saved.items[0].quantity, 1); });
    const restrictedLocal = await api('GET', '/purchase-orders/' + restricted.id);
    check('local branch retains assigned-branch authorization', () => assert.equal(restrictedLocal.status, 403));
  } finally { global.fetch = realFetch; delete process.env.FOODSYNC_DEPLOYMENT_MODE; }
  console.log(`${passes} production hardening checks passed.`);
})().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(r => server.close(r));
  for (const file of storedFiles) await fs.unlink(file).catch(() => {});
  if (uploadDir) await fs.rmdir(uploadDir).catch(() => {});
  await db?.$disconnect(); await appDb?.$disconnect(); await scratch?.drop();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'targeted-results.json'), JSON.stringify({ passed: passes, failed: !!process.exitCode, scratchRemoved: !!scratch, results }, null, 2));
});
