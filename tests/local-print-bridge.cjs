// PC print bridge: real HTTP + real TCP against simulated printers, disk
// journal recovery, and the browser security boundary. No database or LAN.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), http = require('node:http'), net = require('node:net'), os = require('node:os'), path = require('node:path')
const { createBridge, openJournal, prune, readConfig, saveJournal, sendPrinter, Spool } = require('../scripts/local-print-bridge.cjs')
let checks = 0
const check = (label, fn) => { fn(); checks++; console.log('PASS ' + label) }
const folders = [], servers = []
const tempFile = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodsync-bridge-')); folders.push(dir); return path.join(dir, 'journal.json') }
const listen = server => new Promise(resolve => { servers.push(server); server.listen(0, '127.0.0.1', () => resolve(server.address().port)) })
const delay = ms => new Promise(r => setTimeout(r, ms))

// ESP32-S3 raw mode: reads at most 4 KB, drains it to USB, then reads more
// (TCP backpressure paces the sender), and closes after the sender's EOF.
function esp32({ drainMs = 2 } = {}) {
  const jobs = []
  let open = 0, overlap = false
  const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: false }, socket => {
    if (++open > 1) overlap = true
    const chunks = []
    socket.on('data', chunk => {
      socket.pause()
      for (let i = 0; i < chunk.length; i += 4096) chunks.push(chunk.subarray(i, i + 4096))
      setTimeout(() => socket.resume(), drainMs)
    })
    socket.on('end', () => setTimeout(() => { jobs.push(Buffer.concat(chunks)); open--; socket.end() }, drainMs))
    socket.on('error', () => { open-- })
  })
  return { server, jobs, overlapped: () => overlap }
}
const toLoopback = port => (request, bytes) => sendPrinter({ host: '127.0.0.1', port }, bytes, { connectTimeout: 1000 })
const job = (payload, extra = {}) => ({ jobId: crypto.randomUUID(), printerId: 'net-test', host: '192.168.1.50', port: 9100, payload: payload.toString('base64'), label: 'Receipt #1', ...extra })
// A long 80 mm raster receipt: GS v 0 bands of 128 rows, 72 bytes per row.
function longRaster(rows) {
  const parts = [Buffer.from([0x1b, 0x40])]
  for (let y = 0; y < rows; y += 128) { const h = Math.min(128, rows - y); parts.push(Buffer.from([0x1d, 0x76, 0x30, 0, 72, 0, h & 0xff, h >> 8]), crypto.randomBytes(72 * h)) }
  parts.push(Buffer.from([0x1b, 0x64, 4, 0x1d, 0x56, 0x01]))
  return Buffer.concat(parts)
}

