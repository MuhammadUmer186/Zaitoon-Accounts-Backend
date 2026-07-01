import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { config } from './config'
import router from './routes/index'
import { errorHandler } from './middleware/error'

const app = express()

app.use(helmet())
app.use(cors({ origin: '*', credentials: true }))
app.use(morgan('dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Mount all routes
app.use(config.apiPrefix, router)

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: 'Route not found', code: 'NOT_FOUND' })
})

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  errorHandler(err, req, res, next)
})

export default app
