// FoodSync PC print bridge: the Windows counterpart of the iPad app's native
// printer bridge. The cashier's browser renders receipts and kitchen slips and
// posts the ESC/POS bytes to http://127.0.0.1:9147; this process sends them to
// the LAN printer over raw TCP. Node 20+, no npm packages, listens on loopback
// only, needs no inbound router ports and never polls the cloud.
//
// Duplicate protection matches the iPad journal: a job ID is persisted before a
// socket opens, a repeated ID never opens another socket, a crash mid-send
// becomes "uncertain", and an uncertain job blocks that printer until a person
// checks the paper and resolves it.
'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), net = require('node:net'), http = require('node:http')

const VERSION = '1.0.0'
const MAX_BYTES = 4 * 1024 * 1024
const DEFAULT_PORT = 9147
const KEEP_MS = 7 * 24 * 3600 * 1000, KEEP_MAX = 2000
const SETTLED = ['network_sent', 'discarded', 'queued']

class BridgeError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code } }
const privateHost = host => net.isIP(host) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) && !host.endsWith('.0') && !host.endsWith('.255')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateRequest(body) {
  const { jobId, printerId, host, port, payload, label } = body ?? {}
  if (typeof jobId !== 'string' || !uuid.test(jobId) || typeof printerId !== 'string' || !printerId || printerId.length > 100) throw new BridgeError(400, 'INVALID_REQUEST', 'Invalid print request')
  if (typeof host !== 'string' || !privateHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeError(400, 'INVALID_TARGET', 'Printer must use a private LAN IPv4 address')
  if (label !== undefined && (typeof label !== 'string' || label.length > 80)) throw new BridgeError(400, 'INVALID_REQUEST', 'Invalid print label')
  if (typeof payload !== 'string' || payload.length > Math.ceil(MAX_BYTES / 3) * 4) throw new BridgeError(413, 'TOO_LARGE', 'Print job exceeds 4 MB')
  const bytes = Buffer.from(payload, 'base64')
  if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== payload) throw new BridgeError(400, 'INVALID_PAYLOAD', 'Invalid print payload')
  return bytes
}

function saveJournal(file, data) {
  const temp = `${file}.tmp`, fd = fs.openSync(temp, 'w', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) } }
}
function openJournal(file) {
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data.version !== 1 || !uuid.test(data.instanceId) || !data.records || typeof data.records !== 'object') throw new Error('Print bridge journal is damaged; check held prints before replacing it')
    // A crash between "dispatching" and the result may have printed.
    for (const record of Object.values(data.records)) if (record.state === 'dispatching') record.state = 'uncertain'
    saveJournal(file, data)
    return data
  }
  const data = { version: 1, instanceId: crypto.randomUUID(), records: {} }
  saveJournal(file, data)
  return data
}
// Keep a week of settled attempts for duplicate detection; never drop a
// record that still needs a paper check.
function prune(journal, now = Date.now()) {
  const settled = Object.values(journal.records).filter(r => SETTLED.includes(r.state)).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
  settled.forEach((r, i) => { if (now - Date.parse(r.date) > KEEP_MS || settled.length - i > KEEP_MAX) delete journal.records[r.id] })
}

