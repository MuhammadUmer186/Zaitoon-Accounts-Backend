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

// Behind Dokploy's reverse proxy: trust the first hop so req.ip is the
// visitor's real address (needed for per-IP rate limits).
app.set('trust proxy', 1)

app.use(helmet())
app.use(cors({ origin: '*', credentials: true }))
app.use(morgan('dev'))
app.use(express.json({ limit: '10mb' }))
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
