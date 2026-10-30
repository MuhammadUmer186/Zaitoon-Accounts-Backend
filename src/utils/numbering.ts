import { Prisma, PrismaClient } from '@prisma/client'
import { branchNumberSeries } from './branchNumbering'

export async function nextNumber(
  prisma: PrismaClient | Prisma.TransactionClient,
  model: string,
  field: string,
  prefix: string,
  orgId: string
): Promise<string> {
  const year = new Date().getFullYear()
  // A branch PC numbers within its own series (SL-2026-P1-0001). The cloud's
  // scan below ignores those rows because their suffix is not purely numeric.
  const series = await branchNumberSeries(prisma)
  const yearPrefix = `${prefix}-${year}-${series ? `${series}-` : ''}`

  // Deleted drafts leave gaps. Counting rows can reissue a number that is
  // still in use, preventing the next paid order from reaching Daily Sales.
  const delegate = (prisma as unknown as Record<string, unknown>)[model] as {
    findMany: (args: unknown) => Promise<Record<string, unknown>[]>
  }
  const rows = await delegate.findMany({ where: { organizationId: orgId, [field]: { startsWith: yearPrefix } }, select: { [field]: true } })
  const highest = rows.reduce((max, row) => {
    const suffix = String(row[field]).slice(yearPrefix.length)
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max
  }, 0)
  return `${yearPrefix}${(highest + 1).toString().padStart(4, '0')}`
}

export function formatNumber(prefix: string, count: number): string {
  const year = new Date().getFullYear()
  return `${prefix}-${year}-${count.toString().padStart(4, '0')}`
}
