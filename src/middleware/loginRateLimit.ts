import { createHash } from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config'
import { AppError } from './error'

// Shared PostgreSQL buckets work across API replicas. Hashes rotate with each
// window, so raw IP addresses and account identifiers are not persisted here.
export async function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now(), windowMs = 15 * 60000, window = Math.floor(now / windowMs)
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : ''
  const configured = Number(process.env.LOGIN_RATE_LIMIT || 30)
  const limit = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 30
  const expiresAt = new Date((window + 1) * windowMs)
  for (const identifier of [`ip:${req.ip}`, `account:${email}`]) {
    const key = createHash('sha256').update(`${identifier}:${window}`).digest('hex')
    const bucket = await prisma.authAttemptBucket.upsert({ where: { key }, create: { key, attempts: 1, expiresAt }, update: { attempts: { increment: 1 } } })
    if (bucket.attempts > limit) {
      res.setHeader('Retry-After', Math.ceil((+expiresAt - now) / 1000))
      throw new AppError('Too many sign-in attempts. Please try again later.', 429, 'TOO_MANY_ATTEMPTS')
    }
  }
  await prisma.authAttemptBucket.deleteMany({ where: { expiresAt: { lt: new Date(now) } } })
  next()
}
