import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { Request } from 'express'
import { AppError } from './error'

export const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads')

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'])

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const orgId = req.user?.organizationId ?? 'unassigned'
    const dir = path.join(UPLOAD_ROOT, orgId)
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname)
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`
    cb(null, unique)
  },
})

function fileFilter(_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    cb(new AppError('Only PDF, JPG, and PNG files are allowed', 400, 'INVALID_FILE_TYPE'))
    return
  }
  cb(null, true)
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
})
