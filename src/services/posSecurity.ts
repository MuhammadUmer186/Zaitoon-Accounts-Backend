import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Prisma } from '@prisma/client'
import { Request } from 'express'
import { prisma, config } from '../config'
import { AppError } from '../middleware/error'
import { getUserPermissions } from '../utils/permissions'
import { resolveScope } from '../utils/branchScope'

export const ACTION_PERMISSIONS = { discount: 'can_apply_discount', void: 'can_void_items', refund: 'can_refund', drawer: 'can_open_drawer' } as const
export type PosAction = keyof typeof ACTION_PERMISSIONS
const approvalKey = () => `${config.jwtSecret}:pos-approval`
export const pinLookup = (orgId: string, pin: string) => crypto.createHmac('sha256', `${config.jwtSecret}:pos-pin`).update(`${orgId}:${pin}`).digest('hex')

export async function userForPin(organizationId: string, branchId: string, pin: string) {
  const u = await prisma.user.findFirst({ where: { organizationId, isActive: true, posPinLookup: pinLookup(organizationId, pin), organization: { isActive: true } } })
  // Compare a valid bcrypt hash even for unknown PINs to avoid account probing.
  const valid = await bcrypt.compare(pin, u?.posPin ?? '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy')
  if (!u || !valid) throw new AppError('Invalid PIN', 401, 'INVALID_PIN')
  const scope = await resolveScope(u.id, organizationId)
  if (scope.restricted && !scope.branchIds.includes(branchId)) throw new AppError('PIN user cannot access this branch', 403, 'BRANCH_FORBIDDEN')
  return u
}

export async function createApproval(req: Request, branchId: string, pin: string, action: PosAction, resourceId: string) {
  const u = await userForPin(req.user.organizationId, branchId, pin)
  if (!(await getUserPermissions(prisma, u.id)).permissions.has(ACTION_PERMISSIONS[action])) throw new AppError('This PIN cannot approve that action', 403, 'FORBIDDEN')
  const approval = await prisma.posApproval.create({ data: { organizationId: req.user.organizationId, branchId, cashierId: req.user.id, approvedBy: u.id, action, resourceId, expiresAt: new Date(Date.now() + 120000) } })
  return { approvalToken: jwt.sign({ id: approval.id, purpose: 'pos-approval' }, approvalKey(), { expiresIn: 120, audience: 'pos-approval' }), approvedBy: u.id, expiresAt: approval.expiresAt }
}

export async function authorizePos(tx: Prisma.TransactionClient, req: Request, action: PosAction, branchId: string, resourceId: string, token?: string) {
  if (!token) {
    if ((await getUserPermissions(tx, req.user.id)).permissions.has(ACTION_PERMISSIONS[action])) return req.user.id
    throw new AppError('Manager authorization is required', 403, 'APPROVAL_REQUIRED')
  }
  let payload: { id: string }
  try { payload = jwt.verify(token, approvalKey(), { audience: 'pos-approval' }) as { id: string } } catch { throw new AppError('Manager approval expired or invalid', 403, 'INVALID_APPROVAL') }
  const a = await tx.posApproval.findFirst({ where: { id: payload.id, organizationId: req.user.organizationId, branchId, cashierId: req.user.id, action, resourceId, consumedAt: null, expiresAt: { gt: new Date() } } })
  if (!a) throw new AppError('Approval does not match this action or was already used', 403, 'INVALID_APPROVAL')
  const u = await tx.user.findFirst({ where: { id: a.approvedBy, organizationId: a.organizationId, isActive: true } })
  if (!u || !(await getUserPermissions(tx, u.id)).permissions.has(ACTION_PERMISSIONS[action])) throw new AppError('Approver no longer has permission', 403, 'INVALID_APPROVAL')
  const scope = await resolveScope(u.id, a.organizationId)
  if (scope.restricted && !scope.branchIds.includes(branchId)) throw new AppError('Approver no longer has branch access', 403, 'INVALID_APPROVAL')
  const consumed = await tx.posApproval.updateMany({ where: { id: a.id, consumedAt: null }, data: { consumedAt: new Date() } })
  if (consumed.count !== 1) throw new AppError('Approval was already used', 403, 'INVALID_APPROVAL')
  return a.approvedBy
}

const defaultReasons = ['Wrong item', 'Guest changed mind', 'Kitchen error', 'Quality issue', 'Other']
export async function voidReasons() {
  return defaultReasons
}
export async function resolveVoidReason(tx: Prisma.TransactionClient, organizationId: string, input: { reason?: string | null; voidReasonId?: string }) {
  if (!input.voidReasonId) {
    if ((input.reason?.trim().length ?? 0) < 3) throw new AppError('Enter a reason', 400, 'VALIDATION_ERROR')
    return input.reason!.trim()
  }
  const r = await tx.voidReason.findFirst({ where: { id: input.voidReasonId, organizationId, isActive: true } })
  if (!r) throw new AppError('Choose an active void reason', 400, 'VALIDATION_ERROR')
  if (r.name === 'Other') {
    if ((input.reason?.trim().length ?? 0) < 3) throw new AppError('Explain the other reason', 400, 'VALIDATION_ERROR')
    return input.reason!.trim()
  }
  return r.name
}
