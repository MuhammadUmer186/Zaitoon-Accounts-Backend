import { createHash } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'
import { branchSchemaFingerprint } from './branchProvisioning'
import { prepareMedia } from './branchMedia'

// Only branch-owned business rows are replicated into the central ERP.
// Master catalogs and staff credentials remain centrally controlled.
export const replicaEntities = ['BranchSection', 'JournalEntry', 'JournalLine', 'DailySale', 'DeliveryBreakdown', 'CashClosing', 'Expense', 'Bill', 'BillItem', 'Payment', 'BranchStock', 'StockMovement', 'StockOut', 'WastageReport', 'WastageItem', 'PurchaseOrder', 'PurchaseOrderItem', 'DishOutOfStock', 'DiningTable', 'CustomerOrder', 'CustomerOrderItem', 'OrderCheck', 'DeliveryZone', 'Rider', 'DeliveryEvent', 'RiderCashCollection', 'RiderSettlement', 'TillSession', 'TillMovement', 'TillPayment', 'ZReport', 'OrderReview', 'Document', 'HrEmployee', 'HrRecord', 'HrAttendance', 'HrLeaveRequest', 'HrPayrollRun', 'HrPayrollLine', 'HrPayrollPayment', 'ZatcaDevice', 'ZatcaDocument', 'CustomerReceipt'] as const
export const appendOnlyEntities = new Set(['ZatcaDevice', 'ZatcaDocument'])
// The PC seals device secrets with its own key; the cloud keeps its own sealed copies.
const SEALED_FIELDS = ['privateKeySealed', 'complianceSecretSealed', 'productionSecretSealed']
const stripSealed = (name: string, rows: Row[]) => { if (name === 'ZatcaDevice') for (const row of rows) for (const field of SEALED_FIELDS) delete row[field] }
type Row = Record<string, unknown>
const modelMap = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, model]))
const childParents: Record<string, [string, string]> = { JournalLine: ['JournalEntry', 'journalEntryId'], DeliveryBreakdown: ['DailySale', 'dailySaleId'], BillItem: ['Bill', 'billId'], WastageItem: ['WastageReport', 'wastageReportId'], PurchaseOrderItem: ['PurchaseOrder', 'purchaseOrderId'], CustomerOrderItem: ['CustomerOrder', 'orderId'], DeliveryEvent: ['CustomerOrder', 'orderId'], TillMovement: ['TillSession', 'sessionId'], HrPayrollLine: ['HrPayrollRun', 'runId'], HrPayrollPayment: ['HrPayrollLine', 'lineId'] }
const api = (tx: Prisma.TransactionClient, name: string) => (tx as unknown as Record<string, { findMany: (args: unknown) => Promise<Row[]>; findUnique: (args: unknown) => Promise<Row | null>; upsert: (args: unknown) => Promise<unknown>; update: (args: unknown) => Promise<unknown>; deleteMany: (args: unknown) => Promise<unknown> }>)[name[0].toLowerCase() + name.slice(1)]
// Stay well below PostgreSQL's 32,767 bind parameters per statement.
const ID_CHUNK = 10000
async function deleteMissing(tx: Prisma.TransactionClient, name: string, where: Row, keep: Set<string>) {
  const existing = await api(tx, name).findMany({ where, select: { id: true } })
  const gone = existing.map(row => String(row.id)).filter(id => !keep.has(id))
  for (let i = 0; i < gone.length; i += ID_CHUNK) await api(tx, name).deleteMany({ where: { id: { in: gone.slice(i, i + ID_CHUNK) } } })
}
export function replicaDigest(input: unknown): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
    return JSON.stringify(value)
  }
  return createHash('sha256').update(stable(input)).digest('hex')
}

