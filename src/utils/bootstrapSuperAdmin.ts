import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

// Env-driven Super Admin bootstrap/recovery, run on every server start.
//
//   SUPER_ADMIN_EMAIL            required to enable
//   SUPER_ADMIN_PASSWORD         required to enable (min 8 chars)
//   SUPER_ADMIN_FIRST_NAME       optional, default "Super"   (new user only)
//   SUPER_ADMIN_LAST_NAME        optional, default "Admin"   (new user only)
//   SUPER_ADMIN_RESET_PASSWORD   "true" → overwrite an existing user's
//                                password with SUPER_ADMIN_PASSWORD and sign
//                                out its sessions (forgot-password recovery)
//   SUPER_ADMIN_ORG_ID           optional; only needed when the database
//                                holds more than one organization
//
// Guarantees: the user exists, is active, holds the super_admin role and can
// access every branch. An existing user's password is left alone unless
// SUPER_ADMIN_RESET_PASSWORD=true, so a password changed in the app isn't
// silently reverted on the next restart. Never throws — a bootstrap problem
// is logged and the server still starts.
export async function bootstrapSuperAdmin(prisma: PrismaClient): Promise<void> {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim()
  const password = process.env.SUPER_ADMIN_PASSWORD
  if (!email && !password) return

  const log = (msg: string) => console.log(`[super-admin] ${msg}`)
  const warn = (msg: string) => console.warn(`[super-admin] ${msg}`)

  try {
    if (!email || !password) {
      warn('Both SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set — skipping')
      return
    }
    if (password.length < 8) {
      warn('SUPER_ADMIN_PASSWORD must be at least 8 characters — skipping')
      return
    }

    const organization = await resolveOrganization(prisma, process.env.SUPER_ADMIN_ORG_ID?.trim())
    if (!organization) return
    const organizationId = organization.id

    const role = await ensureSuperAdminRole(prisma, organizationId)
    const resetPassword = process.env.SUPER_ADMIN_RESET_PASSWORD?.trim().toLowerCase() === 'true'

    let user = await prisma.user.findFirst({
      where: { organizationId, email: { equals: email, mode: 'insensitive' } },
    })

    if (!user) {
      user = await prisma.user.create({
        data: {
          organizationId,
          email,
          firstName: process.env.SUPER_ADMIN_FIRST_NAME?.trim() || 'Super',
          lastName: process.env.SUPER_ADMIN_LAST_NAME?.trim() || 'Admin',
          passwordHash: await bcrypt.hash(password, 10),
          isActive: true,
        },
      })
      log(`Created Super Admin user ${email}`)
    } else {
      const data: Record<string, unknown> = {}
      if (!user.isActive) data.isActive = true
      if (resetPassword) data.passwordHash = await bcrypt.hash(password, 10)
      // SUPER_ADMIN_RESET_MFA=true clears two-factor (lost phone recovery)
      if (process.env.SUPER_ADMIN_RESET_MFA?.trim().toLowerCase() === 'true' && user.mfaEnabled) {
        Object.assign(data, { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null, mfaRecoveryCodes: [], mfaLastStep: null })
        log(`Two-factor reset for ${user.email} — set SUPER_ADMIN_RESET_MFA=false (or remove it) now`)
      }
      if (Object.keys(data).length > 0) {
        await prisma.user.update({ where: { id: user.id }, data })
      }
      if (resetPassword) {
        await prisma.refreshToken.deleteMany({ where: { userId: user.id } })
        log(`Password reset for ${user.email} from SUPER_ADMIN_PASSWORD — set SUPER_ADMIN_RESET_PASSWORD=false (or remove it) now`)
      }
      if (data.isActive) log(`Re-activated ${user.email}`)
    }

    const hadRole = await prisma.userRole.findUnique({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
    })
    if (!hadRole) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } })
      log(`Granted Super Admin role to ${user.email}`)
    }

    const branches = await prisma.branch.findMany({ where: { organizationId }, select: { id: true } })
    const existingAccess = await prisma.userBranchAccess.findMany({
      where: { userId: user.id },
      select: { branchId: true },
    })
    const hasAccess = new Set(existingAccess.map((a) => a.branchId))
    const missing = branches.filter((b) => !hasAccess.has(b.id))
    if (missing.length > 0) {
      await prisma.userBranchAccess.createMany({
        data: missing.map((b) => ({
          userId: user!.id,
          organizationId,
          branchId: b.id,
          canView: true,
          canCreate: true,
          canApprove: true,
        })),
        skipDuplicates: true,
      })
      log(`Gave ${user.email} access to ${missing.length} branch(es)`)
    }

    log(`Ready: ${user.email} is Super Admin`)
  } catch (err) {
    console.error('[super-admin] Bootstrap failed — server will start anyway:', err)
  }
}

async function resolveOrganization(prisma: PrismaClient, orgId?: string) {
  if (orgId) {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } })
    if (!org) console.warn(`[super-admin] SUPER_ADMIN_ORG_ID "${orgId}" not found — skipping`)
    return org
  }
  const orgs = await prisma.organization.findMany({ select: { id: true }, take: 2 })
  if (orgs.length === 0) {
    console.warn('[super-admin] No organization exists yet (run the seed first) — skipping')
    return null
  }
  if (orgs.length > 1) {
    console.warn('[super-admin] Several organizations exist — set SUPER_ADMIN_ORG_ID to choose one; skipping')
    return null
  }
  return orgs[0]
}

// Uses the org's existing super_admin role; creates it (holding every
// permission) if this database never had one.
async function ensureSuperAdminRole(prisma: PrismaClient, organizationId: string) {
  const existing = await prisma.role.findUnique({
    where: { organizationId_name: { organizationId, name: 'super_admin' } },
  })
  if (existing) return existing

  const permissions = await prisma.permission.findMany({ select: { id: true } })
  const role = await prisma.role.create({
    data: {
      organizationId,
      name: 'super_admin',
      displayName: 'Super Admin',
      description: 'Full system access',
      isSystemRole: true,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
  })
  console.log('[super-admin] Created missing super_admin role')
  return role
}
