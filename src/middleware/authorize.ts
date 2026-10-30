import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config'
import { getUserPermissions } from '../utils/permissions'
import { AppError } from './error'

// Server-side permission enforcement. Every module router gates reads with
// requireModule (the same module access the sidebar uses to show a page) and
// each write/approve/void action with requirePermission.
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

export function requireAnyPermission(...permissionKeys: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { permissions } = await getUserPermissions(prisma, req.user.id)
      if (!permissionKeys.some((k) => permissions.has(k))) {
        res.status(403).json({ message: `Missing required permission: ${permissionKeys.join(' or ')}`, code: 'FORBIDDEN' })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// Access to any of the given modules — for reads that more than one page
// uses (e.g. Cash Closing reads the day's sales totals).
export function requireModule(...modules: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { moduleAccess } = await getUserPermissions(prisma, req.user.id)
      if (!modules.some((m) => moduleAccess.has(m))) {
        res.status(403).json({ message: 'You do not have access to this module', code: 'FORBIDDEN' })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// Separation of duties: whoever prepared a document cannot approve it, unless
// they are the Super Admin / Owner (a one-person restaurant still has to be
// able to close its own day).
export async function assertNotOwnSubmission(req: Request, createdBy: string | null | undefined, what: string) {
  if (!createdBy || createdBy !== req.user.id) return
  const { roles } = await getUserPermissions(prisma, req.user.id)
  if (roles.some((r) => r === 'super_admin' || r === 'owner')) return
  throw new AppError(`You prepared this ${what} — another user has to approve it`, 403, 'SELF_APPROVAL')
}
