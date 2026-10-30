import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/error'

export async function assertCounter(tx: Prisma.TransactionClient, scope: { organizationId: string; branchId: string }, counterCode: string) {
  const where = { organizationId: scope.organizationId, branchId: scope.branchId }
  if (await tx.zatcaDevice.count({ where: { ...where, counterCode } })) return
  // Existing branches without EGS registration retain the default counter.
  if (counterCode === 'main' && !await tx.zatcaDevice.count({ where })) return
  throw new AppError('Choose a registered counter for this branch', 400, 'INVALID_COUNTER')
}
