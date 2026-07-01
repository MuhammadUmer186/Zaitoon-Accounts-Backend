import jwt from 'jsonwebtoken'
import { config } from '../config'

export interface AccessTokenPayload {
  userId: string
  organizationId: string
  email: string
}

export interface RefreshTokenPayload {
  userId: string
}

export function signAccessToken(userId: string, organizationId: string, email: string): string {
  return jwt.sign(
    { userId, organizationId, email } as AccessTokenPayload,
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn } as jwt.SignOptions
  )
}

export function signRefreshToken(userId: string): string {
  return jwt.sign(
    { userId } as RefreshTokenPayload,
    config.jwtRefreshSecret,
    { expiresIn: config.jwtRefreshExpiresIn } as jwt.SignOptions
  )
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AccessTokenPayload
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwtRefreshSecret) as RefreshTokenPayload
}
