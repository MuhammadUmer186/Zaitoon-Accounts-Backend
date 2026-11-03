import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { AppError } from '../middleware/error'
import { assertBranchAccess } from '../utils/branchScope'
import { Request } from 'express'
import { createHash } from 'crypto'
import { getUserPermissions } from '../utils/permissions'
import { assertTransferPublicKey, wrapForPc } from '../utils/fiscalTransfer'
import { unseal } from './zatca/crypto'
import { prepareMedia } from './branchMedia'
import { ensureBranchMenu } from './branchMenu'

const shared = new Set(['Organization', 'Role', 'Permission', 'RolePermission', 'Account', 'BankAccount', 'TaxRate', 'AccountingMapping', 'AccountingPeriod', 'ExpenseCategory', 'Supplier', 'ItemCategory', 'Item', 'MenuCategory', 'MenuShift', 'Dish', 'ModifierGroup', 'KitchenStation', 'VoidReason', 'FreeDishItem'])
// Synchronization machinery for routing, leases and receipts. These rows describe
// the cloud/PC relationship itself and never enter a branch seed or an import.
// Keep in step with the exclusions in 20261026-branch-ownership.sql.
export const branchControlPlaneModels = new Set(['NetworkKitchenPrinter', 'KitchenPrintJob', 'BranchRuntime', 'BranchOutbox', 'BranchSyncNode', 'BranchSyncEvent', 'BranchSyncProjection', 'BranchReplicaSession', 'BranchReplicaPart', 'BranchRemoteCommand', 'BranchChangeLog', 'BranchWalletReservation', 'BranchWalletReceipt', 'BranchStockTransfer', 'BranchTransferReceipt'])
export const branchExcludedModels = new Set([...branchControlPlaneModels, 'AuthAttemptBucket', 'RefreshToken', 'FreeDishRateLimit', 'FreeDishQr', 'FreeDishSubmission', 'Notification', 'AuditLog', 'CommerceSettings', 'PaymentIntent', 'PaymentEvent', 'CheckoutDevice', 'GiftCard', 'GiftCardTransaction', 'LoyaltyTransaction', 'HouseAccountTransaction', 'PosApproval', 'PosOfflineDevice', 'OfflineOrderSync'])
const excluded = branchExcludedModels
// Fiscal devices move to a PC only with a transfer key (see below), never via configuration.
const fiscalModels = new Set(['ZatcaDevice', 'ZatcaDocument'])
const models = Prisma.dmmf.datamodel.models
const delegate = (name: string) => name[0].toLowerCase() + name.slice(1)
export const branchConfigurationModels = new Set([...shared, 'Branch', 'BranchMenuItem', 'User', 'UserRole', 'UserBranchAccess', 'DishIngredient', 'DishShift', 'DishSize', 'ModifierOption', 'DishModifierGroup', 'ComboGroup', 'ComboOption'])
export const branchSchemaFingerprint = createHash('sha256').update(JSON.stringify(models.map(m => [m.name, m.fields.filter(f => f.kind !== 'object').map(f => [f.name, f.type, f.isRequired])]))).digest('hex')

