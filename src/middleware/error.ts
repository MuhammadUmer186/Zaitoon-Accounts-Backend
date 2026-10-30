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
      message: err.issues[0]?.message ?? 'Validation error',
      code: 'VALIDATION_ERROR',
      errors: err.issues,
    })
    return
  }

  if (err.name === 'MulterError') {
    const multerErr = err as Error & { code?: string }
    res.status(400).json({
      message: multerErr.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message,
      code: 'UPLOAD_ERROR',
    })
    return
  }

  // Prisma errors
  if (err.message?.includes('FOODSYNC_BRANCH_FROZEN')) {
    res.status(409).json({ message: 'This PC has handed the branch over. No new transactions can be recorded here.', code: 'BRANCH_HANDED_OVER' })
    return
  }
  if (err.message?.includes('FOODSYNC_BRANCH_OWNERSHIP')) {
    res.status(409).json({ message: 'This branch is operated by its local PC. Cloud writes remain locked until a verified handover.', code: 'BRANCH_LOCAL_OWNER' })
    return
  }
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