export async function buildBranchReplica(db: PrismaClient) {
  return db.$transaction(async tx => {
    const runtime = await tx.branchRuntime.findUnique({ where: { id: 'local' } })
    if (!runtime) throw new AppError('Branch runtime missing', 409, 'BRANCH_RUNTIME_MISSING')
    const tables: Record<string, Row[]> = {}
    let rows = 0
    // Children are selected through their parent relation, never through an
    // id list: an IN list stops working past PostgreSQL's 32,767 parameters.
    const scope = (name: string): Row => {
      const parent = childParents[name]
      if (!parent) return { organizationId: runtime.organizationId, branchId: runtime.branchId }
      const relation = modelMap.get(name)!.fields.find(f => f.kind === 'object' && f.relationFromFields?.includes(parent[1]))!
      return { [relation.name]: scope(parent[0]) }
    }
    for (const name of replicaEntities) {
      if (childParents[name] && !tables[childParents[name][0]]) throw new Error('Replica entity ordering is invalid')
      const data = name.startsWith('Hr') && !runtime.syncHr ? [] : await api(tx, name).findMany({ where: scope(name), orderBy: { id: 'asc' }, take: 50001 })
      if (data.length > 50000 || (rows += data.length) > 250000) throw new AppError('Branch replica requires a larger reviewed transport limit', 413, 'REPLICA_TOO_LARGE')
      // Source paths are host-specific. File content is transferred separately.
      stripSealed(name, data)
      tables[name] = data
    }
    const customerIds = [...new Set((tables.CustomerOrder ?? []).flatMap(row => row.customerId ? [String(row.customerId)] : []))]
    tables.Customer = []
    for (let i = 0; i < customerIds.length; i += ID_CHUNK) tables.Customer.push(...await tx.customer.findMany({ where: { organizationId: runtime.organizationId, id: { in: customerIds.slice(i, i + ID_CHUNK) } } }) as unknown as Row[])
    tables.Customer.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    await prepareMedia(tables, runtime)
    // JSON serialization makes Decimal and Date values transport-stable.
    return JSON.parse(JSON.stringify({ version: 1, schema: branchSchemaFingerprint, nodeId: runtime.nodeId, organizationId: runtime.organizationId, branchId: runtime.branchId, revision: runtime.dataRevision.toString(), tables })) as { version: number; schema: string; nodeId: string; organizationId: string; branchId: string; revision: string; tables: Record<string, Row[]> }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120000 })
}

type ReplicaNode = { id: string; organizationId: string; branchId: string }
// A row belongs to the node's branch directly or through its parent chain.
function ownership(tx: Prisma.TransactionClient, node: ReplicaNode) {
  return async function owned(name: string, row: Row): Promise<boolean> {
    if (row.organizationId && row.organizationId !== node.organizationId || row.branchId && row.branchId !== node.branchId) return false
    const parent = childParents[name]
    if (!parent) return row.organizationId === node.organizationId && row.branchId === node.branchId
    const owner = await api(tx, parent[0]).findUnique({ where: { id: String(row[parent[1]]) } })
    return !!owner && owned(parent[0], owner)
  }
}
// Shape, identity and field checks shared by full and incremental checkpoints.
function checkRows(tables: Record<string, Row[]>, node: ReplicaNode) {
  const rowIds = new Map<string, Set<string>>()
  let count = 0
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows) || rows.length > 50000 || (count += rows.length) > 250000) throw new AppError('ERP replica size limit exceeded', 413, 'REPLICA_TOO_LARGE')
    const fields = modelMap.get(name)!.fields
    const ids = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || ids.has(row.id)) throw new AppError('Invalid or duplicate replica row', 400, 'REPLICA_INVALID')
      ids.add(row.id)
      if (fields.some(f => f.name === 'organizationId') && row.organizationId !== node.organizationId || fields.some(f => f.name === 'branchId') && row.branchId !== node.branchId) throw new AppError('ERP replica crosses branch ownership', 403, 'BRANCH_FORBIDDEN')
      for (const key of Object.keys(row)) if (!fields.some(f => f.name === key && f.kind !== 'object')) throw new AppError('Unexpected replica field', 400, 'REPLICA_INVALID')
    }
    rowIds.set(name, ids)
  }
  return { rowIds, count }
}
async function aliasCustomers(tx: Prisma.TransactionClient, node: ReplicaNode, customers: Row[]) {
  // Only the authenticated receiver sets this transaction-local marker. The
  // ownership trigger still verifies the exact owning node and target branch.
  await tx.$executeRaw`SELECT set_config('foodsync.replica_node', ${node.id}, true)`
  const aliases = new Map<string, string>()
  for (const row of customers) {
    const existingId = await tx.customer.findUnique({ where: { id: String(row.id) } })
    if (existingId && existingId.organizationId !== node.organizationId) throw new AppError('Customer identity collision', 403, 'BRANCH_FORBIDDEN')
    const existingPhone = await tx.customer.findUnique({ where: { organizationId_phone: { organizationId: node.organizationId, phone: String(row.phone) } } })
    const customerId = existingId?.id ?? existingPhone?.id ?? String(row.id)
    aliases.set(String(row.id), customerId)
    // Shared wallets and cross-branch customer totals are never overwritten by
    // a disconnected PC. New customer contact details are safe to create.
    if (!existingId && !existingPhone) await tx.customer.create({ data: { id: customerId, organizationId: node.organizationId, phone: String(row.phone), name: String(row.name), email: typeof row.email === 'string' ? row.email : null } })
  }
  return aliases
}

