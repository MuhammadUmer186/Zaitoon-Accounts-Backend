import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { config } from '../config'

export interface AccessTokenPayload {
  userId: string
  organizationId: string
  email: string
  posBranchId?: string
  relayBranchId?: string
}

export function signBranchRelayToken(userId: string, organizationId: string, email: string, relayBranchId: string): string {
  return jwt.sign({ userId, organizationId, email, relayBranchId }, config.jwtSecret, { expiresIn: '30s', audience: 'branch-free-dish' })
}

export function signPosAccessToken(userId: string, organizationId: string, email: string, posBranchId: string): string {
  return jwt.sign({ userId, organizationId, email, posBranchId }, config.jwtSecret, { expiresIn: '15m' })
}

export interface RefreshTokenPayload {
  userId: string
  jti: string
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
    { userId, jti: crypto.randomUUID() } as RefreshTokenPayload,
    config.jwtRefreshSecret,
    { expiresIn: config.jwtRefreshExpiresIn } as jwt.SignOptions
  )
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const p = jwt.verify(token, config.jwtSecret) as AccessTokenPayload
  if (!p.userId || !p.organizationId || !p.email) throw new Error('Not an access token')
  if (p.relayBranchId && (p as AccessTokenPayload & { aud?: string }).aud !== 'branch-free-dish') throw new Error('Invalid relay audience')
  return p
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, config.jwtRefreshSecret) as RefreshTokenPayload
}
