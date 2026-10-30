import { AppError } from '../middleware/error'

// Document numbers and user-entered codes are unique per organization, while a
// branch PC and the cloud (or two PCs) issue them independently. Each PC owns
// a series assigned at enrollment ("P1", "P2", ...): its numbers and codes carry
// that series, so they can never collide with the cloud or another PC when
// the PC's records are synchronized into the central ERP.
type RuntimeReader = { branchRuntime: { findUnique(args: unknown): Promise<{ nodeId: string; numberSeries: string | null } | null> } }
type NodeReader = { branchSyncNode: { findMany(args: unknown): Promise<{ id: string; numberSeries: string | null }[]> } }

// Installations enrolled before series assignment fall back to a stable
// node-derived series; enrollment always assigns one now.
const fallbackSeries = (nodeId: string) => `P${nodeId.replace(/-/g, '').slice(0, 8).toUpperCase()}`

export async function branchNumberSeries(db: unknown): Promise<string | null> {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return null
  const runtime = await (db as RuntimeReader).branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime) throw new AppError('This PC is not provisioned for a branch yet', 503, 'BRANCH_RUNTIME_MISSING')
  return runtime.numberSeries ?? fallbackSeries(runtime.nodeId)
}

// For codes people type (employee codes): on a PC they must use its series;
// in the cloud they must not use any enrolled PC's series.
export async function assertCodeSeries(db: unknown, organizationId: string, code: string) {
  const series = await branchNumberSeries(db)
  if (series) {
    if (!code.startsWith(`${series}-`)) throw new AppError(`Codes created on this branch PC must start with ${series}- so they stay unique across branches.`, 409, 'CODE_SERIES_REQUIRED')
    return
  }
  const nodes = await (db as NodeReader).branchSyncNode.findMany({ where: { organizationId }, select: { id: true, numberSeries: true } })
  const reserved = nodes.map(n => n.numberSeries ?? fallbackSeries(n.id)).find(s => code.startsWith(`${s}-`))
  if (reserved) throw new AppError(`Codes starting with ${reserved}- are reserved for a branch PC.`, 409, 'CODE_SERIES_RESERVED')
}
