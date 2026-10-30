import { Request, Response, NextFunction } from 'express'

// Minimal fixed-window limiter for the unauthenticated QR endpoints (one
// process, in memory) — enough to stop a script from flooding a table with
// orders or reviews. Keyed by client IP + bucket name.
export function rateLimit(bucket: string, max: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now()
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
    }
    const key = `${bucket}:${req.ip}`
    const entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }
    entry.count++
    if (entry.count > max) {
      res.status(429).json({ message: 'Too many requests — please wait a moment and try again', code: 'RATE_LIMITED' })
      return
    }
    next()
  }
}
