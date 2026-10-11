import { PrismaClient } from '@prisma/client'

// Transaction clients omit $transaction; reuse the caller's transaction.
export async function financeTransaction<T>(db: PrismaClient, work: (tx: PrismaClient) => Promise<T>): Promise<T> {
  if (typeof db.$transaction !== 'function') return work(db)
  return db.$transaction((tx) => work(tx as unknown as PrismaClient), { timeout: 30_000 })
}

// Only call inside a transaction. Also protects resources not yet created.
export async function financeLock(db: PrismaClient, resource: string): Promise<void> {
  await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${resource}, 0))::text AS locked`
}
