import { Prisma, PrismaClient } from '@prisma/client'
import { branchExcludedModels, branchSchemaFingerprint } from './branchProvisioning'
import { AppError } from '../middleware/error'
import { hydrateMedia } from './branchMedia'

export async function importBranch(db: PrismaClient, input: unknown) {
  const source = input as { version?: number; schema?: string; organizationId?: string; branchId?: string; includesHr?: boolean; tables?: Record<string, Record<string, unknown>[]> }
  if (source?.version !== 1 || source.schema !== branchSchemaFingerprint || !source.organizationId || !source.branchId || !source.tables || typeof source.tables !== 'object' || Array.isArray(source.tables)) throw new AppError('Branch package and application schema do not match', 400, 'INVALID_BRANCH_PACKAGE')
  const models = Prisma.dmmf.datamodel.models
  const byName = new Map(models.map(m => [m.name, m]))
  const tables = structuredClone(source.tables)
  if (Object.values(tables).some(rows => !Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw new AppError('Invalid branch package rows', 400, 'INVALID_BRANCH_PACKAGE')
  const ids = new Map(Object.entries(tables).map(([name, rows]) => [name, new Set(rows.map(r => String(r.id ?? r.organizationId)))]))
  let count = 0
  for (const [name, rows] of Object.entries(tables)) {
    const model = byName.get(name)
    if (!model || branchExcludedModels.has(name) || (name.startsWith('Hr') && source.includesHr !== true) || !Array.isArray(rows)) throw new AppError('Unsupported branch package table', 400, 'INVALID_BRANCH_PACKAGE')
    if ((count += rows.length) > 250000) throw new AppError('Branch package too large', 413, 'PACKAGE_TOO_LARGE')
    for (const row of rows) {
      if (row.organizationId && row.organizationId !== source.organizationId) throw new AppError('Foreign organization in package', 400, 'INVALID_BRANCH_PACKAGE')
      if (row.branchId && row.branchId !== source.branchId) throw new AppError('Foreign branch in package', 400, 'INVALID_BRANCH_PACKAGE')
      if (name === 'Branch' && row.id !== source.branchId || name === 'Organization' && row.id !== source.organizationId) throw new AppError('Package identity mismatch', 400, 'INVALID_BRANCH_PACKAGE')
      for (const key of Object.keys(row)) if (!model.fields.some(f => f.name === key && f.kind !== 'object')) throw new AppError('Unexpected package field', 400, 'INVALID_BRANCH_PACKAGE')
      for (const relation of model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length)) {
        if (relation.relationFromFields!.length !== 1) throw new AppError('Unsupported composite relation', 400, 'INVALID_BRANCH_PACKAGE')
        const fk = relation.relationFromFields![0]
        if (row[fk] != null && !ids.get(relation.type)?.has(String(row[fk]))) throw new AppError('Branch package has an unresolved relation', 400, 'INVALID_BRANCH_PACKAGE')
      }
    }
  }
  if (tables.Organization?.length !== 1 || tables.Branch?.length !== 1) throw new AppError('Exactly one organization and branch required', 400, 'INVALID_BRANCH_PACKAGE')
  await hydrateMedia(tables, { organizationId: source.organizationId, branchId: source.branchId, syncHr: source.includesHr === true })
  return db.$transaction(async tx => {
    // Concurrent installers cannot both pass the empty-database check.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(720164001)`
    if (await tx.organization.count() || await tx.user.count()) throw new AppError('Local database already contains data; import refused', 409, 'LOCAL_DATABASE_NOT_EMPTY')
    const pending = new Set(Object.keys(tables)), inserted = new Set<string>()
    const patches: { model: string; where: Record<string, unknown>; data: Record<string, unknown> }[] = []
    const api = (name: string) => (tx as unknown as Record<string, { createMany: (args: unknown) => Promise<unknown>; update: (args: unknown) => Promise<unknown> }>)[name[0].toLowerCase() + name.slice(1)]
    while (pending.size) {
      let progress = false
      for (const name of [...pending]) {
        const model = byName.get(name)!
        const relations = model.fields.filter(f => f.kind === 'object' && f.relationFromFields?.length)
        const requiredParents = relations.filter(r => r.relationFromFields!.some(k => model.fields.find(f => f.name === k)!.isRequired))
        if (requiredParents.some(r => !inserted.has(r.type) && (tables[name]?.length ?? 0) > 0)) continue
        const rows = tables[name].map(original => {
          const row = { ...original }, patch: Record<string, unknown> = {}
          for (const relation of relations) for (const fk of relation.relationFromFields!) {
            if (row[fk] != null && !inserted.has(relation.type) && !model.fields.find(f => f.name === fk)!.isRequired) { patch[fk] = row[fk]; row[fk] = null }
          }
          for (const field of model.fields) if (field.type === 'Json' && row[field.name] === null) row[field.name] = Prisma.DbNull
          if (Object.keys(patch).length) {
            const pk = model.fields.find(f => f.isId)
            if (!pk) throw new AppError('Cannot resolve package reference', 400, 'INVALID_BRANCH_PACKAGE')
            patches.push({ model: name, where: { [pk.name]: original[pk.name] }, data: patch })
          }
          return row
        })
        for (let i = 0; i < rows.length; i += 200) await api(name).createMany({ data: rows.slice(i, i + 200) })
        inserted.add(name); pending.delete(name); progress = true
      }
      if (!progress) throw new AppError('Branch package has circular required dependencies', 400, 'INVALID_BRANCH_PACKAGE')
    }
    for (const patch of patches) await api(patch.model).update({ where: patch.where, data: patch.data })
    return { organizationId: source.organizationId, branchId: source.branchId, rows: count }
  }, { timeout: 180000 })
}
