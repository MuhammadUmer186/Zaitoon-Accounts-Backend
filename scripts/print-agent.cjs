// Standalone Node 20+ agent, bundled with rawPrinter.js and a private config.json.
// No npm packages, browser extension, inbound ports or printer-specific driver.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), net = require('node:net')
const { sendRawPrinter } = require(fs.existsSync(path.join(__dirname, 'rawPrinter.js')) ? './rawPrinter.js' : '../dist/services/rawPrinter.js')
function saveJournal(file, data) {
  const temp = `${file}.tmp`, fd = fs.openSync(temp, 'w', 0o600)
  try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  fs.renameSync(temp, file)
  // Persist directory entries where the operating system supports it.
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) } }
}
function openJournal(file) {
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!/^[a-f0-9-]{36}$/.test(data.instanceId) || data.version !== 1) throw new Error('Invalid agent journal; review the printer before pairing a replacement')
    return data
  }
  const data = { version: 1, instanceId: crypto.randomUUID(), last: null }; saveJournal(file, data); return data
}
function validateJob(job) {
  if (!job || !/^[a-f0-9-]{36}$/.test(job.id) || !/^[1-9][0-9]{0,18}$/.test(job.sequence) || !/^[a-f0-9]{64}$/.test(job.digest) || typeof job.payload !== 'string' || job.payload.length > 21848) throw new Error('Invalid printer job')
  if (net.isIP(job.host) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(job.host) || !Number.isInteger(job.port) || job.port < 1 || job.port > 65535) throw new Error('Invalid LAN printer target')
  const bytes = Buffer.from(job.payload, 'base64')
  if (!bytes.length || bytes.length > 16384 || crypto.createHash('sha256').update(bytes).digest('hex') !== job.digest) throw new Error('Invalid slip digest')
  return bytes
}
async function processJob(job, journal, file, send = sendRawPrinter) {
  const bytes = validateJob(job)
  const previous = journal.last
  if (previous && BigInt(job.sequence) <= BigInt(previous.sequence)) {
    if (previous.jobId === job.id && previous.sequence === job.sequence && previous.digest === job.digest && previous.host === job.host && previous.port === job.port) {
      return { ...previous, state: previous.state === 'dispatching' ? 'uncertain' : previous.state }
    }
    throw new Error('Agent refused an old or changed print attempt; review it in Kitchen')
  }
  const receipt = { jobId: job.id, sequence: job.sequence, digest: job.digest, host: job.host, port: job.port, state: 'dispatching' }
  journal.last = receipt
  saveJournal(file, journal) // must succeed before opening a printer socket
  let state
  try { state = await send(job, bytes) } catch { state = 'uncertain' }
  if (!['network_sent', 'queued', 'uncertain'].includes(state)) state = 'uncertain'
  journal.last = { ...receipt, state }
  saveJournal(file, journal) // if this fails, the persisted dispatching state forbids replay
  return journal.last
}
async function run(configFile) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')), url = new URL(config.serverUrl)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) || url.username || url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(config.token) || !/^net-[a-f0-9-]{36}$/.test(config.printerId)) throw new Error('Invalid print agent configuration')
  const folder = path.dirname(configFile), lock = path.join(folder, 'agent.lock'), journalFile = path.join(folder, 'journal.json')
  try { const fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd) } catch (e) {
    if (e.code !== 'EEXIST') throw e
    const pid = Number(fs.readFileSync(lock, 'utf8')); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid agent lock; check the running agent')
    try { process.kill(pid, 0); throw new Error('This agent folder is already running') } catch (status) { if (status.code !== 'ESRCH') throw status }
    fs.unlinkSync(lock)
    const fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd)
  }
  let stop = false
  process.on('SIGINT', () => { stop = true }); process.on('SIGTERM', () => { stop = true })
  const request = async (action, body) => {
    const res = await fetch(`${config.serverUrl.replace(/\/+$/, '')}/network-printer-agent/${config.printerId}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error' })
    if (res.status === 204) return null
    const data = await res.json()
    if (!res.ok) { const error = new Error(data.message || `Printer service HTTP ${res.status}`); error.code = data.code; throw error }
    return data
  }
  try {
    const journal = openJournal(journalFile)
    console.log('FoodSync print agent running. Printer addresses are managed in Settings.')
    while (!stop) {
      try {
        if (journal.last && journal.last.state !== 'acknowledged') {
          const { jobId, sequence, digest, state } = journal.last
          try { await request('ack', { instanceId: journal.instanceId, jobId, sequence, digest, state: state === 'dispatching' ? 'uncertain' : state }) }
          catch (e) { if (!['PRINT_STATE', 'NOT_FOUND'].includes(e.code)) throw e }
          // A definitive pre-connection failure can retry the SAME sequence safely.
          if (state === 'queued') journal.last = null
          else journal.last = { ...journal.last, result: state === 'dispatching' ? 'uncertain' : state, state: 'acknowledged' }
          saveJournal(journalFile, journal)
        }
        const job = await request('poll', { instanceId: journal.instanceId })
        if (job) {
          // An acknowledged receipt re-offered after an interrupted HTTP response
          // is acknowledged again; it is never transmitted to the printer again.
          if (journal.last?.jobId === job.id && journal.last.state === 'acknowledged') {
            validateJob(job)
            if (journal.last.digest !== job.digest || journal.last.host !== job.host || journal.last.port !== job.port) throw new Error('Previously handled print attempt changed')
            journal.last = { ...journal.last, state: journal.last.result }; saveJournal(journalFile, journal)
          } else await processJob(job, journal, journalFile)
        }
      } catch (e) { console.error(`Print agent: ${e.message}`) }
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  } finally { fs.unlinkSync(lock) }
}
module.exports = { processJob, openJournal, saveJournal, validateJob, run }
if (require.main === module) run(path.resolve(process.argv[2] || path.join(__dirname, 'config.json'))).catch(e => { console.error(e.message); process.exitCode = 1 })
