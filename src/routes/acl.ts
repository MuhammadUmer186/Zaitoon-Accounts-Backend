import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

const roleSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
})

const permissionsSchema = z.object({
  permissionIds: z.array(z.string()),
})

// GET /acl/roles
router.get('/roles', async (req: Request, res: Response) => {
  const roles = await prisma.role.findMany({
    where: { organizationId: req.user.organizationId },
    include: {
      permissions: { include: { permission: true } },
      _count: { select: { userRoles: true } },
    },
    orderBy: { name: 'asc' },
  })
  res.json({ data: roles })
})

// POST /acl/roles
router.post('/roles', async (req: Request, res: Response) => {
  const body = roleSchema.parse(req.body)
  const role = await prisma.role.create({
    data: { ...body, organizationId: req.user.organizationId },
  })
  res.status(201).json(role)
})

// GET /acl/roles/:id
router.get('/roles/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const role = await prisma.role.findFirst({
    where: { id, organizationId: req.user.organizationId },
    include: { permissions: { include: { permission: true } } },
  })
  if (!role) throw new AppError('Role not found', 404, 'NOT_FOUND')
  res.json(role)
})

// PUT /acl/roles/:id
router.put('/roles/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const body = roleSchema.partial().parse(req.body)

  const role = await prisma.role.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!role) throw new AppError('Role not found', 404, 'NOT_FOUND')
  if (role.isSystemRole) throw new AppError('Cannot modify system roles', 403, 'FORBIDDEN')

  const updated = await prisma.role.update({
    where: { id },
    data: body,
    include: { permissions: { include: { permission: true } } },
  })
  res.json(updated)
})

// DELETE /acl/roles/:id
router.delete('/roles/:id', async (req: Request, res: Response) => {
  const id = req.params['id'] as string

  const role = await prisma.role.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!role) throw new AppError('Role not found', 404, 'NOT_FOUND')
  if (role.isSystemRole) throw new AppError('Cannot delete system roles', 403, 'FORBIDDEN')

  await prisma.role.delete({ where: { id } })
  res.json({ message: 'Role deleted' })
})

// PUT /acl/roles/:id/permissions
router.put('/roles/:id/permissions', async (req: Request, res: Response) => {
  const id = req.params['id'] as string
  const { permissionIds } = permissionsSchema.parse(req.body)

  const role = await prisma.role.findFirst({
    where: { id, organizationId: req.user.organizationId },
  })
  if (!role) throw new AppError('Role not found', 404, 'NOT_FOUND')

  await prisma.rolePermission.deleteMany({ where: { roleId: id } })

  if (permissionIds.length > 0) {
    await prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId: id, permissionId })),
      skipDuplicates: true,
    })
  }

  const updated = await prisma.role.findUnique({
    where: { id },
    include: { permissions: { include: { permission: true } } },
  })
  res.json(updated)
})

// GET /acl/permissions
router.get('/permissions', async (_req: Request, res: Response) => {
  const permissions = await prisma.permission.findMany({
    orderBy: [{ module: 'asc' }, { key: 'asc' }],
  })

  const grouped: Record<string, typeof permissions> = {}
  for (const p of permissions) {
    if (!grouped[p.module]) grouped[p.module] = []
    grouped[p.module].push(p)
  }

  res.json({ data: permissions, grouped })
})

// GET /acl/users/:userId/roles
router.get('/users/:userId/roles', async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  const roleData: unknown[] = []
  for (const ur of userRoles) roleData.push(ur.role)
  res.json({ data: roleData })
})

// POST /acl/users/:userId/roles
router.post('/users/:userId/roles', async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string
  const { roleId } = req.body
  if (!roleId) throw new AppError('roleId is required', 400, 'VALIDATION_ERROR')

  const role = await prisma.role.findFirst({
    where: { id: roleId as string, organizationId: req.user.organizationId },
  })
  if (!role) throw new AppError('Role not found', 404, 'NOT_FOUND')

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId, roleId: roleId as string } },
    create: { userId, roleId: roleId as string },
    update: {},
  })

  res.json({ message: 'Role assigned' })
})

// DELETE /acl/users/:userId/roles/:roleId
router.delete('/users/:userId/roles/:roleId', async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string
  const roleId = req.params['roleId'] as string
  await prisma.userRole.deleteMany({ where: { userId, roleId } })
  res.json({ message: 'Role removed' })
})

// GET /acl/users/:userId/branches
router.get('/users/:userId/branches', async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string
  const access = await prisma.userBranchAccess.findMany({
    where: { userId, organizationId: req.user.organizationId },
    include: { branch: { select: { id: true, name: true, code: true } } },
  })
  res.json({ data: access })
})

// POST /acl/users/:userId/branches
router.post('/users/:userId/branches', async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string
  const { branchId, canView = true, canCreate = true, canApprove = false } = req.body
  if (!branchId) throw new AppError('branchId is required', 400, 'VALIDATION_ERROR')

  const branch = await prisma.branch.findFirst({
    where: { id: branchId as string, organizationId: req.user.organizationId },
  })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

  const access = await prisma.userBranchAccess.upsert({
    where: { userId_branchId: { userId, branchId: branchId as string } },
    create: {
      userId,
      branchId: branchId as string,
      organizationId: req.user.organizationId,
      canView,
      canCreate,
      canApprove,
    },
    update: { canView, canCreate, canApprove },
    include: { branch: { select: { id: true, name: true, code: true } } },
  })
  res.status(201).json(access)
})

// PUT /acl/users/:userId/branches/:accessId
router.put('/users/:userId/branches/:accessId', async (req: Request, res: Response) => {
  const accessId = req.params['accessId'] as string
  const { canView, canCreate, canApprove } = req.body

  const updated = await prisma.userBranchAccess.update({
    where: { id: accessId },
    data: {
      ...(canView !== undefined && { canView }),
      ...(canCreate !== undefined && { canCreate }),
      ...(canApprove !== undefined && { canApprove }),
    },
    include: { branch: { select: { id: true, name: true, code: true } } },
  })
  res.json(updated)
})

// DELETE /acl/users/:userId/branches/:accessId
router.delete('/users/:userId/branches/:accessId', async (req: Request, res: Response) => {
  const accessId = req.params['accessId'] as string
  await prisma.userBranchAccess.delete({ where: { id: accessId } })
  res.json({ message: 'Branch access removed' })
})

// GET /acl/users/:userId/matrix
router.get('/users/:userId/matrix', async (req: Request, res: Response) => {
  const userId = req.params['userId'] as string
  const orgId = req.user.organizationId

  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
    },
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

  if (roles.includes('super_admin') || roles.includes('admin')) {
    const allPerms = await prisma.permission.findMany()
    for (const p of allPerms) {
      permissions.add(p.key)
      moduleAccess.add(p.module)
    }
  }

  const branchAccess = await prisma.userBranchAccess.findMany({
    where: { userId, organizationId: orgId },
  })

  const branchIds: string[] = []
  for (const b of branchAccess) branchIds.push(b.branchId)

  res.json({
    permissions: Array.from(permissions),
    branchIds,
    roles,
    moduleAccess: Array.from(moduleAccess),
  })
})

export default router