export async function reconcileBranchReplica(tx: Prisma.TransactionClient, node: ReplicaNode, tables: Record<string, Row[]>) {
  if (Object.keys(tables).some(name => name !== 'Customer' && !(replicaEntities as readonly string[]).includes(name)) || replicaEntities.some(name => !Array.isArray(tables[name])) || !Array.isArray(tables.Customer)) throw new AppError('Incomplete ERP replica', 400, 'REPLICA_INVALID')
  const owned = ownership(tx, node)
  const { rowIds, count } = checkRows(tables, node)
  for (const [name, parent] of Object.entries(childParents)) for (const row of tables[name]) if (!rowIds.get(parent[0])!.has(String(row[parent[1]]))) throw new AppError('Replica child has a missing parent', 400, 'REPLICA_INVALID')
  const aliases = await aliasCustomers(tx, node, tables.Customer)
  const present = new Set<string>(['Organization', 'Branch', 'Customer']), pending = new Set<string>(replicaEntities)
  const patches: { name: string; id: string; data: Row }[] = [], order: string[] = []
  // Missing child rows are removed before applying new sets. Historical parent
  // records are removed only after all references have been reconciled below.
  for (const name of [...replicaEntities].reverse()) {
    const parent = childParents[name]
    if (!parent) continue
    const relation = modelMap.get(name)!.fields.find(f => f.kind === 'object' && f.relationFromFields?.includes(parent[1]))!
    const scope = parent[0] === 'HrPayrollLine' ? { run: { organizationId: node.organizationId, branchId: node.branchId } } : { organizationId: node.organizationId, branchId: node.branchId }
    await deleteMissing(tx, name, { [relation.name]: scope }, rowIds.get(name)!)
  }
  while (pending.size) {
    let progressed = false
    for (const name of [...pending]) {
      const model = modelMap.get(name)!, relations = model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length === 1)
      const required = relations.filter(r => model.fields.find(f => f.name === r.relationFromFields![0])!.isRequired && pending.has(r.type))
      if (required.length && tables[name].length) continue
      for (const original of tables[name]) {
        const row = { ...original }, id = String(row.id), patch: Row = {}
        const existing = await api(tx, name).findUnique({ where: { id } })
        if (existing && !await owned(name, existing)) throw new AppError('ERP row identity collision', 403, 'BRANCH_FORBIDDEN')
        for (const relation of relations) {
          const fk = relation.relationFromFields![0], field = model.fields.find(f => f.name === fk)!
          if (row[fk] == null) continue
          if (relation.type === 'Customer') { row[fk] = aliases.get(String(row[fk])); if (!row[fk]) throw new AppError('Customer reference missing', 409, 'REPLICA_REFERENCE_MISSING') }
          else if (rowIds.has(relation.type)) {
            if (!rowIds.get(relation.type)!.has(String(row[fk]))) throw new AppError('Replica reference missing', 409, 'REPLICA_REFERENCE_MISSING')
            if (!present.has(relation.type) && !field.isRequired) { patch[fk] = row[fk]; row[fk] = null }
          } else {
            const parent = await api(tx, relation.type).findUnique({ where: { id: String(row[fk]) } })
            if (!parent || parent.organizationId && parent.organizationId !== node.organizationId || parent.branchId && parent.branchId !== node.branchId) throw new AppError('Central master reference missing or foreign', 409, 'REPLICA_REFERENCE_MISSING')
          }
        }
        for (const field of model.fields) if (field.type === 'Json' && row[field.name] === null) row[field.name] = Prisma.DbNull
        await api(tx, name).upsert({ where: { id }, create: row, update: row })
        if (Object.keys(patch).length) patches.push({ name, id, data: patch })
      }
      pending.delete(name); present.add(name); order.push(name); progressed = true
    }
    if (!progressed) throw new AppError('ERP replica dependency cycle', 409, 'REPLICA_INVALID')
  }
  for (const patch of patches) await api(tx, patch.name).update({ where: { id: patch.id }, data: patch.data })
  // Fiscal records are append-only: the cloud keeps invoices the PC never held.
  for (const name of order.reverse()) if (!childParents[name] && !appendOnlyEntities.has(name)) {
    await deleteMissing(tx, name, { organizationId: node.organizationId, branchId: node.branchId }, rowIds.get(name)!)
  }
  return { rows: count }
}

