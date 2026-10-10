import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config'
import { getUserPermissions } from '../utils/permissions'

// Server-side permission enforcement. Every module route is gated with
// requirePermission / requireAnyPermission, so hiding a menu item in the
// frontend is never the only protection.
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

// Passes when the user holds at least one of the given permissions. Used for
// reads that several modules share (e.g. the supplier list is needed by
// Purchasing, Purchase Orders, Bills and Expenses).
export function requireAnyPermission(...permissionKeys: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { permissions } = await getUserPermissions(prisma, req.user.id)
      if (!permissionKeys.some((k) => permissions.has(k))) {
        res.status(403).json({ message: `Missing required permission: one of ${permissionKeys.join(', ')}`, code: 'FORBIDDEN' })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// Report exports (?format=pdf|excel|csv) additionally need can_export_reports.
export async function requireExportPermission(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.query.format) return next()
  return requirePermission('can_export_reports')(req, res, next)
}
