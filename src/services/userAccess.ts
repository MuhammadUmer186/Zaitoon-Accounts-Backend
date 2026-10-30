import { Prisma } from '@prisma/client'
import { AppError } from '../middleware/error'
import { isStoreKeeperRole } from '../utils/branchScope'

export async function validateUserAccess(tx: Prisma.TransactionClient, organizationId: string, roleIds: string[], branchIds: string[]) {
  const roles = await tx.role.findMany({ where: { id: { in: [...new Set(roleIds)] }, organizationId }, select: { name: true, displayName: true } })
  const branches = await tx.branch.count({ where: { id: { in: [...new Set(branchIds)] }, organizationId } })
  if (roles.length !== new Set(roleIds).size || branches !== new Set(branchIds).size) throw new AppError('Select roles and branches belonging to this organization', 400, 'VALIDATION_ERROR')
  const scoped = roles.find(isStoreKeeperRole)
  if (scoped && new Set(branchIds).size !== 1) throw new AppError(`${scoped.displayName} must be assigned to exactly one branch`, 400, 'VALIDATION_ERROR')
}
