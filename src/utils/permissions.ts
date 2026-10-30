import { PrismaClient, Prisma } from '@prisma/client'

export interface UserPermissionSet {
  permissions: Set<string>
  roles: string[]
  moduleAccess: Set<string>
}

// The Administrator ("admin") role holds every permission except the
// org-administration ones below — Users & Roles, Branches and Settings stay
// with Super Admin. Applied here at resolution time (not just via role
// grants) so an admin role row that still carries these grants from an older
// seed can't leak them.
export const ADMIN_EXCLUDED_PERMISSIONS = new Set([
  'can_manage_users',
  'can_manage_roles',
  'can_create_branch',
  'can_manage_settings',
])

const FULL_ACCESS_ROLES = ['super_admin', 'owner']

// Resolves everything a user can do from their assigned roles — used both to
// build the login/refresh permissionMatrix response (auth.ts) and to enforce
// permissions server-side (middleware/authorize.ts). super_admin/owner
// implicitly hold every permission; admin holds every permission except
// ADMIN_EXCLUDED_PERMISSIONS.
export async function getUserPermissions(prisma: PrismaClient | Prisma.TransactionClient, userId: string): Promise<UserPermissionSet> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true, isActive: true, organization: { select: { isActive: true } } } })
  if (!user?.isActive || !user.organization.isActive) return { permissions: new Set(), roles: [], moduleAccess: new Set() }
  const userRoles = await prisma.userRole.findMany({
    where: { userId, role: { organizationId: user.organizationId } },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })

  const permissions = new Set<string>()
  const roles: string[] = []
  const moduleAccess = new Set<string>()

  const grant = (key: string, module: string) => {
    permissions.add(key)
    moduleAccess.add(module)
  }

  for (const ur of userRoles) {
    roles.push(ur.role.name)
    for (const rp of ur.role.permissions) {
      if (ur.role.name === 'admin' && ADMIN_EXCLUDED_PERMISSIONS.has(rp.permission.key)) continue
      grant(rp.permission.key, rp.permission.module)
    }
  }

  const isFullAccess = roles.some((r) => FULL_ACCESS_ROLES.includes(r))
  if (isFullAccess || roles.includes('admin')) {
    const allPermissions = await prisma.permission.findMany()
    for (const p of allPermissions) {
      if (!isFullAccess && ADMIN_EXCLUDED_PERMISSIONS.has(p.key)) continue
      grant(p.key, p.module)
    }
  }

  // One Purchases & Expenses workspace; retain legacy permission keys so
  // existing roles work without a grant migration. Action permissions remain
  // separate for expense creation, purchases, approval and payment.
  if (moduleAccess.has('purchasing') || permissions.has('can_make_payment')) moduleAccess.add('expenses')

  return { permissions, roles, moduleAccess }
}
