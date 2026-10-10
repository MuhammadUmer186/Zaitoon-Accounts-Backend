import { Request, Response, NextFunction } from 'express'
import { AppError } from '../middleware/error'

// In-memory limits for a single backend instance (no extra infrastructure).
// They reset when the server restarts, which is acceptable for brute-force
// protection: an attacker still can't try more than a handful of passwords
// per lock window.

const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS_PER_ACCOUNT = 5 // same email from the same IP
const MAX_FAILS_PER_IP = 25 // any emails from one IP (password spraying)

interface Bucket { count: number; firstAt: number; lockedUntil: number }
const accountFails = new Map<string, Bucket>()
const ipFails = new Map<string, Bucket>()

const now = () => Date.now()
const clientIp = (req: Request) => req.ip || req.socket.remoteAddress || 'unknown'

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  const b = map.get(key)
  if (!b || now() - b.firstAt > WINDOW_MS) {
    const fresh = { count: 0, firstAt: now(), lockedUntil: b && b.lockedUntil > now() ? b.lockedUntil : 0 }
    map.set(key, fresh)
    return fresh
  }
  return b
}

function lockedMessage(until: number) {
  const mins = Math.max(1, Math.ceil((until - now()) / 60000))
  return `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`
}

// Call before checking a password; throws 429 while locked.
export function assertLoginAllowed(req: Request, email: string) {
  const a = accountFails.get(`${clientIp(req)}|${email.toLowerCase()}`)
  if (a && a.lockedUntil > now()) throw new AppError(lockedMessage(a.lockedUntil), 429, 'TOO_MANY_ATTEMPTS')
  const i = ipFails.get(clientIp(req))
  if (i && i.lockedUntil > now()) throw new AppError(lockedMessage(i.lockedUntil), 429, 'TOO_MANY_ATTEMPTS')
}

export function recordLoginFailure(req: Request, email: string) {
  const a = bucket(accountFails, `${clientIp(req)}|${email.toLowerCase()}`)
  a.count++
  if (a.count >= MAX_FAILS_PER_ACCOUNT) a.lockedUntil = now() + WINDOW_MS
  const i = bucket(ipFails, clientIp(req))
  i.count++
  if (i.count >= MAX_FAILS_PER_IP) i.lockedUntil = now() + WINDOW_MS
}

export function clearLoginFailures(req: Request, email: string) {
  accountFails.delete(`${clientIp(req)}|${email.toLowerCase()}`)
}

// General per-IP request cap for the whole API (generous — a dashboard load
// fires many requests at once).
const API_WINDOW_MS = 60 * 1000
const API_MAX = 600
const apiHits = new Map<string, { count: number; start: number }>()

export function apiRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = clientIp(req)
  const h = apiHits.get(ip)
  if (!h || now() - h.start > API_WINDOW_MS) {
    apiHits.set(ip, { count: 1, start: now() })
    return next()
  }
  h.count++
  if (h.count > API_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((h.start + API_WINDOW_MS - now()) / 1000)))
    res.status(429).json({ message: 'Too many requests — please slow down', code: 'RATE_LIMITED' })
    return
  }
  next()
}

// Drop expired entries every 10 minutes so the maps don't grow forever
setInterval(() => {
  const t = now()
  for (const [k, b] of accountFails) if (t - b.firstAt > WINDOW_MS && b.lockedUntil < t) accountFails.delete(k)
  for (const [k, b] of ipFails) if (t - b.firstAt > WINDOW_MS && b.lockedUntil < t) ipFails.delete(k)
  for (const [k, h] of apiHits) if (t - h.start > API_WINDOW_MS) apiHits.delete(k)
}, 10 * 60 * 1000).unref()
