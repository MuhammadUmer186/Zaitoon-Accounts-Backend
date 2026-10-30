import fs from 'node:fs'
import net from 'node:net'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../config'
import { lockOrder } from '../routes/orders'

const privateIp = (host: string) => net.isIP(host) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
const printerSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), organizationId: z.string().min(1), branchId: z.string().min(1),
  stationId: z.string().min(1), host: z.string().refine(privateIp, 'Printer must use a private LAN IPv4 address'),
  port: z.number().int().min(1).max(65535).default(9100), key: z.string().min(32).max(128),
  enabledAt: z.string().datetime(),
})
export type KitchenPrinter = z.infer<typeof printerSchema>
export function readKitchenPrinters(): KitchenPrinter[] {
  const raw = process.env.KITCHEN_PRINTERS_FILE ? fs.readFileSync(process.env.KITCHEN_PRINTERS_FILE, 'utf8') : process.env.KITCHEN_PRINTERS_JSON
  if (!raw) return []
  const printers = z.array(printerSchema).max(8).parse(JSON.parse(raw.replace(/^\uFEFF/, '')))
  if (new Set(printers.map(p => p.id)).size !== printers.length || new Set(printers.map(p => `${p.organizationId}:${p.branchId}:${p.stationId}`)).size !== printers.length) throw new Error('Duplicate kitchen printer routing')
  return printers
}

type Line = { id: string; dishName: string; quantity: number; notes: string | null; selection: unknown; course: number }
export function kitchenSlip(order: { orderNo: number; table: { name: string } | null; orderType: string; branch: { name: string }; notes: string | null; source?: string }, items: Line[], kind: string, station: string): Buffer {
  const clean = (value: string) => {
    const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    if (/[^\x20-\x7e]/.test(text)) throw new Error('Non-Latin text needs a raster-capable print renderer; job held for review')
    return text
  }
  const wrap = (text: string) => clean(text).match(/.{1,48}/g)?.join('\n') ?? ''
  const out = ['\x1b@\x1ba\x01\x1bE\x01', kind === 'cancel' ? '*** CANCEL - DO NOT PREPARE ***' : 'KITCHEN ORDER', `ORDER #${order.orderNo}`, wrap(station), '\x1bE\x00\x1ba\x00', wrap(order.branch.name), wrap(order.table ? `Table: ${order.table.name}` : order.orderType), new Date().toISOString(), '-'.repeat(48)]
  for (const item of items) {
    out.push('\x1bE\x01' + wrap(`${item.quantity} x ${item.dishName}`) + '\x1bE\x00')
    if (item.course > 1) out.push(`Course ${item.course}`)
    const s = item.selection as { size?: { name?: string }; modifiers?: { name?: string }[]; combo?: { group?: string; name?: string; sizeName?: string }[] } | null
    if (s?.size?.name) out.push(wrap(s.size.name))
    for (const m of s?.modifiers ?? []) if (m.name) out.push(wrap('+ ' + m.name))
    for (const c of s?.combo ?? []) out.push(wrap(`${c.group ?? ''}: ${c.name ?? ''}${c.sizeName ? ` (${c.sizeName})` : ''}`))
    if (item.notes) out.push(wrap('Note: ' + item.notes))
    out.push('')
  }
  if (order.notes && order.source !== 'online') out.push(wrap('Order note: ' + order.notes))
  out.push('-'.repeat(48), '\n\n\n\x1dVB\x00')
  const payload = Buffer.from(out.join('\n'), 'ascii')
  if (payload.length > 16384) throw new Error('Kitchen slip exceeds printer transfer limit; job held for review')
  return payload
}

