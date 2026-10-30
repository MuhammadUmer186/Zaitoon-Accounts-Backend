import { prisma } from '../config'
import { flushBranchOutbox } from './branchSync'
import { publishBranchReplica } from './branchReplicaTransport'

// Branch PC side of an ownership handover. The PC keeps trading until nothing
// is in flight, then freezes business writes (enforced by the database
// ownership trigger), confirms its final checkpoint and asks the cloud to
// release ownership. A frozen PC never resumes writing.
type Runtime = { organizationId: string; branchId: string; writesFrozen: string | null }

async function blockers(db: Pick<typeof prisma, 'customerOrder' | 'tillSession' | 'riderCashCollection' | 'paymentIntent' | 'branchWalletReceipt'>, runtime: Runtime) {
  const where = { organizationId: runtime.organizationId, branchId: runtime.branchId }
  const [orders, tills, riderCash, refunds, wallets] = await Promise.all([
    db.customerOrder.count({ where: { ...where, status: { notIn: ['completed', 'cancelled', 'refunded', 'rejected'] } } }),
    db.tillSession.count({ where: { ...where, status: 'open' } }),
    db.riderCashCollection.count({ where: { ...where, settlementId: null } }),
    db.paymentIntent.count({ where: { ...where, refundStatus: { in: ['pending', 'failed'] } } }),
    db.branchWalletReceipt.count({ where: { ...where, acknowledged: false } }),
  ])
  const list = [orders && `${orders} open order${orders === 1 ? '' : 's'}`, tills && `${tills} open till${tills === 1 ? '' : 's'}`, riderCash && `${riderCash} unsettled rider collection${riderCash === 1 ? '' : 's'}`, refunds && `${refunds} gateway refunds awaiting confirmation`].filter(Boolean)
  if (wallets) list.push(`${wallets} shared-wallet receipts waiting to synchronize`)
  return list.length ? list.join(', ') : null
}

export async function freezeReleased() {
  await prisma.branchRuntime.updateMany({ where: { id: 'local' }, data: { writesFrozen: 'released', handoverState: 'The cloud released this PC\'s ownership of the branch. No new transactions can be recorded here.' } })
}

export async function advanceHandover(endpoint: string, token: string) {
  let runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || runtime.writesFrozen === 'released') return
  if (!runtime.writesFrozen) {
    // Freeze under the same lock every business write takes, re-checking the
    // blockers inside it so no order can start between the check and the freeze.
    const waiting = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${runtime!.branchId}`}))`
      const open = await blockers(tx, runtime!)
      if (open) { await tx.branchRuntime.update({ where: { id: 'local' }, data: { handoverState: `Handover requested. Waiting for: ${open}.` } }); return open }
      await tx.branchRuntime.update({ where: { id: 'local' }, data: { writesFrozen: 'handover', handoverState: 'Handover in progress: sending final records to the cloud.' } })
      return null
    })
    if (waiting) return
  }
  // Final records. Both steps are retried on the next loop until confirmed.
  if (await flushBranchOutbox() === false) return
  await publishBranchReplica()
  runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || runtime.dataRevision !== runtime.lastReplicaRevision || !runtime.lastReplicaDigest) return
  const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/handover/complete`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: runtime.lastReplicaRevision.toString(), digest: runtime.lastReplicaDigest }), redirect: 'error', signal: AbortSignal.timeout(30000) }).catch(() => null)
  if (response?.ok) await prisma.branchRuntime.update({ where: { id: 'local' }, data: { writesFrozen: 'released', handoverState: `Handed over to the cloud at ${new Date().toISOString()}. No new transactions can be recorded here.` } })
}
