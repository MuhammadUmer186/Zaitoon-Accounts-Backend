import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

export const config = {
  port: parseInt(process.env.PORT || '4000'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production-32chars',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-in-prod32',
  jwtExpiresIn: '15m',
  jwtRefreshExpiresIn: '7d',
  bcryptRounds: 10,
  apiPrefix: '/api/v1',
  syncSecret: process.env.SYNC_SECRET || '',
}