const cancellationScans = new Map<string, number>()
export async function enqueueKitchenPrinter(p: Pick<KitchenPrinter, 'id' | 'organizationId' | 'branchId' | 'stationId' | 'enabledAt'>, mode: 'branch' | 'cloud' = 'branch') {
  const scanStarted = Date.now(), scanKey = `${p.organizationId}:${p.branchId}:${p.id}`
  const cancelledSince = new Date(cancellationScans.get(scanKey) ?? Date.parse(p.enabledAt))
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (mode === 'branch') {
    if (!runtime || runtime.branchId !== p.branchId || runtime.organizationId !== p.organizationId || runtime.writesFrozen) return
  } else {
    if (runtime || process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return
    // Never print a second copy of a PC-owned branch's replicated orders.
    if (await prisma.branchSyncNode.count({ where: { organizationId: p.organizationId, branchId: p.branchId, ownsWrites: true } })) return
  }
  if (!await prisma.branch.count({ where: { id: p.branchId, organizationId: p.organizationId } })) throw new Error('Invalid printer branch')
  const station = p.stationId === 'none' ? null : await prisma.kitchenStation.findFirst({ where: { id: p.stationId, organizationId: p.organizationId, isActive: true } })
  if (p.stationId !== 'none' && !station) throw new Error('Invalid printer station')
  let cursor: string | undefined
  for (;;) {
    const orders = await prisma.customerOrder.findMany({ where: { organizationId: p.organizationId, branchId: p.branchId, status: { in: ['completed', 'cancelled'] }, OR: [{ closedAt: { gte: new Date(p.enabledAt) } }, { items: { some: { firedAt: { gte: new Date(p.enabledAt) } } } }], items: { some: { stationId: station?.id ?? null, held: false, OR: [{ status: { in: ['pending', 'preparing', 'ready'] } }, { status: 'cancelled', updatedAt: { gte: cancelledSince } }] } } }, orderBy: { id: 'asc' }, take: 100, ...(cursor && { cursor: { id: cursor }, skip: 1 }) })
    for (const found of orders) await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-enqueue:${p.organizationId}:${p.branchId}:${p.id}`}))`
      await lockOrder(tx, found)
      const order = await tx.customerOrder.findUniqueOrThrow({ where: { id: found.id }, include: { items: true, table: { select: { name: true } }, branch: { select: { name: true } } } })
      const previous = await tx.kitchenPrintJob.findMany({ where: { organizationId: p.organizationId, branchId: p.branchId, printerId: p.id, orderId: order.id, state: { not: 'suppressed' } } })
      const ids = (kind: string) => new Set(previous.filter(j => j.kind === kind).flatMap(j => j.itemIds as string[]))
      const sent = new Set(previous.filter(j => j.kind === 'new' && ['sending', 'usb_complete', 'uncertain'].includes(j.state)).flatMap(j => j.itemIds as string[]))
      for (const kind of ['new', 'cancel']) {
        const claimed = ids(kind)
        const lines = order.items.filter(i => !i.held && i.stationId === (station?.id ?? null) && !claimed.has(i.id) && (kind === 'new' ? order.status === 'completed' && ['pending', 'preparing', 'ready'].includes(i.status) && ((order.closedAt?.getTime() ?? 0) >= Date.parse(p.enabledAt) || (i.firedAt?.getTime() ?? 0) >= Date.parse(p.enabledAt)) : i.status === 'cancelled' && sent.has(i.id)))
        if (!lines.length) continue
        const itemIds = lines.map(i => i.id).sort()
        const eventKey = createHash('sha256').update(JSON.stringify([p.organizationId, p.branchId, p.id, order.id, kind, itemIds])).digest('hex')
        let payload = '', state = 'queued', lastError: string | null = null
        try { payload = kitchenSlip(order, lines, kind, station?.name ?? 'Kitchen').toString('base64') } catch (e) { state = 'blocked'; lastError = (e as Error).message }
        await tx.kitchenPrintJob.upsert({ where: { eventKey }, create: { organizationId: p.organizationId, branchId: p.branchId, orderId: order.id, printerId: p.id, kind, itemIds, eventKey, payload, state, lastError }, update: { payload, state, lastError } })
      }
    })
    if (orders.length < 100) break
    cursor = orders[orders.length - 1].id
  }
  // Keep a grace overlap, and advance only after the entire scan committed.
  // A restart safely scans from activation again; the durable claims dedupe it.
  cancellationScans.set(scanKey, scanStarted - 60000)
}

