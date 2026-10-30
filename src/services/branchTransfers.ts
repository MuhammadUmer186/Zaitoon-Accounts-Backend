import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { Request } from 'express'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { getUserPermissions } from '../utils/permissions'
import { walletNode, callWallet } from './branchWallets'
import { replicaDigest } from './branchReplica'
import { applyStockOut, applyStockIn } from '../utils/stock'
import { logAudit } from '../utils/audit'
import { publish } from '../utils/liveEvents'

const id = z.string().min(1).max(100)
const line = z.object({ itemId: id, quantity: z.number().finite().positive().max(10000000) }).strict()
const lines = z.array(line).min(1).max(100).refine(rows => new Set(rows.map(row => row.itemId)).size === rows.length, 'Each item may appear once')
const startSchema = z.object({ requestId: z.string().uuid(), destinationBranchId: id, items: lines, actorId: id }).strict()
const dispatchSchema = z.object({ transferId: z.string().uuid(), items: z.array(line.extend({ unitCost: z.number().finite().min(0).max(100000000) })).min(1).max(100).refine(rows => new Set(rows.map(row => row.itemId)).size === rows.length, 'Duplicate transfer item') }).strict()
// stock-return: an audited cancellation puts dispatched goods back at the source.
export const transferKinds = ['stock-dispatch', 'stock-receive', 'stock-return'] as const
type Node = { id: string; organizationId: string; branchId: string }
async function permission(node: Node, actorId: string) {
  const access = await getUserPermissions(prisma, actorId)
  const user = await prisma.user.findFirst({ where: { id: actorId, organizationId: node.organizationId, isActive: true } })
  if (!user || !['can_manage_inventory', 'can_transfer_stock'].some(key => access.permissions.has(key))) throw new AppError('Current cloud stock-transfer permission is required', 403, 'FORBIDDEN')
  const req = { user: { id: user.id, organizationId: user.organizationId, email: user.email } } as Request
  await assertBranchAccess(req, node.branchId)
  return req
}
async function queue(tx: Prisma.TransactionClient, node: Node, transferId: string, kind: typeof transferKinds[number], payload: Record<string, unknown>) {
  const key = `${kind}:${transferId}`
  await tx.branchRemoteCommand.create({ data: { nodeId: node.id, organizationId: node.organizationId, branchId: node.branchId, key, publicId: transferId, kind, digest: replicaDigest(payload), payload: payload as Prisma.InputJsonObject, expiresAt: new Date('9999-01-01T00:00:00Z') } })
}
export async function startStockTransfer(token: string, input: unknown) {
  const data = startSchema.parse(input)
  return prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    const req = await permission(node, data.actorId)
    // Concurrent retries of one request create one transfer.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-transfer:${data.requestId}`}))`
    const digest = replicaDigest({ ...data, items: [...data.items].sort((a, b) => a.itemId.localeCompare(b.itemId)) })
    const previous = await tx.branchStockTransfer.findUnique({ where: { id: data.requestId } })
    if (previous) {
      if (previous.sourceNodeId !== node.id || previous.digest !== digest) throw new AppError('Transfer request was reused with different details', 409, 'TRANSFER_REPLAY_CONFLICT')
      return previous
    }
    if (data.destinationBranchId === node.branchId) throw new AppError('Choose another branch', 400, 'VALIDATION_ERROR')
    const destination = await tx.branchSyncNode.findFirst({ where: { organizationId: node.organizationId, branchId: data.destinationBranchId, ownsWrites: true, isActive: true, handoverRequestedAt: null } })
    if (!destination || !await tx.branch.count({ where: { id: data.destinationBranchId, organizationId: node.organizationId, isActive: true } }) || node.handoverRequestedAt) throw new AppError('Both branches must have active enrolled PCs outside handover', 409, 'TRANSFER_BRANCH_UNAVAILABLE')
    if (await tx.item.count({ where: { id: { in: data.items.map(row => row.itemId) }, organizationId: node.organizationId } }) !== data.items.length) throw new AppError('An item is missing from the central catalog', 409, 'TRANSFER_ITEM_UNAVAILABLE')
    const transfer = await tx.branchStockTransfer.create({ data: { id: data.requestId, organizationId: node.organizationId, sourceBranchId: node.branchId, destinationBranchId: data.destinationBranchId, sourceNodeId: node.id, destinationNodeId: destination.id, actorId: data.actorId, digest, items: data.items } })
    await queue(tx, node, transfer.id, 'stock-dispatch', { transferId: transfer.id, organizationId: node.organizationId, branchId: node.branchId, otherBranchId: destination.branchId, actorId: data.actorId, items: data.items })
    await logAudit(tx, { req, action: 'request_branch_stock_transfer', module: 'inventory', resourceId: transfer.id, branchId: node.branchId, newData: { destinationBranchId: destination.branchId, items: data.items } })
    return transfer
  })
}
export async function receiveStockTransfer(token: string, transferId: string, input: unknown) {
  const data = z.object({ actorId: id, confirmPhysicalReceipt: z.literal(true) }).strict().parse(input)
  return prisma.$transaction(async tx => {
    const node = await walletNode(tx, token)
    const req = await permission(node, data.actorId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-transfer:${transferId}`}))`
    const transfer = await tx.branchStockTransfer.findUnique({ where: { id: transferId } })
    if (!transfer || transfer.organizationId !== node.organizationId || transfer.destinationNodeId !== node.id) throw new AppError('Incoming transfer not found', 404, 'NOT_FOUND')
    if (['receiving', 'received'].includes(transfer.state)) return transfer
    if (!['in_transit', 'receipt_failed'].includes(transfer.state) || !transfer.dispatch) throw new AppError('Source dispatch has not been confirmed', 409, 'TRANSFER_NOT_DISPATCHED')
    const dispatch = dispatchSchema.parse(transfer.dispatch)
    const payload = { transferId, organizationId: node.organizationId, branchId: node.branchId, otherBranchId: transfer.sourceBranchId, actorId: data.actorId, items: dispatch.items }
    const prior = await tx.branchRemoteCommand.findUnique({ where: { nodeId_key: { nodeId: node.id, key: `stock-receive:${transferId}` } } })
    if (prior) await tx.branchRemoteCommand.update({ where: { id: prior.id }, data: { status: 'queued', claimToken: null, leaseUntil: null, responseStatus: null, result: Prisma.DbNull, payload, digest: replicaDigest(payload), attempts: 0 } })
    else await queue(tx, node, transferId, 'stock-receive', payload)
    const result = await tx.branchStockTransfer.update({ where: { id: transferId }, data: { state: 'receiving', error: null } })
    await logAudit(tx, { req, action: 'confirm_transfer_physical_receipt', module: 'inventory', resourceId: transferId, branchId: node.branchId })
    return result
  })
}
export async function transferView(token: string, actorId: string) {
  const node = await prisma.$transaction(tx => walletNode(tx, token))
  await permission(node, actorId)
  return {
    branchId: node.branchId,
    branches: await prisma.branch.findMany({ where: { organizationId: node.organizationId, isActive: true, id: { in: (await prisma.branchSyncNode.findMany({ where: { organizationId: node.organizationId, isActive: true, ownsWrites: true, handoverRequestedAt: null }, select: { branchId: true } })).map(n => n.branchId) } }, select: { id: true, name: true, code: true } }),
    data: await prisma.branchStockTransfer.findMany({ where: { organizationId: node.organizationId, OR: [{ sourceNodeId: node.id }, { destinationNodeId: node.id }] }, orderBy: { createdAt: 'desc' }, take: 100 }),
  }
}
export async function applyStockTransfer(kind: string, input: unknown, branchId: string) {
  const schema = z.object({ transferId: z.string().uuid(), organizationId: id, branchId: id, otherBranchId: id, actorId: id, items: kind === 'stock-dispatch' ? lines : dispatchSchema.shape.items }).strict()
  const data = schema.parse(input), runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || data.organizationId !== runtime.organizationId || data.branchId !== runtime.branchId || branchId !== runtime.branchId || !transferKinds.includes(kind as typeof transferKinds[number])) throw new AppError('Transfer belongs to another branch', 403, 'BRANCH_FORBIDDEN')
  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${branchId}`}))`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`local-stock-transfer:${data.transferId}`}))`
    const receiptId = `${kind}:${data.transferId}`, digest = replicaDigest(data)
    const receipt = await tx.branchTransferReceipt.findUnique({ where: { id: receiptId } })
    if (receipt) {
      if (receipt.digest !== digest || receipt.branchId !== branchId) throw new AppError('Transfer command changed after posting', 409, 'TRANSFER_REPLAY_CONFLICT')
      return receipt.result
    }
    const current = await tx.branchRuntime.findUniqueOrThrow({ where: { id: 'local' } })
    if (current.writesFrozen || current.replicaChainError) throw new AppError('Transfer waits for branch ownership recovery', 503, 'BRANCH_RECOVERY_REQUIRED')
    const valued: { itemId: string; quantity: number; unitCost: number }[] = []
    for (const row of [...data.items].sort((a, b) => a.itemId.localeCompare(b.itemId))) {
      // Lock the existing stock row before reading its cost/quantity. All
      // ordinary inventory updates acquire the row lock when updating it.
      await tx.$queryRaw`SELECT id FROM "BranchStock" WHERE "branchId"=${branchId} AND "itemId"=${row.itemId} FOR UPDATE`
      if (!await tx.item.count({ where: { id: row.itemId, organizationId: current.organizationId } })) throw new AppError('Wait for catalog synchronization before receiving', 409, 'TRANSFER_ITEM_UNAVAILABLE')
      const common = { organizationId: current.organizationId, branchId, itemId: row.itemId, quantity: row.quantity, referenceType: 'branch_transfer', referenceId: data.transferId, createdBy: data.actorId, notes: `Branch transfer ${data.transferId}`, transferBranchId: data.otherBranchId }
      if (kind === 'stock-dispatch') {
        const removed = await applyStockOut(tx as unknown as typeof prisma, { ...common, movementType: 'transfer_out' })
        valued.push({ itemId: row.itemId, quantity: row.quantity, unitCost: removed.unitCost })
      } else {
        const unitCost = (row as unknown as { unitCost: number }).unitCost
        await applyStockIn(tx as unknown as typeof prisma, { ...common, unitCost, movementType: kind === 'stock-return' ? 'transfer_return' : 'transfer_in' })
        valued.push({ itemId: row.itemId, quantity: row.quantity, unitCost })
      }
    }
    const outcome = { transferId: data.transferId, items: valued }
    await tx.branchTransferReceipt.create({ data: { id: receiptId, organizationId: current.organizationId, branchId, transferId: data.transferId, digest, result: outcome } })
    return outcome
  }, { timeout: 30000 })
  publish({ topic: 'availability', action: 'branch_transfer', organizationId: runtime.organizationId, branchId })
  return result
}
export async function acknowledgeStockTransfer(tx: Prisma.TransactionClient, command: { kind: string; publicId: string | null; nodeId: string; payload: Prisma.JsonValue }, response: { status: number; result: unknown }) {
  if (!transferKinds.includes(command.kind as typeof transferKinds[number])) return
  if (!command.publicId) throw new AppError('Transfer command has no reference', 400, 'TRANSFER_INVALID')
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-transfer:${command.publicId}`}))`
  const transfer = await tx.branchStockTransfer.findUniqueOrThrow({ where: { id: command.publicId } })
  const dispatching = command.kind === 'stock-dispatch', returning = command.kind === 'stock-return'
  if (command.nodeId !== (dispatching || returning ? transfer.sourceNodeId : transfer.destinationNodeId)) throw new AppError('Transfer node mismatch', 403, 'BRANCH_FORBIDDEN')
  if (returning) {
    // The goods are back in the source's stock at their dispatch cost.
    if (response.status >= 300) { await tx.branchStockTransfer.update({ where: { id: transfer.id }, data: { error: 'The source branch could not post the return yet; it retries.' } }); return }
    if (replicaDigest(dispatchSchema.parse(response.result)) !== replicaDigest(transfer.dispatch)) throw new AppError('Returned costs differ from the dispatch', 409, 'TRANSFER_REPLAY_CONFLICT')
    await tx.branchStockTransfer.update({ where: { id: transfer.id }, data: { state: 'returned', error: null } }); return
  }
  if (response.status >= 300) {
    await tx.branchStockTransfer.update({ where: { id: transfer.id }, data: { state: dispatching ? 'dispatch_failed' : 'receipt_failed', error: 'The branch refused this transfer. Check stock, catalog and branch status before retrying.' } }); return
  }
  const result = dispatchSchema.parse(response.result)
  const original = lines.parse(transfer.items)
  if (result.transferId !== transfer.id || result.items.length !== original.length || result.items.some(row => !original.some(item => row.itemId === item.itemId && row.quantity === item.quantity))) throw new AppError('Transfer acknowledgment differs from dispatch', 409, 'TRANSFER_REPLAY_CONFLICT')
  if (!dispatching && replicaDigest(result) !== replicaDigest(transfer.dispatch)) throw new AppError('Received costs differ from the source dispatch', 409, 'TRANSFER_REPLAY_CONFLICT')
  await tx.branchStockTransfer.update({ where: { id: transfer.id }, data: { state: dispatching ? 'in_transit' : 'received', ...(dispatching && { dispatch: result }), error: null } })
}
// Use the same HTTPS/token transport; only fixed transfer paths are accepted.
export async function localTransferCall(route: 'start' | 'view' | 'receive', actorId: string, input: Record<string, unknown> = {}) {
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || runtime.writesFrozen || runtime.replicaChainError) throw new AppError('Branch ownership recovery is required', 409, 'BRANCH_RECOVERY_REQUIRED')
  return callWallet(`../transfers/${route}`, { ...input, actorId })
}

// Audited cancellation for goods that never arrived (for example a lost
// destination PC). Never while a destination receipt may be posting, and never
// by assumption: an operator confirms the goods did not arrive and gives a
// reason. Dispatched goods return to the source at their dispatch cost.
export async function cancelStockTransfer(req: Request, transferId: string, input: unknown) {
  const body = z.object({ reason: z.string().trim().min(20).max(500), confirmNotReceived: z.literal(true) }).strict().parse(input)
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`stock-transfer:${transferId}`}))`
    const transfer = await tx.branchStockTransfer.findFirst({ where: { id: transferId, organizationId: req.user.organizationId } })
    if (!transfer) throw new AppError('Transfer not found', 404, 'NOT_FOUND')
    await assertBranchAccess(req, transfer.sourceBranchId)
    const commands = await tx.branchRemoteCommand.findMany({ where: { publicId: transferId, kind: { in: ['stock-dispatch', 'stock-receive'] } } })
    if (commands.some(c => c.status === 'claimed')) throw new AppError('A branch is posting this transfer right now. Try again once it reports back.', 409, 'TRANSFER_IN_FLIGHT')
    const receive = commands.find(c => c.kind === 'stock-receive')
    if (transfer.state === 'queued') {
      // Not dispatched: nothing left the source.
      await tx.branchRemoteCommand.updateMany({ where: { publicId: transferId, kind: 'stock-dispatch', status: 'queued' }, data: { status: 'cancelled', payload: {} } })
      return tx.branchStockTransfer.update({ where: { id: transferId }, data: { state: 'cancelled', error: body.reason } })
    }
    if (!['in_transit', 'receipt_failed'].includes(transfer.state) || (receive && receive.status === 'completed' && (receive.responseStatus ?? 500) < 300)) throw new AppError('Only goods that were dispatched and not received can be returned', 409, 'TRANSFER_NOT_RETURNABLE')
    if (receive) await tx.branchRemoteCommand.update({ where: { id: receive.id }, data: { status: 'cancelled', payload: {} } })
    const source = await tx.branchSyncNode.findFirst({ where: { id: transfer.sourceNodeId, isActive: true, ownsWrites: true } })
    if (!source) throw new AppError('The source branch PC is not active; restore it before returning the goods', 409, 'TRANSFER_SOURCE_UNAVAILABLE')
    const dispatch = dispatchSchema.parse(transfer.dispatch)
    await queue(tx, source, transferId, 'stock-return', { transferId, organizationId: source.organizationId, branchId: source.branchId, otherBranchId: transfer.destinationBranchId, actorId: req.user.id, items: dispatch.items })
    await logAudit(tx, { req, action: 'return_branch_stock_transfer', module: 'inventory', resourceId: transferId, branchId: transfer.sourceBranchId, newData: { reason: body.reason, items: dispatch.items } })
    return tx.branchStockTransfer.update({ where: { id: transferId }, data: { state: 'returning', error: body.reason } })
  })
}
