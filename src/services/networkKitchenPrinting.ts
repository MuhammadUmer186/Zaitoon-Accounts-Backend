import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { NetworkKitchenPrinter, Prisma } from '@prisma/client'
import { z } from 'zod'
import net from 'node:net'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { enqueueKitchenPrinter, kitchenSlip } from './kitchenPrinting'

export const privatePrinterIp = (host: string) => net.isIP(host) === 4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) && !host.endsWith('.0') && !host.endsWith('.255')
export const networkPrinterSchema = z.object({
  branchId: z.string().min(1), stationId: z.string().min(1), name: z.string().trim().min(1).max(60),
  host: z.string().trim().refine(privatePrinterIp, 'Enter a private LAN IPv4 address, such as 192.168.1.50'),
  port: z.number().int().min(1).max(65535).default(9100), paperWidth: z.union([z.literal(58), z.literal(80)]).default(80),
  enabled: z.boolean().default(false), deliveryMode: z.enum(['branch', 'agent', 'ipad']),
}).strict()
// Cashier devices check in on every live order event and a 15-second recovery
// pass; Windows agents poll every 3 seconds.
export const dispatcherActive = (p: Pick<NetworkKitchenPrinter, 'agentInstanceId' | 'lastSeenAt' | 'deliveryMode'>) =>
  !!p.agentInstanceId && !!p.lastSeenAt && Date.now() - p.lastSeenAt.getTime() < (p.deliveryMode === 'ipad' ? 45000 : 20000)
export function printerPublic(p: NetworkKitchenPrinter) {
  const { agentTokenHash, agentInstanceId, ...safe } = p
  return { ...safe, paired: !!agentTokenHash, dispatcherBound: !!agentInstanceId, agentConnected: dispatcherActive(p) }
}
export function asKitchenPrinter(p: NetworkKitchenPrinter) {
  return { ...p, protocol: 'raw' as const, nativeRender: p.deliveryMode === 'ipad', key: '', enabledAt: p.enabledAt.toISOString() }
}
export async function networkPrinters(organizationId?: string, branchId?: string, deliveryMode?: string) {
  return prisma.networkKitchenPrinter.findMany({ where: { enabled: true, ...(organizationId && { organizationId }), ...(branchId && { branchId }), ...(deliveryMode && { deliveryMode }) } })
}

