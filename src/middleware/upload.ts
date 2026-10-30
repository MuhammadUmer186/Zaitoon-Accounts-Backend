import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { Request, RequestHandler } from 'express'
import { randomUUID } from 'crypto'
import { AppError } from './error'

export const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads')

const EXTENSIONS: Record<string, string[]> = { 'application/pdf': ['.pdf'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/jpg': ['.jpg', '.jpeg'], 'image/png': ['.png'] }

const storage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const orgId = req.user?.organizationId ?? 'unassigned'
    const dir = path.join(UPLOAD_ROOT, orgId)
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const ext = file.mimetype === 'application/pdf' ? '.pdf' : file.mimetype === 'image/png' ? '.png' : '.jpg'
    const unique = `${randomUUID()}${ext}`
    cb(null, unique)
  },
})

function fileFilter(_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  if (!EXTENSIONS[file.mimetype]?.includes(path.extname(file.originalname).toLowerCase())) {
    cb(new AppError('Only PDF, JPG, and PNG files are allowed', 400, 'INVALID_FILE_TYPE'))
    return
  }
  cb(null, true)
}

const parser = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
})

// MIME and extension are caller-controlled. Inspect the bounded upload before
// any route stores a document or uses it as evidence of a purchase/payment.
// These signature/container checks do not replace malware scanning.
export function hasDocumentSignature(bytes: Buffer, mime: string): boolean {
  if (mime === 'application/pdf') return /^%PDF-[12]\.\d/.test(bytes.toString('ascii', 0, 8)) && /%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))
  if (mime === 'image/png') return bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))
  if (mime === 'image/jpeg' || mime === 'image/jpg') return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  return false
}

function verified(receive: RequestHandler): RequestHandler {
  return (req, res, next) => receive(req, res, async error => {
    if (error) return next(error)
    const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : Object.values(req.files ?? {}).flat()
    try {
      for (const file of files) {
        const bytes = await fs.promises.readFile(file.path)
        if (!hasDocumentSignature(bytes, file.mimetype)) throw new AppError('The file content does not match its PDF or image type', 400, 'INVALID_FILE_TYPE')
        if (file.mimetype === 'image/jpg') file.mimetype = 'image/jpeg'
      }
      next()
    } catch (failure) {
      await Promise.all(files.map(file => fs.promises.unlink(file.path).catch(() => undefined)))
      next(failure)
    }
  })
}

export const upload = {
  single: (field: string) => verified(parser.single(field)),
  fields: (fields: multer.Field[]) => verified(parser.fields(fields)),
}