export type DeletedRow = { entity: string; id: string }
// Incremental checkpoint: the current state of every row changed since `base`
// plus tombstones for rows that no longer exist. Returns null when the change
// log cannot prove it covers every revision in (base, current]; the caller
// then sends a full checkpoint instead.
export async function buildBranchDelta(db: PrismaClient, base: bigint) {
  return db.$transaction(async tx => {
    const runtime = await tx.branchRuntime.findUnique({ where: { id: 'local' } })
    if (!runtime) throw new AppError('Branch runtime missing', 409, 'BRANCH_RUNTIME_MISSING')
    // Enrollment exports the branch from the cloud before this PC writes, so
    // the first checkpoint (base -1) is the delta from revision 0.
    const from = base < 0n ? 0n : base, to = runtime.dataRevision
    const log = await tx.branchChangeLog.findMany({ where: { revision: { gt: from, lte: to } }, select: { entity: true, entityId: true } })
    if (BigInt(log.length) !== to - from) return null
    const changed = new Map<string, Set<string>>()
    for (const entry of log) {
      if (!(replicaEntities as readonly string[]).includes(entry.entity)) continue
      if (!changed.has(entry.entity)) changed.set(entry.entity, new Set())
      changed.get(entry.entity)!.add(entry.entityId)
    }
    const tables: Record<string, Row[]> = {}, deleted: DeletedRow[] = []
    for (const name of replicaEntities) {
      const ids = [...(changed.get(name) ?? [])]
      if (!ids.length || name.startsWith('Hr') && !runtime.syncHr) continue
      const rows: Row[] = []
      for (let i = 0; i < ids.length; i += ID_CHUNK) rows.push(...await api(tx, name).findMany({ where: { id: { in: ids.slice(i, i + ID_CHUNK) } } }))
      // Source paths are host-specific. File content is transferred separately.
      stripSealed(name, rows)
      const found = new Set(rows.map(row => String(row.id)))
      for (const id of ids) if (!found.has(id)) deleted.push({ entity: name, id })
      if (rows.length) tables[name] = rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    }
    const customerIds = [...new Set((tables.CustomerOrder ?? []).flatMap(row => row.customerId ? [String(row.customerId)] : []))]
    if (customerIds.length) {
      tables.Customer = []
      for (let i = 0; i < customerIds.length; i += ID_CHUNK) tables.Customer.push(...await tx.customer.findMany({ where: { organizationId: runtime.organizationId, id: { in: customerIds.slice(i, i + ID_CHUNK) } } }) as unknown as Row[])
      tables.Customer.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    }
    await prepareMedia(tables, runtime)
    return JSON.parse(JSON.stringify({ kind: 'delta', schema: branchSchemaFingerprint, revision: to.toString(), tables, deleted })) as { kind: 'delta'; schema: string; revision: string; tables: Record<string, Row[]>; deleted: DeletedRow[] }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120000 })
}

