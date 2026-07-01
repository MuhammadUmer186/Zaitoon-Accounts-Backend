import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'

export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR'
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      message: err.message,
      code: err.code,
    })
    return
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      message: err.errors[0]?.message ?? 'Validation error',
      code: 'VALIDATION_ERROR',
      errors: err.errors,
    })
    return
  }

  // Prisma errors
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as Error & { code?: string; meta?: { target?: string[] } }
    if (prismaErr.code === 'P2002') {
      res.status(409).json({
        message: `Duplicate value for field: ${prismaErr.meta?.target?.join(', ')}`,
        code: 'DUPLICATE_ENTRY',
      })
      return
    }
    if (prismaErr.code === 'P2025') {
      res.status(404).json({
        message: 'Record not found',
        code: 'NOT_FOUND',
      })
      return
    }
  }

  console.error('Unhandled error:', err)
  res.status(500).json({
    message: 'Internal server error',
    code: 'INTERNAL_ERROR',
  })
}
