import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from '../utils/jwt'
import { prisma } from '../config'
import { restaurantPresentation } from '../utils/restaurantPresentation'
import { runWithCurrency } from '../utils/money'

export interface AuthUser {
  id: string
  organizationId: string
  email: string
  posBranchId?: string
}

declare global {
  namespace Express {
    interface Request {
      user: AuthUser
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing or invalid authorization header', code: 'UNAUTHORIZED' })
    return
  }

  const token = authHeader.substring(7)
  let relay = false
  try {
    const payload = verifyAccessToken(token)
    relay = !!payload.relayBranchId
    const relayPath = req.originalUrl.split('?')[0]
    if (relay && !((req.method === 'GET' && /^\/api\/v1\/free-dish\/(?:sections|items|qr-codes|submissions)$/.test(relayPath)) || (req.method === 'POST' && /^\/api\/v1\/free-dish\/(?:verify|redeem)$/.test(relayPath)))) throw new Error('Relay scope denied')
    req.user = {
      id: payload.userId,
      organizationId: payload.organizationId,
      email: payload.email,
      posBranchId: payload.relayBranchId ?? payload.posBranchId,
    }
  } catch {
    res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_INVALID' })
    return
  }
  const identity = await prisma.user.findFirst({
    where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } },
    select: { id: true },
  })
  if (!identity) {
    res.status(401).json({ message: 'Account inactive or unavailable', code: 'TOKEN_INVALID' }); return
  }
  if (req.user.posBranchId && !relay) {
    const path = req.originalUrl.split('?')[0]
    const allowed = /^\/api\/v1\/(pos(?:\/|$)|orders(?:\/|$)|waiter(?:\/|$)|events\/stream$)/.test(path)
      || (req.method === 'GET' && path === '/api/v1/floor')
      || (req.method === 'GET' && path === '/api/v1/kitchen/print-routing')
      || (req.method === 'POST' && /^\/api\/v1\/floor\/tables\/[^/]+\/(seat|clear)$/.test(path))
      || (req.method === 'GET' && /^\/api\/v1\/(auth\/me$|orgs\/[^/]+$|tables$)/.test(path))
      || (req.method === 'POST' && path === '/api/v1/auth/logout')
    if (!allowed || /\/pos\/users\//.test(path)) {
      res.status(403).json({ message: 'This PIN session is limited to the POS', code: 'POS_SCOPE' }); return
    }
    const active = await prisma.user.findFirst({ where: { id: req.user.id, organizationId: req.user.organizationId, isActive: true, organization: { isActive: true } }, select: { id: true } })
    if (!active) { res.status(401).json({ message: 'PIN user is inactive', code: 'TOKEN_INVALID' }); return }
  }
  if (!res.locals.restaurantPresentationLoaded) {
    const org = await prisma.organization.findUnique({ where: { id: req.user.organizationId }, select: { multiBranch: true, name: true, tradeName: true, currency: true } })
    res.locals.currency = org?.currency
    res.locals.restaurantPresentationLoaded = true
    res.locals.singleBranch = org?.multiBranch === false
    res.locals.restaurantName = org?.tradeName || org?.name || 'Restaurant'
    if (res.locals.singleBranch) {
      const json = res.json.bind(res)
      res.json = (body: unknown) => json(restaurantPresentation(body, res.locals.restaurantName))
    }
  }
  runWithCurrency(res.locals.currency || 'PKR', () => next())
}
