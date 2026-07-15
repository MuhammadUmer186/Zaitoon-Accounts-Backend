import { Router, Request, Response } from 'express'
import path from 'path'
import fs from 'fs'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { upload, UPLOAD_ROOT } from '../middleware/upload'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

// POST /documents/upload
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  const file = req.file
  if (!file) throw new AppError('No file uploaded', 400, 'VALIDATION_ERROR')

  const { branchId, documentType, linkedType, linkedId } = req.body as Record<string, string>

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
      linkedType: linkedType || undefined,
      linkedId: linkedId || undefined,
      uploadedBy: req.user.id,
    },
  })

  res.status(201).json(document)
})

// GET /documents
router.get('/', async (req: Request, res: Response) => {
  const { branchId, documentType, linkedType, linkedId } = req.query as Record<string, string>

  const where: Record<string, unknown> = { organizationId: req.user.organizationId }
  if (branchId) where.branchId = branchId
  if (documentType) where.documentType = documentType
  if (linkedType) where.linkedType = linkedType
  if (linkedId) where.linkedId = linkedId

  const documents = await prisma.document.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  })

  res.json({ data: documents, total: documents.length })
})

// GET /documents/:id
router.get('/:id', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')
  res.json(document)
})

// GET /documents/:id/file
router.get('/:id/file', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')

  const resolved = path.resolve(document.filePath)
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT)) || !fs.existsSync(resolved)) {
    throw new AppError('File not found on disk', 404, 'NOT_FOUND')
  }

  res.sendFile(resolved)
})

// POST /documents/:id/process-ocr
router.post('/:id/process-ocr', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')

  // No OCR provider is configured for this deployment. Mark honestly as
  // skipped rather than fabricating extracted data.
  const updated = await prisma.document.update({
    where: { id: req.params.id },
    data: { ocrStatus: 'skipped' },
  })

  res.json(updated)
})

// DELETE /documents/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const document = await prisma.document.findFirst({
    where: { id: req.params.id, organizationId: req.user.organizationId },
  })
  if (!document) throw new AppError('Document not found', 404, 'NOT_FOUND')

  const resolved = path.resolve(document.filePath)
  if (resolved.startsWith(path.resolve(UPLOAD_ROOT)) && fs.existsSync(resolved)) {
    fs.unlinkSync(resolved)
  }

  await prisma.document.delete({ where: { id: req.params.id } })
  res.json({ message: 'Document deleted' })
})

export default router
