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

  // Find the latest record for this org with this prefix
  // We use a raw approach by querying the specific model
  let count = 0

  try {
    const modelDelegate = (prisma as Record<string, unknown>)[model] as {
      count: (args: { where: Record<string, unknown> }) => Promise<number>
    }
    if (modelDelegate && typeof modelDelegate.count === 'function') {
      count = await modelDelegate.count({
        where: {
          organizationId: orgId,
          [field]: { startsWith: yearPrefix },
        },
      })
    }
  } catch {
    count = 0
  }

  return `${yearPrefix}${(count + 1).toString().padStart(4, '0')}`
}

export function formatNumber(prefix: string, count: number): string {
  const year = new Date().getFullYear()
  return `${prefix}-${year}-${count.toString().padStart(4, '0')}`
}