// Applies an incremental checkpoint with the same ownership, identity and
// reference rules as a full one. References may point at rows the cloud
// already holds for this branch.
export async function applyBranchDelta(tx: Prisma.TransactionClient, node: ReplicaNode, tables: Record<string, Row[]>, deleted: DeletedRow[]) {
  const allowed = new Set<string>([...replicaEntities, 'Customer'])
  if (Object.keys(tables).some(name => !allowed.has(name)) || !Array.isArray(deleted) || deleted.some(d => !d || typeof d.id !== 'string' || !(replicaEntities as readonly string[]).includes(d.entity))) throw new AppError('Invalid incremental ERP checkpoint', 400, 'REPLICA_INVALID')
  const owned = ownership(tx, node)
  const { rowIds, count } = checkRows(tables, node)
  if (count + deleted.length > 250000) throw new AppError('ERP replica size limit exceeded', 413, 'REPLICA_TOO_LARGE')
  if (deleted.some(d => appendOnlyEntities.has(d.entity))) throw new AppError('Fiscal records cannot be deleted', 400, 'REPLICA_INVALID')
  const deletedIds = new Map<string, Set<string>>()
  for (const { entity, id } of deleted) {
    if (rowIds.get(entity)?.has(id)) throw new AppError('A row cannot be both changed and deleted', 400, 'REPLICA_INVALID')
    if (!deletedIds.has(entity)) deletedIds.set(entity, new Set())
    deletedIds.get(entity)!.add(id)
  }
  const aliases = await aliasCustomers(tx, node, tables.Customer ?? [])
  // Deletions run children first. One refused by a foreign key (its child was
  // re-pointed in this same checkpoint) is retried after the upserts.
  async function remove(name: string, id: string) {
    const existing = await api(tx, name).findUnique({ where: { id } })
    if (!existing) return true
    if (!await owned(name, existing)) throw new AppError('ERP row identity collision', 403, 'BRANCH_FORBIDDEN')
    await tx.$executeRawUnsafe('SAVEPOINT replica_delete')
    try {
      await api(tx, name).deleteMany({ where: { id } })
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT replica_delete')
      return true
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT replica_delete')
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT replica_delete')
      if ((error as { code?: string }).code === 'P2003') return false
      throw error
    }
  }
  const retry: [string, string][] = []
  for (const name of [...replicaEntities].reverse()) for (const id of deletedIds.get(name) ?? []) if (!await remove(name, id)) retry.push([name, id])

  const present = new Set<string>(), pending = new Set<string>(replicaEntities.filter(name => tables[name]?.length))
  const patches: { name: string; id: string; data: Row }[] = []
  while (pending.size) {
    let progressed = false
    for (const name of [...pending]) {
      const model = modelMap.get(name)!, relations = model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length === 1)
      const required = relations.filter(r => model.fields.find(f => f.name === r.relationFromFields![0])!.isRequired && pending.has(r.type))
      if (required.length) continue
      for (const original of tables[name]) {
        const row = { ...original }, id = String(row.id), patch: Row = {}
        const existing = await api(tx, name).findUnique({ where: { id } })
        if (existing && !await owned(name, existing)) throw new AppError('ERP row identity collision', 403, 'BRANCH_FORBIDDEN')
        for (const relation of relations) {
          const fk = relation.relationFromFields![0], field = model.fields.find(f => f.name === fk)!, target = String(row[fk])
          if (row[fk] == null) continue
          if (relation.type === 'Customer') {
            const alias = aliases.get(target) ?? (await tx.customer.findFirst({ where: { id: target, organizationId: node.organizationId } }))?.id
            if (!alias) throw new AppError('Customer reference missing', 409, 'REPLICA_REFERENCE_MISSING')
            row[fk] = alias
          } else if ((replicaEntities as readonly string[]).includes(relation.type)) {
            if (deletedIds.get(relation.type)?.has(target)) throw new AppError('Replica reference points at a deleted row', 409, 'REPLICA_REFERENCE_MISSING')
            if (rowIds.get(relation.type)?.has(target)) {
              if (!present.has(relation.type) && !field.isRequired) { patch[fk] = row[fk]; row[fk] = null }
            } else {
              const parent = await api(tx, relation.type).findUnique({ where: { id: target } })
              if (!parent || !await owned(relation.type, parent)) throw new AppError('Replica reference missing', 409, 'REPLICA_REFERENCE_MISSING')
            }
          } else {
            const parent = await api(tx, relation.type).findUnique({ where: { id: target } })
            if (!parent || parent.organizationId && parent.organizationId !== node.organizationId || parent.branchId && parent.branchId !== node.branchId) throw new AppError('Central master reference missing or foreign', 409, 'REPLICA_REFERENCE_MISSING')
          }
        }
        for (const field of model.fields) if (field.type === 'Json' && row[field.name] === null) row[field.name] = Prisma.DbNull
        await api(tx, name).upsert({ where: { id }, create: row, update: row })
        if (Object.keys(patch).length) patches.push({ name, id, data: patch })
      }
      pending.delete(name); present.add(name); progressed = true
    }
    if (!progressed) throw new AppError('ERP replica dependency cycle', 409, 'REPLICA_INVALID')
  }
  for (const patch of patches) await api(tx, patch.name).update({ where: { id: patch.id }, data: patch.data })
  for (const [name, id] of retry) if (!await remove(name, id)) throw new AppError('A deleted row is still referenced in the central ERP', 409, 'REPLICA_CONFLICT')
  return { rows: count, deleted: deleted.length }
}
