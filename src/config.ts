import { Prisma, PrismaClient } from '@prisma/client'
import { reportReadScope } from './utils/reportReadScope'

const fields = new Map(Prisma.dmmf.datamodel.models.map(model => [model.name, new Set(model.fields.map(field => field.name))]))
const reads = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy'])
const basePrisma = new PrismaClient()
export const prisma = basePrisma.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
  const scope = reportReadScope.getStore()
  if (scope && reads.has(operation)) {
    const columns = fields.get(model)!
    const where: Record<string, unknown> = {}
    if (columns.has('organizationId')) where.organizationId = scope.organizationId
    if (model === 'Organization') where.id = scope.organizationId
    if (scope.branchIds) {
      const branch = { in: scope.branchIds }
      if (model === 'Branch') where.id = branch
      else if (columns.has('branchId')) {
        if (model === 'Account') where.OR = [{ branchId: null }, { branchId: branch }]
        else where.branchId = branch
      }
      // Child rows inherit the scope of their financial document.
      const parents: Record<string, string> = { JournalLine: 'journalEntry', BillItem: 'bill', DeliveryBreakdown: 'dailySale' }
      if (parents[model]) where[parents[model]] = { organizationId: scope.organizationId, branchId: branch }
    }
    const scopedArgs = args as { where?: Record<string, unknown> }
    const previous = scopedArgs.where?.AND
    scopedArgs.where = { ...scopedArgs.where, AND: [...(Array.isArray(previous) ? previous : previous ? [previous] : []), where] }
  }
  return query(args)
} } } }) as unknown as PrismaClient

export const config = {
  port: parseInt(process.env.PORT || '4000'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production-32chars',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-prod32',
  jwtExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  bcryptRounds: 10,
  apiPrefix: '/api/v1',
  syncSecret: process.env.SYNC_SECRET || '',
}
