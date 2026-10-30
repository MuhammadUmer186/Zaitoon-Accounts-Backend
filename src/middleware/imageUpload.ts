import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { AppError } from './error'
import { UPLOAD_ROOT } from './upload'

const IMAGE_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

// Images for the ordering module — dish photos (staff) and review photos
// (guests, unauthenticated). Stored under uploads/<folder>/ with a random
// name and an extension taken from the MIME type, never from the client.
export function imageUpload(folder: 'menu' | 'reviews' | 'branding') {
  const dir = path.join(UPLOAD_ROOT, folder)
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        fs.mkdirSync(dir, { recursive: true })
        cb(null, dir)
      },
      filename: (_req, file, cb) => {
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${IMAGE_MIME[file.mimetype] ?? '.jpg'}`)
      },
    }),
    fileFilter: (_req, file, cb) => {
      if (!IMAGE_MIME[file.mimetype]) {
        cb(new AppError('Only JPG, PNG and WEBP images are allowed', 400, 'INVALID_FILE_TYPE'))
        return
      }
      cb(null, true)
    },
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  })
}

// Resolves a stored image path and refuses anything outside UPLOAD_ROOT.
export function resolveUpload(filePath: string | null | undefined): string | null {
  if (!filePath) return null
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) || !fs.existsSync(resolved)) return null
  if (!fs.realpathSync(resolved).startsWith(fs.realpathSync(UPLOAD_ROOT) + path.sep)) return null
  return resolved
}

export function removeUpload(filePath: string | null | undefined) {
  const resolved = resolveUpload(filePath)
  // Immutable synchronized blobs may still be referenced by another row or a
  // pending checkpoint. Their cleanup needs a reference-aware retention pass.
  if (resolved?.startsWith(path.join(UPLOAD_ROOT, 'branch-media') + path.sep)) return
  if (resolved) fs.unlink(resolved, () => undefined)
}
