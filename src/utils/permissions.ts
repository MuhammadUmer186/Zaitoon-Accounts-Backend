import { PrismaClient } from '@prisma/client'

export interface UserPermissionSet {
  permissions: Set<string>
  roles: string[]
  moduleAccess: Set<string>
}

// Resolves everything a user can do from their assigned roles — used both to
// build the login/refresh permissionMatrix response (auth.ts) and to enforce
// permissions server-side (middleware/authorize.ts). super_admin/admin bypass
// individual permission checks and implicitly hold every permission.
export async function getUserPermissions(prisma: PrismaClient, userId: string): Promise<UserPermissionSet> {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })

  const permissions = new Set<string>()
  const roles: string[] = []
  const moduleAccess = new Set<string>()

  for (const ur of userRoles) {
    roles.push(ur.role.name)
    for (const rp of ur.role.permissions) {
      permissions.add(rp.permission.key)
      moduleAccess.add(rp.permission.module)
    }
  }

  if (roles.includes('super_admin') || roles.includes('admin') || roles.includes('owner')) {
    const allPermissions = await prisma.permission.findMany()
    for (const p of allPermissions) {
      permissions.add(p.key)
      moduleAccess.add(p.module)
    }
  }

  return { permissions, roles, moduleAccess }
}
