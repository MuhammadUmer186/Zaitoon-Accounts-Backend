import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config'
import { getUserPermissions } from '../utils/permissions'

// Server-side permission enforcement — until now this codebase only gated
// actions in the frontend (usePermissions().hasPermission), so any
// authenticated user's token could call any endpoint regardless of role.
// This middleware is the first backend enforcement point; the Accounts
// module routes are gated with it. Not retrofitted onto pre-existing routes
// outside this module — that's a larger, separate effort.
export function requirePermission(permissionKey: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { permissions } = await getUserPermissions(prisma, req.user.id)
      if (!permissions.has(permissionKey)) {
        res.status(403).json({ message: `Missing required permission: ${permissionKey}`, code: 'FORBIDDEN' })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}
