import { Request } from 'express'
import { PrismaClient } from '@prisma/client'

export interface LogAuditInput {
  req: Request
  action: string
  module: string
  resourceType?: string
  resourceId?: string
  resourceRef?: string
  oldData?: unknown
  newData?: unknown
  branchId?: string
}

// Writes to the AuditLog model, which existed in the schema but had no
// writer anywhere in the backend before this module. Used for every Accounts
// module mutation (create/edit/archive/restore/delete, bank accounts, tax
// rates, mappings, periods, opening balances, journal reversals, imports).
// Never pass full bank account numbers/IBANs in oldData/newData — only the
// masked fields already stored on BankAccount.
export async function logAudit(prisma: PrismaClient, input: LogAuditInput): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: input.req.user.id },
    select: { email: true, firstName: true, lastName: true },
  })

  await prisma.auditLog.create({
    data: {
      organizationId: input.req.user.organizationId,
      branchId: input.branchId,
      userId: input.req.user.id,
      userEmail: user?.email ?? input.req.user.email,
      userName: user ? `${user.firstName} ${user.lastName}` : input.req.user.email,
      action: input.action,
      module: input.module,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceRef: input.resourceRef,
      oldData: input.oldData === undefined ? undefined : JSON.parse(JSON.stringify(input.oldData)),
      newData: input.newData === undefined ? undefined : JSON.parse(JSON.stringify(input.newData)),
      ipAddress: input.req.ip,
    },
  })
}
