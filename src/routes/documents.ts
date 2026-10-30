import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs'
import { randomUUID } from 'crypto'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { upload, UPLOAD_ROOT } from '../middleware/upload'
import { AppError } from '../middleware/error'
import { isImmutableMedia, checkedUpload } from '../services/branchMedia'
import { getUserPermissions } from '../utils/permissions'

function publicDocument<T extends { filePath: string; storedFilename: string }>(document: T) {
  const { filePath: _path, storedFilename: _stored, ...publicFields } = document
  return publicFields
}

const router = Router()

router.use(authenticate)

// POST /documents/upload
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file
  if (!file) throw new AppError('No file uploaded', 400, 'VALIDATION_ERROR')

  const { branchId, documentType, linkedType, linkedId } = req.body as Record<string, string>

  try {
    await assertBranchAccess(req, branchId)
    if (branchId && !await prisma.branch.count({ where: { id: branchId, organizationId: req.user.organizationId } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
    const document = await prisma.document.create({
      data: {
        organizationId: req.user.organizationId,
        branchId: branchId || '',
        originalFilename: file.originalname,
        storedFilename: file.filename,
        filePath: file.path,
        fileType: file.mimetype,
        fileSize: file.size,
        documentType: documentType || 'other',
        ocrStatus: 'skipped',
        linkedType: linkedType || undefined,
        linkedId: linkedId || undefined,
        uploadedBy: req.user.id,
      },
    })

    res.status(201).json(publicDocument(document))
  } catch (error) {
    await fs.promises.unlink(file.path).catch(() => undefined)
    throw error
  }
})

// GET /documents
router.get('/', async (req: Request, res: Response) => {
  const { branchId, documentType, linkedType, linkedId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  const allowedBranches = await branchFilter(req, branchId)
  if (allowedBranches) where.branchId = allowedBranches
  if (documentType) where.documentType = documentType
  if (linkedType) where.linkedType = linkedType
  if (linkedId) where.linkedId = linkedId

  const documents = await prisma.document.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  res.json({ data: documents.map(publicDocument), total: documents.length })
})

// GET /documents/:id
router.get('/:id', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, document.branchId)
  res.json(publicDocument(document))
})

// GET /documents/:id/file
router.get('/:id/file', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, document.branchId)

  const resolved = path.resolve(document.filePath)
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) || !fs.existsSync(resolved)) {
    throw new AppError('File not found on disk', 404, 'NOT_FOUND')
  }
  await checkedUpload(resolved)

  // Use an allowlisted download type even for legacy files. Never render an
  // extension-derived HTML response from a document uploaded before validation.
  const types = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'])
  res.attachment(document.originalFilename)
  res.setHeader('Content-Type', types.has(document.fileType) ? document.fileType.replace('image/jpg', 'image/jpeg') : 'application/octet-stream')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.sendFile(resolved)
})

// POST /documents/:id/process-ocr
router.post('/:id/process-ocr', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, document.branchId)

  // No OCR provider is configured for this deployment. Mark honestly as
  // skipped rather than fabricating extracted data.
  const updated = await prisma.document.update({
    where: { id: req.params.id },
    data: { ocrStatus: 'skipped' },
  })

  res.json(publicDocument(updated))
})

// DELETE /documents/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, document.branchId)
  // Uploading an attachment does not authorize colleagues to remove it.
  if (document.uploadedBy !== req.user.id) {
    const { roles } = await getUserPermissions(prisma, req.user.id)
    if (!roles.some(role => ['owner', 'super_admin', 'admin'].includes(role))) {
      throw new AppError('Only the uploader or an organization administrator can delete this document', 403, 'FORBIDDEN')
    }
  }

  const resolved = path.resolve(document.filePath)
  const staged = !isImmutableMedia(resolved) && resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep) && fs.existsSync(resolved)
    ? `${resolved}.pending-delete-${randomUUID()}` : null
  if (staged) await fs.promises.rename(resolved, staged)
  try {
    await prisma.document.delete({ where: { id: req.params.id } })
  } catch (error) {
    if (staged) await fs.promises.rename(staged, resolved)
    throw error
  }
  // Once the row is deleted, a cleanup failure must not restore a broken link.
  if (staged) await fs.promises.unlink(staged).catch(() => console.error('Document cleanup pending'))
  res.json({ message: 'Document deleted' })
})

export default router