// A completed TCP exchange is "network_sent": the printer accepted the bytes
// and closed the connection. It is not a paper sensor. Anything after the first
// byte may have printed, so it is "uncertain"; failures before it are "queued".
function sendPrinter(target, bytes, { connectTimeout = 5000 } = {}) {
  return new Promise(resolve => {
    let connected = false, done = false
    const socket = net.createConnection({ host: target.host, port: target.port, noDelay: true })
    const finish = (state, reason) => { if (done) return; done = true; clearTimeout(connectTimer); clearTimeout(timer); socket.destroy(); resolve({ state, reason }) }
    const connectTimer = setTimeout(() => { if (!connected) finish('queued', 'unreachable') }, connectTimeout)
    // ~10 KB/s floor covers slow USB printers behind the ESP32's 4 KB buffer.
    const timer = setTimeout(() => finish(connected ? 'uncertain' : 'queued', connected ? 'timeout' : 'unreachable'), Math.min(120000, Math.max(30000, 15000 + bytes.length / 10)))
    socket.once('connect', () => { connected = true; clearTimeout(connectTimer); socket.end(bytes) })
    socket.on('data', () => {})
    socket.once('error', error => finish(connected ? 'uncertain' : 'queued', connected ? 'interrupted' : error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'))
    const closed = () => finish(connected && socket.writableFinished ? 'network_sent' : connected ? 'uncertain' : 'queued', connected && socket.writableFinished ? undefined : connected ? 'interrupted' : 'unreachable')
    socket.once('end', closed)
    socket.once('close', hadError => { if (!hadError) closed() })
  })
}

class Spool {
  constructor(file, send = sendPrinter) { this.file = file; this.journal = openJournal(file); this.send = send; this.locks = new Map() }
  identity() { return this.journal.instanceId }
  records() { return Object.values(this.journal.records).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 100) }
  uncertain() { return Object.values(this.journal.records).filter(r => r.state === 'uncertain').length }
  resolve(id, printed) {
    const record = this.journal.records[id]
    if (!record || record.state !== 'uncertain') throw new BridgeError(409, 'NOT_UNCERTAIN', 'Only an uncertain print can be resolved')
    record.state = printed ? 'network_sent' : 'discarded'; record.reason = printed ? 'checked_printed' : 'checked_missing'; record.date = new Date().toISOString()
    saveJournal(this.file, this.journal)
    return record
  }
  // FIFO per printer and per IP: a receipt and a kitchen slip for the same
  // printer wait for each other instead of colliding on one ESP32 socket.
  async acquire(keys, wait = 60000) {
    const releases = []
    for (const key of [...new Set(keys)].sort()) {
      const previous = this.locks.get(key) ?? Promise.resolve()
      let release; const mine = new Promise(r => { release = r })
      const tail = previous.then(() => mine)
      this.locks.set(key, tail)
      const done = () => { release(); if (this.locks.get(key) === tail) this.locks.delete(key) }
      let timer
      const ready = await Promise.race([previous.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), wait) })])
      clearTimeout(timer)
      if (!ready) { done(); releases.forEach(r => r()); return null }
      releases.push(done)
    }
    return () => releases.reverse().forEach(r => r())
  }
  repeat(request, digest) {
    const old = this.journal.records[request.jobId]
    // "queued" means no byte reached the printer, so the same job may be
    // retried with fresh bytes (a new timestamp) or a corrected printer IP.
    if (!old || old.state === 'queued') return null
    if (old.digest !== digest || old.printerId !== request.printerId || old.host !== request.host || old.port !== request.port) throw new BridgeError(409, 'CHANGED_ATTEMPT', 'This print attempt was already used for different content or another printer')
    return { state: ['discarded', 'dispatching'].includes(old.state) ? 'uncertain' : old.state, reason: 'duplicate' }
  }
  async print(request) {
    const bytes = validateRequest(request)
    const digest = crypto.createHash('sha256').update(bytes).digest('hex'), endpoint = `${request.host}:${request.port}`
    const early = this.repeat(request, digest)
    if (early) return early
    const release = await this.acquire([`printer:${request.printerId}`, `endpoint:${endpoint}`])
    if (!release) return { state: 'queued', reason: 'busy' }
    try {
      const repeated = this.repeat(request, digest)
      if (repeated) return repeated
      const held = Object.values(this.journal.records).find(r => (r.printerId === request.printerId || `${r.host}:${r.port}` === endpoint) && ['uncertain', 'dispatching'].includes(r.state))
      if (held) return { state: 'uncertain', reason: 'held', heldId: held.id }
      prune(this.journal)
      const record = { id: request.jobId, printerId: request.printerId, host: request.host, port: request.port, digest, label: request.label, state: 'dispatching', date: new Date().toISOString() }
      this.journal.records[record.id] = record
      try { saveJournal(this.file, this.journal) } catch (error) { delete this.journal.records[record.id]; throw error } // never write to a printer without this
      let outcome
      try { outcome = await this.send(request, bytes) } catch { outcome = { state: 'uncertain', reason: 'interrupted' } }
      if (!outcome || !['network_sent', 'queued', 'uncertain'].includes(outcome.state)) outcome = { state: 'uncertain', reason: 'interrupted' }
      Object.assign(record, { state: outcome.state, reason: outcome.reason, date: new Date().toISOString() })
      try { saveJournal(this.file, this.journal) } catch (error) { record.state = 'uncertain'; throw error } // disk still says dispatching, so restart cannot replay
      return outcome
    } finally { release() }
  }
}