export async function assertPrinterOwner(p: Pick<NetworkKitchenPrinter, 'organizationId' | 'branchId' | 'deliveryMode'>, db: Prisma.TransactionClient = prisma) {
  const runtime = await db.branchRuntime.findUnique({ where: { id: 'local' } })
  if (p.deliveryMode === 'ipad') {
    if (runtime && (runtime.branchId !== p.branchId || runtime.organizationId !== p.organizationId || runtime.writesFrozen)) throw new AppError('This branch is not active on this server', 409, 'PRINTER_BRANCH_PC_REQUIRED')
    if (!runtime && await db.branchSyncNode.count({ where: { organizationId: p.organizationId, branchId: p.branchId, ownsWrites: true } })) throw new AppError('Use the owning branch portal for this iPad', 409, 'BRANCH_OWNED')
  } else if (p.deliveryMode === 'branch') {
    if (!runtime || runtime.branchId !== p.branchId || runtime.organizationId !== p.organizationId || runtime.writesFrozen) throw new AppError('Configure this connection on the active branch PC portal', 409, 'PRINTER_BRANCH_PC_REQUIRED')
  } else {
    if (runtime || process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') throw new AppError('Configure a cloud print agent on the cloud portal', 409, 'PRINTER_CLOUD_REQUIRED')
    if (await db.branchSyncNode.count({ where: { organizationId: p.organizationId, branchId: p.branchId, ownsWrites: true } })) throw new AppError('This branch prints through its branch PC; configure its printer there', 409, 'BRANCH_OWNED')
  }
  if (!await db.branch.count({ where: { id: p.branchId, organizationId: p.organizationId, isActive: true } })) throw new AppError('Active printer branch not found', 404, 'NOT_FOUND')
  if (p.deliveryMode !== 'agent') return
}

export async function assertNoPrinterInFlight(db: Prisma.TransactionClient, id: string) {
  if (await db.kitchenPrintJob.count({ where: { printerId: id, state: { in: ['sending', 'uncertain'] } } })) throw new AppError('Check the physical printer and resolve its in-progress or uncertain job in Kitchen before changing the connection', 409, 'PRINT_IN_PROGRESS')
}
export async function queuePrinterTest(p: NetworkKitchenPrinter) {
  await assertPrinterOwner(p)
  if (!p.enabled) throw new AppError('Enable the printer before testing', 409, 'PRINTER_DISABLED')
  const payload = kitchenSlip({ orderNo: 0, table: null, orderType: 'TEST PRINT - no food to prepare', branch: { name: 'FoodSync' }, notes: null }, [{ id: 'test', dishName: 'Printer connection test', quantity: 1, notes: 'Please check the paper output.', selection: null, course: 1 }], 'test', 'Kitchen', p.paperWidth).toString('base64')
  return prisma.kitchenPrintJob.create({ data: { organizationId: p.organizationId, branchId: p.branchId, printerId: p.id, orderId: 'test-print', kind: 'test', itemIds: [], eventKey: randomUUID(), payload } })
}

export async function authenticateNetworkAgent(id: string, authorization?: string) {
  const p = await prisma.networkKitchenPrinter.findUnique({ where: { id } })
  const token = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? ''
  const digest = createHash('sha256').update(token).digest()
  const expected = p?.agentTokenHash && /^[a-f0-9]{64}$/.test(p.agentTokenHash) ? Buffer.from(p.agentTokenHash, 'hex') : Buffer.alloc(32)
  if (!p || !p.enabled || p.deliveryMode !== 'agent' || !token || !timingSafeEqual(digest, expected)) throw new AppError('Print agent is not paired or enabled', 401, 'UNAUTHORIZED')
  await assertPrinterOwner(p)
  return p
}
export const agentPollSchema = z.object({ instanceId: z.string().uuid() }).strict()
export const agentAckSchema = agentPollSchema.extend({ jobId: z.string().uuid(), sequence: z.string().refine(s => /^[1-9][0-9]{0,18}$/.test(s) && BigInt(s) <= 9223372036854775807n), digest: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['network_sent', 'queued', 'uncertain']), message: z.string().max(200).optional() }).strict()

