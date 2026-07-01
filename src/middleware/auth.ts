import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from '../utils/jwt'

export interface AuthUser {
  id: string
  organizationId: string
  email: string
}

declare global {
  namespace Express {
    interface Request {
      user: AuthUser
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing or invalid authorization header', code: 'UNAUTHORIZED' })
    return
  }

  const token = authHeader.substring(7)
  try {
    const payload = verifyAccessToken(token)
    req.user = {
      id: payload.userId,
      organizationId: payload.organizationId,
      email: payload.email,
    }
    next()
  } catch {
    res.status(401).json({ message: 'Invalid or expired token', code: 'TOKEN_INVALID' })
  }
}
