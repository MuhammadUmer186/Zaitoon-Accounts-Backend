import { createHash } from 'crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { branchConfigurationModels, branchSchemaFingerprint } from './branchProvisioning'
import { AppError } from '../middleware/error'
import { hydrateMedia } from './branchMedia'
import { publish } from '../utils/liveEvents'

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export async function applyBranchConfiguration(db: PrismaClient, input: unknown) {
  const packageData = input as { kind?: string; schema?: string; nodeId?: string; organizationId?: string; branchId?: string; tables?: Record<string, Record<string, unknown>[]> }
  if (packageData?.kind !== 'branch-configuration' || packageData.schema !== branchSchemaFingerprint || !packageData.tables || typeof packageData.tables !== 'object' || Array.isArray(packageData.tables)) throw new AppError('Unsupported branch configuration', 409, 'CONFIGURATION_INVALID')
  const models = new Map(Prisma.dmmf.datamodel.models.map(m => [m.name, m]))
  const tables = structuredClone(packageData.tables)
  let total = 0
  for (const [name, rows] of Object.entries(tables)) {
    if (!branchConfigurationModels.has(name) || !Array.isArray(rows) || (total += rows.length) > 250000) throw new AppError('Invalid configuration table', 400, 'CONFIGURATION_INVALID')
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.organizationId && row.organizationId !== packageData.organizationId || row.branchId && row.branchId !== packageData.branchId) throw new AppError('Configuration identity mismatch', 403, 'BRANCH_FORBIDDEN')
      for (const field of Object.keys(row)) if (!models.get(name)!.fields.some(f => f.name === field && f.kind !== 'object')) throw new AppError('Unexpected configuration field', 400, 'CONFIGURATION_INVALID')
    }
  }
  if (tables.Organization?.length !== 1 || tables.Organization[0].id !== packageData.organizationId || tables.Branch?.length !== 1 || tables.Branch[0].id !== packageData.branchId || !tables.User?.length || !tables.Role || !tables.Permission || !tables.UserRole || !tables.RolePermission || !tables.UserBranchAccess) throw new AppError('Incomplete branch configuration', 400, 'CONFIGURATION_INVALID')
  if (!tables.BranchMenuItem || tables.Branch[0].menuInitialized !== true) throw new AppError('Branch menu configuration is incomplete', 400, 'CONFIGURATION_INVALID')
  const ids = new Map(Object.entries(tables).map(([name, rows]) => [name, new Set(rows.map(r => String(r.id ?? r.organizationId)))]))
  for (const [name, rows] of Object.entries(tables)) for (const row of rows) {
    for (const relation of models.get(name)!.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length)) {
      if (relation.relationFromFields!.length !== 1) throw new AppError('Unsupported relation', 409, 'CONFIGURATION_INVALID')
      const fk = relation.relationFromFields![0]
      if (row[fk] != null && !ids.get(relation.type)?.has(String(row[fk]))) throw new AppError('Unresolved configuration reference', 409, 'CONFIGURATION_INVALID')
    }
  }
  await hydrateMedia(tables, { organizationId: packageData.organizationId!, branchId: packageData.branchId! })
  const digest = createHash('sha256').update(canonical(tables)).digest('hex')
  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(720164002)`
    const runtime = await tx.branchRuntime.findUnique({ where: { id: 'local' } })
    if (!runtime || runtime.nodeId !== packageData.nodeId || runtime.organizationId !== packageData.organizationId || runtime.branchId !== packageData.branchId) throw new AppError('Configuration belongs to another PC', 403, 'BRANCH_FORBIDDEN')
    if (runtime.configurationHash === digest) {
      await tx.branchRuntime.update({ where: { id: 'local' }, data: { configurationSyncedAt: new Date() } })
      return { changed: false }
    }
    const userIds = [...ids.get('User')!]
    const currentUsers = await tx.user.findMany({ where: { organizationId: runtime.organizationId }, select: { id: true, passwordHash: true, isActive: true } })
    const newUsers = new Map(tables.User.map(row => [String(row.id), row]))
    const revokeUserIds = currentUsers.filter(user => {
      const next = newUsers.get(user.id)
      return !next || next.isActive === false || user.passwordHash !== next.passwordHash
    }).map(user => user.id)
    // Atomic replacement revokes missing grants. Existing financial records are
    // never deleted when catalog entries or staff disappear from the cloud.
    await tx.userRole.deleteMany({ where: { user: { organizationId: runtime.organizationId } } })
    await tx.userBranchAccess.deleteMany({ where: { organizationId: runtime.organizationId } })
    await tx.rolePermission.deleteMany({ where: { role: { organizationId: runtime.organizationId } } })
    // Catalog children are authoritative sets. Upsert alone would retain
    // deleted ingredients/options and silently consume the wrong stock.
    await tx.comboOption.deleteMany({ where: { group: { dish: { organizationId: runtime.organizationId } } } })
    await tx.comboGroup.deleteMany({ where: { dish: { organizationId: runtime.organizationId } } })
    await tx.dishModifierGroup.deleteMany({ where: { dish: { organizationId: runtime.organizationId } } })
    await tx.modifierOption.deleteMany({ where: { group: { organizationId: runtime.organizationId } } })
    await tx.dishSize.deleteMany({ where: { dish: { organizationId: runtime.organizationId } } })
    await tx.dishIngredient.deleteMany({ where: { dish: { organizationId: runtime.organizationId } } })
    await tx.dishShift.deleteMany({ where: { dish: { organizationId: runtime.organizationId } } })
    await tx.branchMenuItem.deleteMany({ where: { organizationId: runtime.organizationId, branchId: runtime.branchId } })
    await tx.user.updateMany({ where: { organizationId: runtime.organizationId, id: { notIn: userIds } }, data: { isActive: false } })
    await tx.account.updateMany({ where: { organizationId: runtime.organizationId, id: { notIn: [...(ids.get('Account') ?? [])] } }, data: { status: 'ARCHIVED' } })
    const present = new Set<string>(), pending = new Set(Object.keys(tables))
    const patches: { name: string; where: Record<string, unknown>; data: Record<string, unknown> }[] = []
    const api = (name: string) => (tx as unknown as Record<string, { upsert: (args: unknown) => Promise<unknown>; update: (args: unknown) => Promise<unknown>; updateMany: (args: unknown) => Promise<unknown> }>)[name[0].toLowerCase() + name.slice(1)]
    while (pending.size) {
      let progressed = false
      for (const name of [...pending]) {
        const model = models.get(name)!, relations = model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length)
        const required = relations.filter(r => r.relationFromFields!.some(k => model.fields.find(f => f.name === k)!.isRequired))
        if (tables[name].length && required.some(r => !present.has(r.type))) continue
        const primary = model.fields.find(f => f.isId)
        for (const source of tables[name]) {
          const data = { ...source }
          const where = primary ? { [primary.name]: source[primary.name] } : { [model.primaryKey?.name || model.primaryKey!.fields.join('_')]: Object.fromEntries(model.primaryKey!.fields.map(key => [key, source[key]])) }
          const patch: Record<string, unknown> = {}
          for (const relation of relations) for (const fk of relation.relationFromFields!) {
            if (data[fk] != null && !present.has(relation.type) && !model.fields.find(f => f.name === fk)!.isRequired) { patch[fk] = data[fk]; data[fk] = null }
          }
          // A central password update must not erase a separately enrolled local PIN.
          if (name === 'User') { delete data.posPin; delete data.posPinLookup }
          for (const field of model.fields) if (field.type === 'Json' && data[field.name] === null) data[field.name] = Prisma.DbNull
          await api(name).upsert({ where, create: data, update: data })
          if (Object.keys(patch).length) patches.push({ name, where, data: patch })
        }
        if (model.fields.some(f => f.name === 'isActive') && name !== 'User' && name !== 'Branch' && name !== 'Organization' && model.fields.some(f => f.name === 'organizationId')) {
          await api(name).updateMany({ where: { organizationId: runtime.organizationId, id: { notIn: [...ids.get(name)!] } }, data: { isActive: false } })
        }
        present.add(name); pending.delete(name); progressed = true
      }
      if (!progressed) throw new AppError('Configuration dependency cycle', 409, 'CONFIGURATION_INVALID')
    }
    for (const patch of patches) await api(patch.name).update({ where: patch.where, data: patch.data })
    // Accounts/roles absent from the package stay as historical references,
    // with no live user grants to any missing role.
    if (revokeUserIds.length) await tx.refreshToken.deleteMany({ where: { userId: { in: revokeUserIds } } })
    await tx.branchRuntime.update({ where: { id: 'local' }, data: { configurationHash: digest, configurationSyncedAt: new Date() } })
    return { changed: true }
  }, { timeout: 120000 })
  if (result.changed) {
    publish({ topic: 'menu', action: 'cloud_configuration_updated', organizationId: packageData.organizationId!, branchId: packageData.branchId! })
    publish({ topic: 'settings', action: 'cloud_configuration_updated', organizationId: packageData.organizationId!, branchId: packageData.branchId! })
  }
  return result
}
