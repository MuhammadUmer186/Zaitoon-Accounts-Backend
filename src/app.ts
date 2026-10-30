import 'express-async-errors'
import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config'
import router from './routes/index'
import { errorHandler } from './middleware/error'
import { apiRateLimit } from './utils/rateLimit'

const app = express()

// Behind Traefik (and the Next.js /api proxy) — take the client IP from
// X-Forwarded-For as added by those private-network proxies, so per-IP rate
// limits apply to real guests rather than to the proxy.
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal'])

app.use(helmet())
app.use(cors({ origin: '*', credentials: true }))
app.use(morgan('dev'))
// payment callbacks are verified against the exact bytes received
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { if (req.url?.includes('/payments/callbacks/')) (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf) } }))
app.use(express.urlencoded({ extended: true }))

// Mount all routes (per-IP request cap first)
app.use(config.apiPrefix, apiRateLimit, router)

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: 'Route not found', code: 'NOT_FOUND' })
})

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  errorHandler(err, req, res, next)
})

export default app