type Delivery = 'usb_complete' | 'queued' | 'blocked' | 'uncertain'
export function sendKitchenBytes(p: Pick<KitchenPrinter, 'host' | 'port' | 'key'>, job: { id: string; sequence: bigint; payload: string }, timeout = 20000): Promise<Delivery> {
  const bytes = Buffer.from(job.payload, 'base64'), digest = createHash('sha256').update(bytes).digest('hex')
  const signed = `${job.sequence}:${job.id}:${bytes.length}:${digest}`
  const mac = createHmac('sha256', p.key).update(signed).digest('hex')
  return new Promise(resolve => {
    let connected = false, finished = false, reply = ''
    const socket = net.createConnection({ host: p.host, port: p.port })
    const finish = (state: Delivery) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(state) }
    const timer = setTimeout(() => finish(connected ? 'uncertain' : 'queued'), timeout)
    socket.once('connect', () => { connected = true; socket.write(`FS1 ${job.sequence} ${job.id} ${bytes.length} ${digest} ${mac}\n`); socket.write(bytes) })
    socket.on('data', chunk => {
      reply += chunk.toString('ascii')
      if (reply.length > 256) return finish('uncertain')
      if (!reply.includes('\n')) return
      const frame = reply.split('\n')[0].trim(), split = frame.lastIndexOf(' ')
      const answer = frame.slice(0, split), signature = frame.slice(split + 1)
      const expected = createHmac('sha256', p.key).update(`ACK:${job.sequence}:${job.id}:${digest}:${answer}`).digest('hex')
      if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return finish('uncertain')
      finish(answer === `OK ${job.id}` ? 'usb_complete' : ['ERROR NOT_READY', 'ERROR BUSY'].includes(answer) ? 'queued' : answer === 'ERROR AUTH' ? 'blocked' : 'uncertain')
    })
    socket.once('error', () => finish(connected ? 'uncertain' : 'queued'))
    socket.once('end', () => finish(connected ? 'uncertain' : 'queued'))
  })
}

export async function deliverKitchenPrinter(p: KitchenPrinter, send = sendKitchenBytes) {
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || runtime.organizationId !== p.organizationId || runtime.branchId !== p.branchId || runtime.writesFrozen) return
  const job = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
    const scope = { organizationId: p.organizationId, branchId: p.branchId, printerId: p.id }
    await tx.kitchenPrintJob.updateMany({ where: { ...scope, state: 'sending', updatedAt: { lt: new Date(Date.now() - 60000) } }, data: { state: 'uncertain', lastError: 'Worker interrupted during delivery; check the physical printer' } })
    // Renderer-blocked tickets never touched USB. Keep their warning visible,
    // but do not let one unsupported customer note stop all other orders.
    if (await tx.kitchenPrintJob.count({ where: { ...scope, state: { in: ['sending', 'uncertain'] } } })) return null
    const next = await tx.kitchenPrintJob.findFirst({ where: { ...scope, state: 'queued' }, orderBy: { sequence: 'asc' } })
    if (!next) return null
    const order = await tx.customerOrder.findFirst({ where: { id: next.orderId, organizationId: p.organizationId, branchId: p.branchId }, include: { items: true } })
    if (next.kind === 'new' && (!order || order.status !== 'completed' || (next.itemIds as string[]).some(id => !order.items.some(i => i.id === id && !i.held && ['pending', 'preparing', 'ready'].includes(i.status))))) {
      await tx.kitchenPrintJob.update({ where: { id: next.id }, data: { state: 'suppressed', lastError: 'Order changed before delivery; stale ticket suppressed' } })
      return null
    }
    return tx.kitchenPrintJob.update({ where: { id: next.id }, data: { state: 'sending', attempts: { increment: 1 }, lastError: null } })
  })
  if (!job) return
  let state: Delivery
  try { state = await send(p, job) } catch { state = 'uncertain' }
  await prisma.kitchenPrintJob.update({ where: { id: job.id }, data: { state, lastError: state === 'usb_complete' ? null : state === 'queued' ? 'Printer unavailable; queued for retry' : 'Check printer before resolving this job; automatic resend stopped' } })
}

let runningPrinters: KitchenPrinter[] = []
export async function automaticKitchenStations(organizationId: string, branchId: string, printers = runningPrinters) {
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime && process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') {
    const { cloudKitchenStations } = await import('./cloudKitchenPrinting')
    return cloudKitchenStations(organizationId, branchId)
  }
  if (!runtime || runtime.organizationId !== organizationId || runtime.branchId !== branchId || runtime.writesFrozen) return []
  return printers.filter(p => p.organizationId === organizationId && p.branchId === branchId).map(p => p.stationId)
}
export function startKitchenPrintWorker() {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  let printers: KitchenPrinter[]
  try { printers = readKitchenPrinters() } catch { console.error('[kitchen-print] Invalid printer configuration; automatic printing disabled'); return }
  runningPrinters = printers
  const busy = new Set<string>()
  const tick = () => printers.forEach(p => {
    if (busy.has(p.id)) return
    busy.add(p.id)
    void (async () => { await enqueueKitchenPrinter(p); await deliverKitchenPrinter(p) })().catch(() => console.error(`[kitchen-print] ${p.id}: queue check failed`)).finally(() => busy.delete(p.id))
  })
  if (printers.length) { tick(); setInterval(tick, 3000).unref() }
}
