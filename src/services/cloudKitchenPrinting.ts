import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { enqueueKitchenPrinter } from './kitchenPrinting'

const printerSchema = z.object({
  id: z.string().regex(/^cloud-[a-zA-Z0-9_-]{1,34}$/),
  organizationId: z.string().min(1), branchId: z.string().min(1), stationId: z.string().min(1),
  key: z.string().regex(/^[a-f0-9]{64}$/), enabledAt: z.string().datetime(),
}).strict()
export type CloudKitchenPrinter = z.infer<typeof printerSchema>

export function readCloudKitchenPrinters(): CloudKitchenPrinter[] {
  const printers = z.array(printerSchema).max(8).parse(JSON.parse(process.env.KITCHEN_CLOUD_PRINTERS_JSON || '[]'))
  for (const field of ['id', 'key'] as const) {
    if (new Set(printers.map(p => p[field])).size !== printers.length) throw new Error('Duplicate cloud printer identity')
  }
  if (new Set(printers.map(p => `${p.organizationId}:${p.branchId}:${p.stationId}`)).size !== printers.length) throw new Error('Duplicate cloud station routing')
  return printers
}

export function authenticateCloudPrinter(id: string, authorization: string | undefined) {
  let printers: CloudKitchenPrinter[]
  try { printers = readCloudKitchenPrinters() } catch { throw new AppError('Printer configuration needs administrator review', 503, 'PRINTER_CONFIGURATION') }
  const printer = printers.find(p => p.id === id)
  const supplied = authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] || ''
  const expected = printer?.key || '0'.repeat(64)
  const matches = timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(expected).digest())
  if (!printer || !supplied || !matches) throw new AppError('Printer authentication failed', 401, 'UNAUTHORIZED')
  return printer
}

async function assertCloudBranch(p: CloudKitchenPrinter) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch' || await prisma.branchRuntime.findUnique({ where: { id: 'local' } })) throw new AppError('Use the cloud portal for this printer', 409, 'NOT_CLOUD')
  if (!await prisma.branch.count({ where: { id: p.branchId, organizationId: p.organizationId, isActive: true } })) throw new AppError('Printer branch unavailable', 409, 'PRINTER_BRANCH')
  if (await prisma.branchSyncNode.count({ where: { organizationId: p.organizationId, branchId: p.branchId, ownsWrites: true } })) throw new AppError('This branch prints through its branch PC', 409, 'BRANCH_OWNED')
  if (p.stationId !== 'none' && !await prisma.kitchenStation.count({ where: { id: p.stationId, organizationId: p.organizationId, isActive: true } })) throw new AppError('Printer station unavailable', 409, 'PRINTER_STATION')
}

export async function cloudKitchenStations(organizationId: string, branchId: string) {
  const printers = readCloudKitchenPrinters().filter(p => p.organizationId === organizationId && p.branchId === branchId)
  if (!printers.length) return []
  await assertCloudBranch(printers[0])
  return printers.map(p => p.stationId)
}

const scope = (p: CloudKitchenPrinter) => ({ organizationId: p.organizationId, branchId: p.branchId, printerId: p.id })
export async function pollCloudKitchenPrinter(p: CloudKitchenPrinter): Promise<Buffer | null> {
  await assertCloudBranch(p)
  // Reuse paid-order selection, station routing, held courses, cancellation and rendering.
  await enqueueKitchenPrinter(p, 'cloud')
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${p.branchId}`}))`
    if (await tx.branchSyncNode.count({ where: { organizationId: p.organizationId, branchId: p.branchId, ownsWrites: true } })) throw new AppError('This branch prints through its branch PC', 409, 'BRANCH_OWNED')
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
    if (await tx.kitchenPrintJob.count({ where: { ...scope(p), state: 'uncertain' } })) throw new AppError('Check the printer and resolve its held job in Kitchen', 409, 'PRINT_UNCERTAIN')
    // An unacknowledged frame is offered again with exactly the same sequence.
    // The device journal returns the previous result without repeating USB output.
    let job = await tx.kitchenPrintJob.findFirst({ where: { ...scope(p), state: 'sending' }, orderBy: { sequence: 'asc' } })
    if (!job) {
      job = await tx.kitchenPrintJob.findFirst({ where: { ...scope(p), state: 'queued' }, orderBy: { sequence: 'asc' } })
      if (!job) return null
      const order = await tx.customerOrder.findFirst({ where: { id: job.orderId, organizationId: p.organizationId, branchId: p.branchId }, include: { items: true } })
      if (job.kind === 'new' && (!order || order.status !== 'completed' || (job.itemIds as string[]).some(id => !order.items.some(i => i.id === id && !i.held && ['pending', 'preparing', 'ready'].includes(i.status))))) {
        await tx.kitchenPrintJob.update({ where: { id: job.id }, data: { state: 'suppressed', lastError: 'Order changed before printer claim' } })
        return null
      }
      job = await tx.kitchenPrintJob.update({ where: { id: job.id }, data: { state: 'sending', attempts: { increment: 1 }, lastError: null } })
    }
    const bytes = Buffer.from(job.payload, 'base64')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const mac = createHmac('sha256', p.key).update(`${job.sequence}:${job.id}:${bytes.length}:${digest}`).digest('hex')
    return Buffer.concat([Buffer.from(`FS1 ${job.sequence} ${job.id} ${bytes.length} ${digest} ${mac}\n`), bytes])
  })
}

export const cloudAckSchema = z.object({ jobId: z.string().uuid(), sequence: z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n), reply: z.string().min(1).max(90), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export async function acknowledgeCloudKitchenPrinter(p: CloudKitchenPrinter, ack: z.infer<typeof cloudAckSchema>) {
  await assertCloudBranch(p)
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
    const job = await tx.kitchenPrintJob.findFirst({ where: { ...scope(p), id: ack.jobId, sequence: BigInt(ack.sequence) } })
    if (!job) throw new AppError('Print job not found', 404, 'NOT_FOUND')
    const digest = createHash('sha256').update(Buffer.from(job.payload, 'base64')).digest('hex')
    const expected = createHmac('sha256', p.key).update(`ACK:${job.sequence}:${job.id}:${digest}:${ack.reply}`).digest()
    if (!timingSafeEqual(expected, Buffer.from(ack.signature, 'hex'))) throw new AppError('Invalid printer acknowledgement', 401, 'UNAUTHORIZED')
    const state = ack.reply === `OK ${job.id}` ? 'usb_complete' : ['ERROR NOT_READY', 'ERROR BUSY'].includes(ack.reply) ? 'queued' : ack.reply === 'ERROR AUTH' ? 'blocked' : 'uncertain'
    if (job.state !== 'sending') {
      if (job.state === state) return { state }
      throw new AppError('Print job was already resolved; check Kitchen', 409, 'PRINT_STATE')
    }
    await tx.kitchenPrintJob.update({ where: { id: job.id }, data: { state, lastError: state === 'usb_complete' ? null : state === 'queued' ? 'Device not ready; queued for retry' : 'Check physical printer before resolving this job' } })
    return { state }
  })
}
