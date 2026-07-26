import { PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'
import { AccountClass } from '../types/accounting'

const CLASS_NORMAL_BALANCE: Record<AccountClass, 'DEBIT' | 'CREDIT'> = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
  EXPENSE: 'DEBIT',
}

// Normal balance is always derived from account class — never a free-form
// user choice — so debit/credit conventions can't drift from double-entry
// fundamentals.
export function normalBalanceForClass(accountClass: AccountClass) {
  return CLASS_NORMAL_BALANCE[accountClass]
}

export async function assertUniqueCode(prisma: PrismaClient, organizationId: string, code: string, excludeId?: string) {
  const existing = await prisma.account.findFirst({ where: { organizationId, code } })
  if (existing && existing.id !== excludeId) {
    throw new AppError(`Account code "${code}" is already in use`, 400, 'DUPLICATE_CODE')
  }
}

// Validates a proposed parent: same org, not archived, same accountClass
// (a parent groups children of its own class), and never creates a cycle.
export async function assertValidParent(
  prisma: PrismaClient,
  organizationId: string,
  parentId: string | undefined | null,
  accountClass: AccountClass,
  selfId?: string
) {
  if (!parentId) return

  if (parentId === selfId) throw new AppError('An account cannot be its own parent', 400, 'INVALID_PARENT')

  const parent = await prisma.account.findFirst({ where: { id: parentId, organizationId } })
  if (!parent) throw new AppError('Parent account not found', 404, 'PARENT_NOT_FOUND')
  if (parent.status !== 'ACTIVE') throw new AppError('Archived accounts cannot receive new children', 400, 'PARENT_ARCHIVED')
  if (parent.accountClass !== accountClass) {
    throw new AppError('Parent account must belong to the same account class', 400, 'INCOMPATIBLE_PARENT_CLASS')
  }

  if (selfId) {
    let cursor: string | null = parent.parentId
    const seen = new Set<string>([parent.id])
    while (cursor) {
      if (cursor === selfId) throw new AppError('This would create a circular account hierarchy', 400, 'CIRCULAR_HIERARCHY')
      if (seen.has(cursor)) break
      seen.add(cursor)
      const next = await prisma.account.findUnique({ where: { id: cursor }, select: { parentId: true } })
      cursor = next?.parentId ?? null
    }
  }
}

export function assertNoControlManualPostingConflict(isControlAccount: boolean, allowManualPosting: boolean) {
  if (isControlAccount && allowManualPosting) {
    throw new AppError('A control account cannot allow manual posting', 400, 'CONTROL_ACCOUNT_MANUAL_POSTING')
  }
}