;(async () => {
  const printer = esp32(), printerPort = await listen(printer.server)
  const file = tempFile()
  let spool = new Spool(file, toLoopback(printerPort))
  // 10,000 rows is about 1.25 m of paper: far longer than any real receipt.
  const raster = longRaster(10000)
  let started = Date.now(), outcome = await spool.print(job(raster))
  check(`long raster receipt (${(raster.length / 1024).toFixed(0)} KB) streams byte-exact through a 4 KB ESP32 buffer in ${Date.now() - started} ms`, () => { assert.equal(outcome.state, 'network_sent'); assert.ok(printer.jobs[0].equals(raster)) })
  const repeat = job(Buffer.from([27, 64, 65, 10]))
  await spool.print(repeat)
  outcome = await spool.print(repeat)
  check('a repeated job ID never opens a second printer connection', () => { assert.equal(outcome.reason, 'duplicate'); assert.equal(printer.jobs.length, 2) })
  await assert.rejects(spool.print({ ...repeat, payload: Buffer.from([1, 2, 3]).toString('base64') }), e => e.code === 'CHANGED_ATTEMPT')
  check('a job ID cannot be reused for different bytes', () => assert.equal(printer.jobs.length, 2))
  spool = new Spool(file, toLoopback(printerPort))
  outcome = await spool.print(repeat)
  check('app restart keeps identity and still refuses to reprint', () => { assert.equal(outcome.state, 'network_sent'); assert.equal(printer.jobs.length, 2); assert.equal(openJournal(file).instanceId, spool.identity()) })
  const same = job(Buffer.from([27, 64, 66, 10]))
  const both = await Promise.all([spool.print(same), spool.print(same)])
  check('the same job sent twice at once prints once', () => { assert.deepEqual(both.map(o => o.state), ['network_sent', 'network_sent']); assert.equal(printer.jobs.length, 3) })
  const pair = await Promise.all([spool.print(job(Buffer.from('receipt\n'))), spool.print(job(Buffer.from('kitchen\n')))])
  check('two slips for one printer wait in turn instead of colliding', () => { assert.deepEqual(pair.map(o => o.state), ['network_sent', 'network_sent']); assert.equal(printer.jobs.length, 5); assert.equal(printer.overlapped(), false) })

  // Port closed (ESP32 with no USB printer ready): nothing written, safe retry.
  const closed = net.createServer(), closedPort = await listen(closed); await new Promise(r => closed.close(r))
  const queuedSpool = new Spool(tempFile(), toLoopback(closedPort))
  const retry = job(Buffer.from('first attempt\n'))
  outcome = await queuedSpool.print(retry)
  check('refused connection is queued with a reason and nothing written', () => { assert.equal(outcome.state, 'queued'); assert.equal(outcome.reason, 'refused') })
  queuedSpool.send = toLoopback(printerPort)
  outcome = await queuedSpool.print({ ...retry, payload: Buffer.from('retry with a new timestamp\n').toString('base64'), host: '192.168.1.60' })
  check('a queued job may retry with fresh bytes at a corrected IP', () => { assert.equal(outcome.state, 'network_sent'); assert.equal(printer.jobs.at(-1).toString(), 'retry with a new timestamp\n') })

  // Connection reset part-way (USB failure, power cut): may have printed.
  const breaking = net.createServer(socket => { let n = 0; socket.on('data', c => { n += c.length; if (n > 8192) socket.resetAndDestroy() }); socket.on('error', () => {}) })
  const breakingPort = await listen(breaking)
  const resetSpool = new Spool(tempFile(), toLoopback(breakingPort))
  const cut = job(longRaster(2000))
  outcome = await resetSpool.print(cut)
  check('a reset after bytes were written is uncertain, never sent', () => { assert.equal(outcome.state, 'uncertain'); assert.equal(outcome.reason, 'interrupted') })
  let writes = 0
  resetSpool.send = async () => { writes++; return { state: 'network_sent' } }
  outcome = await resetSpool.print(job(Buffer.from('next order\n')))
  check('an uncertain slip holds its printer until someone checks the paper', () => { assert.equal(outcome.state, 'uncertain'); assert.equal(outcome.reason, 'held'); assert.equal(writes, 0) })
  outcome = await resetSpool.print(cut)
  check('the uncertain job itself is never resent automatically', () => { assert.equal(outcome.state, 'uncertain'); assert.equal(writes, 0) })
  resetSpool.resolve(cut.jobId, false)
  outcome = await resetSpool.print(job(Buffer.from('next order\n')))
  check('after the paper check the printer accepts new slips', () => { assert.equal(outcome.state, 'network_sent'); assert.equal(writes, 1) })
  outcome = await resetSpool.print(cut)
  check('a discarded attempt still reports uncertain if re-offered (reprint needs a new job)', () => { assert.equal(outcome.state, 'uncertain'); assert.equal(writes, 1) })

  // Crash between "dispatching" and the result.
  const crashFile = tempFile(), crashSpool = new Spool(crashFile, async () => ({ state: 'network_sent' }))
  const crashed = job(Buffer.from('crash\n'))
  await crashSpool.print(crashed)
  const raw = JSON.parse(fs.readFileSync(crashFile, 'utf8')); raw.records[crashed.jobId].state = 'dispatching'; saveJournal(crashFile, raw)
  let crashWrites = 0
  const recovered = new Spool(crashFile, async () => { crashWrites++; return { state: 'network_sent' } })
  outcome = await recovered.print(crashed)
  check('a crash mid-send recovers as uncertain without another write', () => { assert.equal(outcome.state, 'uncertain'); assert.equal(crashWrites, 0); assert.equal(recovered.uncertain(), 1) })

  const brokenFile = tempFile(), broken = new Spool(brokenFile, async () => { crashWrites++; return { state: 'network_sent' } })
  fs.unlinkSync(brokenFile); fs.mkdirSync(brokenFile)
  await assert.rejects(broken.print(job(Buffer.from('x'))))
  check('a journal that cannot be written prevents any printer write', () => assert.equal(crashWrites, 0))
  fs.rmdirSync(brokenFile)

  const journal = { version: 1, instanceId: crypto.randomUUID(), records: {} }
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
  journal.records.a = { id: 'a', state: 'network_sent', date: old }
  journal.records.b = { id: 'b', state: 'uncertain', date: old }
  journal.records.c = { id: 'c', state: 'network_sent', date: new Date().toISOString() }
  prune(journal)
  check('journal pruning keeps a week of history and every held print', () => assert.deepEqual(Object.keys(journal.records).sort(), ['b', 'c']))

  // Browser boundary.
  const probe = net.createServer(), bridgePort = await listen(probe); await new Promise(r => probe.close(r))
  const httpSpool = new Spool(tempFile(), toLoopback(printerPort))
  const bridge = createBridge({ allowedOrigins: ['https://pos.example.com'], port: bridgePort, spool: httpSpool })
  servers.push(bridge); await new Promise(r => bridge.listen(bridgePort, '127.0.0.1', r))
  const call = (method, pathname, { origin = 'https://pos.example.com', host = `127.0.0.1:${bridgePort}`, body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: bridgePort, method, path: pathname, headers: { Host: host, ...(origin && { Origin: origin }), ...(body && { 'Content-Type': 'application/json', 'X-FoodSync-Bridge': '1' }), ...headers } }, res => {
      let text = ''; res.on('data', c => { text += c }); res.on('end', () => { let data = text; try { data = JSON.parse(text) } catch { /* text page */ } resolve({ status: res.statusCode, headers: res.headers, data }) })
    })
    req.on('error', reject); if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body)); req.end()
  })
  let r = await call('OPTIONS', '/v1/print', { headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } })
  check('preflight allows the portal and Chrome private-network access', () => { assert.equal(r.status, 204); assert.equal(r.headers['access-control-allow-origin'], 'https://pos.example.com'); assert.equal(r.headers['access-control-allow-private-network'], 'true'); assert.match(r.headers['access-control-allow-headers'], /X-FoodSync-Bridge/) })
  r = await call('GET', '/v1/info')
  check('the portal reads the bridge identity', () => { assert.equal(r.status, 200); assert.equal(r.data.instanceId, httpSpool.identity()); assert.equal(r.data.platform, 'windows'); assert.equal(r.data.maxBytes, 4 * 1024 * 1024) })
  r = await call('POST', '/v1/print', { origin: 'https://evil.example', body: job(Buffer.from('x')) })
  check('another website cannot print, but can read why', () => { assert.equal(r.status, 403); assert.equal(r.data.code, 'ORIGIN_NOT_ALLOWED'); assert.equal(r.headers['access-control-allow-origin'], 'https://evil.example') })
  r = await call('POST', '/v1/print', { origin: null, body: job(Buffer.from('x')) })
  check('requests without a browser origin cannot print', () => assert.equal(r.status, 403))
  r = await call('GET', '/v1/info', { host: `printer.attacker.example:${bridgePort}` })
  check('DNS-rebinding hosts are refused', () => { assert.equal(r.status, 403); assert.equal(r.data.code, 'HOST_NOT_ALLOWED') })
  r = await call('POST', '/v1/print', { body: JSON.stringify(job(Buffer.from('x'))), headers: { 'X-FoodSync-Bridge': '0' } })
  check('POST without the bridge header (no preflight) is refused', () => assert.equal(r.status, 400))
  r = await call('POST', '/v1/print', { body: job(Buffer.from('x'), { host: '8.8.8.8' }) })
  check('public IP printer targets are refused', () => { assert.equal(r.status, 400); assert.equal(r.data.code, 'INVALID_TARGET') })
  const viaHttp = job(Buffer.from('HTTP receipt\n'))
  r = await call('POST', '/v1/print', { body: viaHttp })
  check('the portal prints through the bridge over loopback HTTP', () => { assert.equal(r.status, 200); assert.equal(r.data.state, 'network_sent'); assert.equal(printer.jobs.at(-1).toString(), 'HTTP receipt\n') })
  r = await call('GET', '/v1/records')
  check('the portal lists this device’s recent prints with labels', () => { assert.equal(r.data.records[0].id, viaHttp.jobId); assert.equal(r.data.records[0].label, 'Receipt #1') })
  r = await call('POST', '/v1/resolve', { body: { id: viaHttp.jobId, printed: true } })
  check('only an uncertain print can be resolved', () => { assert.equal(r.status, 409); assert.equal(r.data.code, 'NOT_UNCERTAIN') })
  r = await call('GET', '/', { origin: null })
  check('opening the bridge address in a browser shows a status page', () => { assert.equal(r.status, 200); assert.match(r.data, /print bridge .* is running/) })

  const configFile = path.join(path.dirname(tempFile()), 'config.json')
  fs.writeFileSync(configFile, JSON.stringify({ allowedOrigins: ['http://pos.example.com'] }))
  assert.throws(() => readConfig(configFile))
  fs.writeFileSync(configFile, '﻿' + JSON.stringify({ allowedOrigins: ['https://pos.example.com/'], port: 9147 }))
  check('configuration accepts only HTTPS portal origins (BOM-tolerant)', () => assert.deepEqual(readConfig(configFile), { allowedOrigins: ['https://pos.example.com'], port: 9147 }))
  console.log(`PASS ${checks} PC print bridge checks`)
})().catch(e => { console.error(e); process.exitCode = 1 }).finally(async () => {
  for (const s of servers) await new Promise(r => { if (s.listening) s.close(() => r()); else r() })
  for (const dir of folders) fs.rmSync(dir, { recursive: true, force: true })
})