function readBody(req, limit = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new BridgeError(413, 'TOO_LARGE', 'Print job exceeds 4 MB')); req.destroy() } else chunks.push(chunk) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new BridgeError(400, 'INVALID_JSON', 'Invalid JSON')) } })
    req.on('error', reject)
  })
}

// Browsers send Origin on every cross-origin fetch, so only the configured
// FoodSync portal can print. The Host check defeats DNS-rebinding pages, and
// the custom header forces a CORS preflight before any POST reaches us.
function createBridge({ allowedOrigins, port = DEFAULT_PORT, spool }) {
  const allowed = new Set(allowedOrigins.map(o => new URL(o).origin))
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' }
    // Disallowed portals may read the refusal itself, so Settings can explain it.
    if (origin) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type, X-FoodSync-Bridge', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' })
    const reply = (status, body) => { res.writeHead(status, headers); res.end(status === 204 ? undefined : JSON.stringify(body)) }
    try {
      if (!hosts.has(req.headers.host ?? '')) throw new BridgeError(403, 'HOST_NOT_ALLOWED', 'Use http://127.0.0.1')
      if (req.method === 'OPTIONS') return reply(204)
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (req.method === 'GET' && url.pathname === '/' && !origin) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(`FoodSync PC print bridge ${VERSION} is running.\nAllowed FoodSync portals: ${[...allowed].join(', ')}\nOpen FoodSync Settings > Printers to test a printer.\n`)
      }
      if (!origin || !allowed.has(origin)) throw new BridgeError(403, 'ORIGIN_NOT_ALLOWED', `This print bridge was installed for ${[...allowed].join(', ')}. Download the bridge from this portal's Settings > Printers.`)
      if (req.method === 'POST' && req.headers['x-foodsync-bridge'] !== '1') throw new BridgeError(400, 'INVALID_REQUEST', 'Missing bridge header')
      if (req.method === 'GET' && url.pathname === '/v1/info') return reply(200, { instanceId: spool.identity(), platform: 'windows', version: VERSION, maxBytes: MAX_BYTES, uncertain: spool.uncertain() })
      if (req.method === 'GET' && url.pathname === '/v1/records') return reply(200, { records: spool.records() })
      if (req.method === 'POST' && url.pathname === '/v1/print') return reply(200, await spool.print(await readBody(req)))
      if (req.method === 'POST' && url.pathname === '/v1/resolve') {
        const { id, printed } = await readBody(req, 4096)
        if (typeof id !== 'string' || typeof printed !== 'boolean') throw new BridgeError(400, 'INVALID_REQUEST', 'Invalid resolve request')
        return reply(200, { record: spool.resolve(id, printed) })
      }
      throw new BridgeError(404, 'NOT_FOUND', 'Unknown bridge action')
    } catch (error) {
      reply(error instanceof BridgeError ? error.status : 500, { code: error.code || 'BRIDGE_ERROR', message: error instanceof BridgeError ? error.message : 'Print not repeated: check held prints on this PC. ' + error.message })
    }
  })
}

function readConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
  const origins = Array.isArray(config.allowedOrigins) ? config.allowedOrigins : []
  const valid = o => { try { const u = new URL(o); return u.origin === o.replace(/\/+$/, '') && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) } catch { return false } }
  const port = config.port ?? DEFAULT_PORT
  if (!origins.length || !origins.every(valid) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid print bridge configuration: allowedOrigins must list HTTPS FoodSync portal origins')
  return { allowedOrigins: origins.map(o => o.replace(/\/+$/, '')), port }
}

async function run(configFile) {
  const config = readConfig(configFile)
  const spool = new Spool(path.join(path.dirname(configFile), 'journal.json'))
  const server = createBridge({ ...config, spool })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve) })
  console.log(`FoodSync PC print bridge ${VERSION} on http://127.0.0.1:${config.port} for ${config.allowedOrigins.join(', ')}`)
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  return server
}

module.exports = { BridgeError, MAX_BYTES, VERSION, createBridge, openJournal, prune, readConfig, run, saveJournal, sendPrinter, Spool, validateRequest }
if (require.main === module) run(path.resolve(process.argv[2] || path.join(__dirname, 'config.json'))).catch(e => {
  console.error(e.code === 'EADDRINUSE' ? 'Another FoodSync print bridge is already running on this PC.' : e.message)
  process.exitCode = 1
})
