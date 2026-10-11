import { PrismaClient } from '@prisma/client'

export async function nextNumber(
  prisma: PrismaClient,
  model: string,
  field: string,
  prefix: string,
  orgId: string
): Promise<string> {
  const year = new Date().getFullYear()
  const yearPrefix = `${prefix}-${year}-`

  const delegate = (prisma as unknown as Record<string, unknown>)[model] as {
    findMany: (args: object) => Promise<Record<string, unknown>[]>
  }
  if (!delegate?.findMany) throw new Error(`Unsupported document numbering model: ${model}`)
  // Bootstrap from the greatest suffix; atomic upsert reserves each number.
  const key = { organizationId: orgId, model, field, prefix, year }
  const existingSequence = await prisma.documentSequence.findUnique({ where: { organizationId_model_field_prefix_year: key } })
  const existing = existingSequence ? [] : await delegate.findMany({ where: { organizationId: orgId, [field]: { startsWith: yearPrefix } }, select: { [field]: true } })
  const maximum = existing.reduce((max, row) => {
    const suffix = String(row[field]).slice(yearPrefix.length)
    return /^\d+$/.test(suffix) ? Math.max(max, Number(suffix)) : max
  }, 0)
  const sequence = await prisma.documentSequence.upsert({
    where: { organizationId_model_field_prefix_year: key },
    create: { organizationId: orgId, model, field, prefix, year, lastNumber: maximum + 1 },
    update: { lastNumber: { increment: 1 } },
  })
  return `${yearPrefix}${String(sequence.lastNumber).padStart(4, '0')}`
}

export function formatNumber(prefix: string, count: number): string {
  const year = new Date().getFullYear()
  return `${prefix}-${year}-${count.toString().padStart(4, '0')}`
}