// Bootstrap is deliberately distinct from ongoing synchronization. No plaintext passwords,
// fiscal keys or provider secrets are copied through the old bulk sync API.
// User password hashes are necessary for existing staff to sign in locally;
// this package is restricted to organization administrators and must never log.
export async function exportBranch(req: Request, branchId: string, includeHr = false, configurationOnly = false, options: { fiscalTransferKey?: string } = {}) {
  if (options.fiscalTransferKey) assertTransferPublicKey(options.fiscalTransferKey)
  await assertBranchAccess(req, branchId)
  if (includeHr) {
    const access = await getUserPermissions(prisma, req.user.id)
    if (!access.permissions.has('can_view_hr') || !access.permissions.has('can_view_payroll')) throw new AppError('HR and payroll permissions are required to provision confidential HR data', 403, 'FORBIDDEN')
  }
  const organizationId = req.user.organizationId
  const branch = await prisma.branch.findFirst({ where: { id: branchId, organizationId, isActive: true } })
  if (!branch) throw new AppError('Active branch not found', 404, 'NOT_FOUND')
  await ensureBranchMenu(prisma, organizationId, branchId)
  return prisma.$transaction(async tx => {
    const tables: Record<string, Record<string, unknown>[]> = {}
    const selected = new Map<string, Set<string>>()
    let total = 0
    async function read(name: string, where: Record<string, unknown>) {
      const api = (tx as unknown as Record<string, { findMany: (args: unknown) => Promise<Record<string, unknown>[]> }>)[delegate(name)]
      const rows = await api.findMany({ where, take: 50001 })
      if (rows.length > 50000 || (total += rows.length) > 250000) throw new AppError('Branch package is too large for online provisioning; use a reviewed migration.', 413, 'PACKAGE_TOO_LARGE')
      tables[name] = rows
      selected.set(name, new Set(rows.map(r => String(r.id ?? r.organizationId))))
    }
    for (const model of models) {
      const columns = new Map(model.fields.map(f => [f.name, f]))
      if (configurationOnly && !branchConfigurationModels.has(model.name)) continue
      if (excluded.has(model.name) || fiscalModels.has(model.name) || (!includeHr && model.name.startsWith('Hr'))) continue
      if (model.name === 'Organization') await read(model.name, { id: organizationId })
      else if (model.name === 'Branch') await read(model.name, { id: branchId, organizationId })
      else if (model.name === 'User') await read(model.name, { organizationId, OR: [{ id: req.user.id }, { branchAccess: { some: { branchId, organizationId } } }] })
      else if (model.name === 'Customer') continue // Selected below from this branch's actual references.
      else if (model.name === 'HrSettings') await read(model.name, { organizationId })
      else if (model.name === 'HrRecord') await read(model.name, { organizationId, branchId, OR: [{ employeeId: null }, { employeeId: { in: [...(selected.get('HrEmployee') ?? [])] } }] })
      else if (columns.has('organizationId') && columns.has('branchId')) {
        await read(model.name, { organizationId, ...(columns.get('branchId')!.isRequired ? { branchId } : { OR: [{ branchId }, { branchId: null }] }) })
      } else if (shared.has(model.name) && (columns.has('organizationId') || model.name === 'Permission')) await read(model.name, model.name === 'Permission' ? {} : { organizationId })
    }
    const customers = [...new Set(Object.values(tables).flatMap(rows => rows.flatMap(r => r.customerId ? [String(r.customerId)] : [])))]
    if (!configurationOnly) await read('Customer', { organizationId, id: { in: customers } })
    // Child tables must match every already scoped parent, preventing a shared
    // catalog parent from accidentally pulling another branch's order children.
    for (let round = 0; round < models.length; round++) {
      let progress = false
      for (const model of models) {
        if (configurationOnly && !branchConfigurationModels.has(model.name)) continue
        if (tables[model.name] || excluded.has(model.name) || fiscalModels.has(model.name) || (!includeHr && model.name.startsWith('Hr')) || model.name.startsWith('Branch')) continue
        if (model.fields.some(f => f.name === 'organizationId')) continue
        const parents = model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length)
        if (!parents.length || parents.some(f => !selected.has(f.type))) continue
        const clauses = parents.map(f => {
          const fk = f.relationFromFields![0]
          const ids = [...selected.get(f.type)!]
          return model.fields.find(c => c.name === fk)!.isRequired ? { [fk]: { in: ids } } : { OR: [{ [fk]: null }, { [fk]: { in: ids } }] }
        })
        await read(model.name, { AND: clauses }); progress = true
      }
      if (!progress) break
    }
    // ZATCA devices registered in the cloud move to the PC with their invoice
    // counter and hash chain, so the chain continues unbroken. Enrollment has
    // already fenced the cloud, so no further cloud invoice can be signed.
    // Secrets are re-encrypted for this PC's one-time transfer key only.
    const fiscalDevices: { id: string; privateKey: string; complianceSecret: string | null; productionSecret: string }[] = []
    if (options.fiscalTransferKey && !configurationOnly) {
      const key = options.fiscalTransferKey
      const devices = (await tx.zatcaDevice.findMany({ where: { organizationId, branchId, status: 'active' } })).filter(d => d.privateKeySealed && d.productionSecretSealed && d.productionToken)
      for (const d of devices) fiscalDevices.push({ id: d.id, privateKey: wrapForPc(unseal(d.privateKeySealed!), key), complianceSecret: d.complianceSecretSealed ? wrapForPc(unseal(d.complianceSecretSealed), key) : null, productionSecret: wrapForPc(unseal(d.productionSecretSealed!), key) })
      tables.ZatcaDevice = devices.map(d => ({ ...d, privateKeySealed: null, complianceSecretSealed: null, productionSecretSealed: null })) as unknown as Record<string, unknown>[]
      selected.set('ZatcaDevice', new Set(devices.map(d => d.id)))
      // Historical invoices let the PC issue credit notes for earlier sales. Their
      // XML stays in the cloud; a credit note needs only what was billed.
      tables.ZatcaDocument = (await tx.zatcaDocument.findMany({ where: { organizationId, branchId, deviceId: { in: devices.map(d => d.id) } }, take: 50001 })).map(d => ({ ...d, xml: '' })) as unknown as Record<string, unknown>[]
      if (tables.ZatcaDocument.length > 50000 || (total += tables.ZatcaDocument.length + devices.length) > 250000) throw new AppError('Branch package is too large for online provisioning; use a reviewed migration.', 413, 'PACKAGE_TOO_LARGE')
    }
    // Remove foreign references to omitted branch-specific data; required ones
    // are checked by the installer before the transaction is committed.
    for (const model of models) for (const row of tables[model.name] ?? []) {
      for (const relation of model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length === 1)) {
        const fk = relation.relationFromFields![0], field = model.fields.find(f => f.name === fk)!
        if (row[fk] != null && !selected.get(relation.type)?.has(String(row[fk])) && !field.isRequired) row[fk] = null
      }
      // A PC signs invoices only with devices it received; configuration keeps the cloud setting.
      if (model.name === 'Organization') { row.logoUrl = null; if (!configurationOnly && !fiscalDevices.length) row.zatcaEnabled = false }
      if (model.name === 'User') {
        if (configurationOnly) { delete row.posPin; delete row.posPinLookup }
        else { row.posPin = null; row.posPinLookup = null }
      }
      if (model.name === 'UserBranchAccess') row.branchId = branchId
    }
    await prepareMedia(tables, { organizationId, branchId, syncHr: includeHr })
    return { version: 1, schema: branchSchemaFingerprint, organizationId, branchId, generatedAt: new Date().toISOString(), includesHr: includeHr, tables, ...(fiscalDevices.length && { fiscalDevices }),
      limitations: ['Payment-provider credentials, device sessions and shared-value wallets require separate provisioning.'] }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120000 })
}
