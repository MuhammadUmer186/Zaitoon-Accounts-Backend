import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { AppError } from '../middleware/error'
import { resolveUpload, removeUpload } from '../middleware/imageUpload'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { paginate, paginatedResponse, parsePageParams } from '../utils/pagination'
import { logAudit } from '../utils/audit'

const router = Router()

router.use(authenticate)
router.use(requirePermission('can_view_reviews'))

function buildWhere(organizationId: string, query: Record<string, string>, branch: unknown) {
  const { rating, fromDate, toDate, tableId, withPhoto } = query
  const where: Record<string, unknown> = { organizationId }
  if (branch) where.branchId = branch
  if (tableId) where.tableId = tableId
  if (rating && /^[1-5]$/.test(rating)) where.rating = Number(rating)
  if (withPhoto === 'true') where.imagePath = { not: null }
  if (fromDate || toDate) {
    where.createdAt = {
      ...(fromDate && { gte: new Date(`${fromDate}T00:00:00`) }),
      ...(toDate && { lte: new Date(`${toDate}T23:59:59.999`) }),
    }
  }
  return where
}

// GET /reviews
router.get('/', async (req: Request, res: Response) => {
  const { page, limit } = parsePageParams(req.query as Record<string, unknown>)
  const branch = await branchFilter(req, (req.query as Record<string, string>).branchId)
  const where = buildWhere(req.user.organizationId, req.query as Record<string, string>, branch)

  const [reviews, total] = await Promise.all([
    prisma.orderReview.findMany({
      where,
      ...paginate(page, limit),
      orderBy: { createdAt: 'desc' },
      include: {
        table: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true } },
        order: { select: { id: true, orderNo: true, totalAmount: true, createdAt: true } },
      },
    }),
    prisma.orderReview.count({ where }),
  ])
  res.json(paginatedResponse(
    reviews.map(({ imagePath, ...r }) => ({ ...r, hasImage: !!imagePath })),
    total, page, limit,
  ))
})

// GET /reviews/stats — average and star distribution for the current filters
router.get('/stats', async (req: Request, res: Response) => {
  const branch = await branchFilter(req, (req.query as Record<string, string>).branchId)
  // The star distribution ignores the star filter itself
  const { rating: _rating, ...query } = req.query as Record<string, string>
  const where = buildWhere(req.user.organizationId, query, branch)

  const [agg, groups] = await Promise.all([
    prisma.orderReview.aggregate({ where, _avg: { rating: true }, _count: { _all: true } }),
    prisma.orderReview.groupBy({ by: ['rating'], where, _count: { _all: true } }),
  ])
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const g of groups) distribution[g.rating] = g._count._all
  res.json({ average: agg._avg.rating ?? 0, total: agg._count._all, distribution })
})

// GET /reviews/:id/image
router.get('/:id/image', async (req: Request, res: Response) => {
  const review = await prisma.orderReview.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!review) throw new AppError('Review not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, review.branchId)
  const file = resolveUpload(review.imagePath)
  if (!file) throw new AppError('Image not found', 404, 'NOT_FOUND')
  res.sendFile(file)
})

// DELETE /reviews/:id — moderation (spam / abusive content)
router.delete('/:id', async (req: Request, res: Response) => {
  const review = await prisma.orderReview.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!review) throw new AppError('Review not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, review.branchId)
  await prisma.orderReview.delete({ where: { id: review.id } })
  removeUpload(review.imagePath)
  await logAudit(prisma, { req, action: 'delete', module: 'reviews', resourceType: 'order_review', resourceId: review.id, branchId: review.branchId, oldData: { rating: review.rating, comment: review.comment } })
  res.json({ message: 'Review deleted' })
})

export default router
