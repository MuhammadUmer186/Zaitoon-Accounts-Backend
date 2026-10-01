import { Request } from 'express'
import { prisma } from '../config'
import { AppError } from '../middleware/error'

// Roles whose users only ever see the branch(es) assigned to them in
// UserBranchAccess. Everyone else keeps org-wide visibility (unchanged
// behaviour). A store keeper works in exactly one branch's store.
export const BRANCH_SCOPED_ROLES = ['store_keeper']
const UNSCOPED_ROLES = ['super_admin', 'owner', 'admin']

export interface BranchScope {
  restricted: boolean
  branchIds: string[] // only meaningful when restricted
}

const cache = new WeakMap<Request, Promise<BranchScope>>()

// Resolved once per request.
export function getBranchScope(req: Request): Promise<BranchScope> {
  let p = cache.get(req)
  if (!p) {
    p = resolveScope(req.user.id, req.user.organizationId)
    cache.set(req, p)
  }
  return p
}

export async function resolveScope(userId: string, organizationId: string): Promise<BranchScope> {
  const roles = (await prisma.userRole.findMany({ where: { userId }, include: { role: { select: { name: true } } } })).map((r) => r.role.name)
  const restricted = roles.some((r) => BRANCH_SCOPED_ROLES.includes(r)) && !roles.some((r) => UNSCOPED_ROLES.includes(r))
  if (!restricted) return { restricted: false, branchIds: [] }
  const access = await prisma.userBranchAccess.findMany({ where: { userId, organizationId }, select: { branchId: true } })
  return { restricted: true, branchIds: access.map((a) => a.branchId) }
}

// Throws 403 when a branch-scoped user touches another branch.
export async function assertBranchAccess(req: Request, branchId: string | null | undefined) {
  const scope = await getBranchScope(req)
  if (scope.restricted && (!branchId || !scope.branchIds.includes(branchId))) {
    throw new AppError('You can only access your own branch', 403, 'BRANCH_FORBIDDEN')
  }
}

// Prisma `branchId` filter for list endpoints: the requested branch (checked
// against the user's scope), or — for a scoped user who asked for none —
// their own branch(es). Returns undefined when no filter applies.
export async function branchFilter(req: Request, requested?: string): Promise<string | { in: string[] } | undefined> {
  const scope = await getBranchScope(req)
  if (!scope.restricted) return requested || undefined
  if (requested) {
    if (!scope.branchIds.includes(requested)) throw new AppError('You can only access your own branch', 403, 'BRANCH_FORBIDDEN')
    return requested
  }
  return { in: scope.branchIds }
}
