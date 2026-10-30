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

  const delegate = (prisma as unknown as Record<string, unknown>)[model] as {
    findMany: (args: object) => Promise<Record<string, unknown>[]>
  }
  if (!delegate?.findMany) throw new Error(`Unsupported document numbering model: ${model}`)
  // The highest number already used is read every time: rows can be written
  // outside this function (branch replicas, imports), and deleted drafts leave
  // gaps, so a counter alone could reissue a number that is still in use. The
  // atomic upsert then reserves max(counter + 1, highest + 1) for this caller.
  const rows = await delegate.findMany({ where: { organizationId: orgId, [field]: { startsWith: yearPrefix } }, select: { [field]: true } })
  const highest = rows.reduce((max, row) => {
    const suffix = String(row[field]).slice(yearPrefix.length)
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max
  }, 0)
  const sequencePrefix = series ? `${prefix}-${series}` : prefix
  const [sequence] = await prisma.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "DocumentSequence" ("organizationId", "model", "field", "prefix", "year", "lastNumber")
    VALUES (${orgId}, ${model}, ${field}, ${sequencePrefix}, ${year}, ${highest + 1})
    ON CONFLICT ("organizationId", "model", "field", "prefix", "year")
    DO UPDATE SET "lastNumber" = GREATEST("DocumentSequence"."lastNumber" + 1, EXCLUDED."lastNumber")
    RETURNING "lastNumber"`
  return `${yearPrefix}${String(sequence.lastNumber).padStart(4, '0')}`
}

export function formatNumber(prefix: string, count: number): string {
  const year = new Date().getFullYear()
  return `${prefix}-${year}-${count.toString().padStart(4, '0')}`
}
