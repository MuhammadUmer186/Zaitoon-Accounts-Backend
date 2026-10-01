import { Request } from 'express'
import { prisma } from '../config'
import { AppError } from '../middleware/error'

// Who sees which branches:
//  - super_admin / owner / admin: every branch, always.
//  - a store keeper: only the branch(es) ticked under Branch Access — even
//    none, which shows nothing rather than everything.
//  - anyone else: the branches ticked under Branch Access; a user with no
//    branch access rows at all keeps org-wide visibility (so older accounts
//    that were never given branch rows aren't locked out).
// Roles are matched by name OR display name, normalised, so a role created
// by hand as "Store Keeper" behaves the same as the seeded store_keeper.
export const BRANCH_SCOPED_ROLES = ['store_keeper']
const UNSCOPED_ROLES = ['super_admin', 'owner', 'admin']

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
const UNSCOPED_KEYS = new Set([...UNSCOPED_ROLES.map(normalise), 'superadministrator', 'administrator'])
const STORE_KEEPER_KEYS = new Set([...BRANCH_SCOPED_ROLES.map(normalise), 'storekeeper', 'storemanager'])

export const isStoreKeeperRole = (r: { name: string; displayName?: string | null }) =>
  STORE_KEEPER_KEYS.has(normalise(r.name)) || (!!r.displayName && STORE_KEEPER_KEYS.has(normalise(r.displayName)))
const isUnscopedRole = (r: { name: string; displayName?: string | null }) =>
  UNSCOPED_KEYS.has(normalise(r.name)) || (!!r.displayName && UNSCOPED_KEYS.has(normalise(r.displayName)))

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
  const [userRoles, access] = await Promise.all([
    prisma.userRole.findMany({ where: { userId }, include: { role: { select: { name: true, displayName: true } } } }),
    prisma.userBranchAccess.findMany({ where: { userId, organizationId }, select: { branchId: true } }),
  ])
  const roles = userRoles.map((r) => r.role)
  if (roles.some(isUnscopedRole)) return { restricted: false, branchIds: [] }
  const branchIds = access.map((a) => a.branchId)
  if (roles.some(isStoreKeeperRole)) return { restricted: true, branchIds }
  if (branchIds.length === 0) return { restricted: false, branchIds: [] }
  return { restricted: true, branchIds }
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