async function lockAgent(db: Prisma.TransactionClient, p: NetworkKitchenPrinter, instanceId: string) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${p.branchId}`}))`
  await assertPrinterOwner(p, db)
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
  const fresh = await db.networkKitchenPrinter.findUniqueOrThrow({ where: { id: p.id } })
  if (!fresh.enabled || fresh.deliveryMode !== p.deliveryMode || fresh.agentTokenHash !== p.agentTokenHash) throw new AppError('Printer connection changed; reload its settings', 409, 'PRINTER_CHANGED')
  // A paired agent token is its own credential. Cashier devices share staff
  // logins, so a device dispatches only after an explicit take-over.
  if (p.deliveryMode === 'ipad' && fresh.agentInstanceId !== instanceId) throw new AppError(fresh.agentInstanceId ? `${fresh.dispatcherLabel || 'Another cashier device'} dispatches this printer` : 'No cashier device dispatches this printer yet', 409, fresh.agentInstanceId ? 'DISPATCHER_OTHER' : 'NO_DISPATCHER')
  if (fresh.agentInstanceId && fresh.agentInstanceId !== instanceId) throw new AppError('Another agent is paired. Stop it and pair the replacement from Settings', 409, 'AGENT_INSTANCE')
  await db.networkKitchenPrinter.update({ where: { id: p.id }, data: { agentInstanceId: instanceId, lastSeenAt: new Date() } })
  return fresh
}
const jobScope = (p: NetworkKitchenPrinter) => ({ organizationId: p.organizationId, branchId: p.branchId, printerId: p.id })
export async function pollNetworkAgent(p: NetworkKitchenPrinter, instanceId: string) {
  // Preserve the heartbeat even while an uncertain job deliberately blocks
  // the claim transaction, so Settings distinguishes a held job from offline.
  await prisma.networkKitchenPrinter.updateMany({ where: { id: p.id, agentInstanceId: instanceId, enabled: true, agentTokenHash: p.agentTokenHash }, data: { lastSeenAt: new Date() } })
  if (p.stationId !== 'cashier') {
    const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
    await enqueueKitchenPrinter(asKitchenPrinter(p), runtime ? 'branch' : 'cloud')
  }
  return prisma.$transaction(async db => {
    const fresh = await lockAgent(db, p, instanceId)
    if (await db.kitchenPrintJob.count({ where: { ...jobScope(p), state: 'uncertain' } })) throw new AppError('Check the printer and review its uncertain job in Kitchen', 409, 'PRINT_UNCERTAIN')
    let job = await db.kitchenPrintJob.findFirst({ where: { ...jobScope(p), state: 'sending' }, orderBy: { sequence: 'asc' } })
    if (!job) {
      job = await db.kitchenPrintJob.findFirst({ where: { ...jobScope(p), state: 'queued' }, orderBy: { sequence: 'asc' } })
      if (!job) return null
      if (job.kind === 'new') {
        const order = await db.customerOrder.findFirst({ where: { id: job.orderId, organizationId: p.organizationId, branchId: p.branchId }, include: { items: true } })
        if (!order || order.status !== 'completed' || (job.itemIds as string[]).some(id => !order.items.some(i => i.id === id && !i.held && ['pending', 'preparing', 'ready'].includes(i.status)))) {
          await db.kitchenPrintJob.update({ where: { id: job.id }, data: { state: 'suppressed', lastError: 'Order changed before printer claim' } })
          return null
        }
      }
      job = await db.kitchenPrintJob.update({ where: { id: job.id }, data: { state: 'sending', attempts: { increment: 1 }, lastError: null } })
    }
    let render: unknown
    if (p.deliveryMode === 'ipad' && ['new', 'cancel'].includes(job.kind)) {
      const description = Buffer.from(job.payload, 'base64').toString('utf8')
      // Already-queued slips migrated from an older agent retain their exact
      // ESC/POS payload; only new native snapshots are rendered on the iPad.
      if (description.startsWith('{')) render = JSON.parse(description)
    }
    return { render, id: job.id, sequence: job.sequence.toString(), payload: job.payload, digest: createHash('sha256').update(Buffer.from(job.payload, 'base64')).digest('hex'), host: fresh.host, port: fresh.port }
  })
}
export async function ackNetworkAgent(p: NetworkKitchenPrinter, ack: z.infer<typeof agentAckSchema>) {
  return prisma.$transaction(async db => {
    await lockAgent(db, p, ack.instanceId)
    const job = await db.kitchenPrintJob.findFirst({ where: { ...jobScope(p), id: ack.jobId, sequence: BigInt(ack.sequence) } })
    if (!job) throw new AppError('Print job not found', 404, 'NOT_FOUND')
    if (createHash('sha256').update(Buffer.from(job.payload, 'base64')).digest('hex') !== ack.digest) throw new AppError('Print payload changed', 409, 'PRINT_DIGEST')
    if (job.state !== 'sending') {
      if (job.state === ack.state) return { state: job.state }
      throw new AppError('This print attempt was already reviewed', 409, 'PRINT_STATE')
    }
    await db.kitchenPrintJob.update({ where: { id: job.id }, data: { state: ack.state, lastError: ack.state === 'network_sent' ? 'Sent to printer connection; paper output is not confirmed' : ack.state === 'queued' ? 'Could not connect; queued for retry' : 'Delivery interrupted; check paper output before retrying' } })
    return { state: ack.state }
  })
}
// One cashier device dispatches every device-local printer of a branch, so
// kitchen stations never split between devices. A handover is refused while
// any of those printers has a slip in flight or awaiting a paper check; the
// previous device's next claim then fails on the changed binding.
export const takeOverSchema = z.object({ branchId: z.string().min(1), instanceId: z.string().uuid(), label: z.string().trim().min(1).max(60) }).strict()
// A device's instance ID is what it presents to claim slips, so it is never
// returned; the caller learns only whether the dispatcher is itself.
export async function localDispatchStatus(organizationId: string, branchId: string, instanceId?: string) {
  const printers = await prisma.networkKitchenPrinter.findMany({ where: { organizationId, branchId, enabled: true, deliveryMode: 'ipad' }, orderBy: { name: 'asc' } })
  const counts = await prisma.kitchenPrintJob.groupBy({ by: ['printerId', 'state'], where: { organizationId, branchId, printerId: { in: printers.map(p => p.id) }, state: { in: ['queued', 'sending', 'uncertain', 'blocked'] } }, _count: true })
  return printers.map(p => ({
    id: p.id, name: p.name, stationId: p.stationId, host: p.host, port: p.port, paperWidth: p.paperWidth,
    dispatcher: p.agentInstanceId ? { thisDevice: !!instanceId && p.agentInstanceId === instanceId, label: p.dispatcherLabel, lastSeenAt: p.lastSeenAt, active: dispatcherActive(p) } : null,
    jobs: Object.fromEntries(['queued', 'sending', 'uncertain', 'blocked'].map(state => [state, counts.find(c => c.printerId === p.id && c.state === state)?._count ?? 0])),
  }))
}
export async function takeOverLocalDispatch(organizationId: string, body: z.infer<typeof takeOverSchema>, canAdminister: boolean, audit: (db: Prisma.TransactionClient, previous: { id: string; instanceId: string | null; label: string | null }[]) => Promise<void>) {
  return prisma.$transaction(async db => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${body.branchId}`}))`
    const listed = await db.networkKitchenPrinter.findMany({ where: { organizationId, branchId: body.branchId, enabled: true, deliveryMode: 'ipad' }, orderBy: { id: 'asc' } })
    if (!listed.length) throw new AppError('No printers use the cashier-device connection in this branch', 404, 'NOT_FOUND')
    for (const p of listed) {
      await assertPrinterOwner(p, db)
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
    }
    const printers = await db.networkKitchenPrinter.findMany({ where: { id: { in: listed.map(p => p.id) } } })
    const active = printers.find(p => p.agentInstanceId && p.agentInstanceId !== body.instanceId && dispatcherActive(p))
    if (active && !canAdminister) throw new AppError(`${active.dispatcherLabel || 'Another cashier device'} is dispatching right now. Close FoodSync on that device and wait one minute, or ask a manager to take over.`, 409, 'DISPATCHER_ACTIVE')
    if (await db.kitchenPrintJob.count({ where: { printerId: { in: printers.map(p => p.id) }, state: { in: ['sending', 'uncertain'] } } })) throw new AppError('A kitchen slip is being sent or awaits a paper check. Review it in Kitchen before changing the dispatching device.', 409, 'PRINT_IN_PROGRESS')
    await db.networkKitchenPrinter.updateMany({ where: { id: { in: printers.map(p => p.id) } }, data: { agentInstanceId: body.instanceId, dispatcherLabel: body.label, lastSeenAt: new Date() } })
    await audit(db, printers.map(p => ({ id: p.id, instanceId: p.agentInstanceId, label: p.dispatcherLabel })))
    return { printerIds: printers.map(p => p.id) }
  })
}
export function newAgentToken() { const token = randomBytes(32).toString('hex'); return { token, hash: createHash('sha256').update(token).digest('hex') } }
