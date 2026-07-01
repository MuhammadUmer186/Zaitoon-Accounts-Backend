import { Router, Request, Response } from 'express'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { AppError } from '../middleware/error'

const router = Router()

router.use(authenticate)

// GET /notifications
router.get('/', async (req: Request, res: Response) => {
  const { unreadOnly } = req.query as Record<string, string>

  const notifications = await prisma.notification.findMany({
    where: {
      organizationId: req.user.organizationId,
      userId: req.user.id,
      ...(unreadOnly === 'true' && { isRead: false }),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const unreadCount = await prisma.notification.count({
    where: { organizationId: req.user.organizationId, userId: req.user.id, isRead: false },
  })

  res.json({ data: notifications, unreadCount })
})

// PUT /notifications/:id/read
router.put('/:id/read', async (req: Request, res: Response) => {
  const notif = await prisma.notification.findFirst({
    where: { id: req.params.id, userId: req.user.id, organizationId: req.user.organizationId },
  })
  if (!notif) throw new AppError('Notification not found', 404, 'NOT_FOUND')

  const updated = await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true },
  })
  res.json(updated)
})

// PUT /notifications/read-all
router.put('/read-all', async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { userId: req.user.id, organizationId: req.user.organizationId, isRead: false },
    data: { isRead: true },
  })
  res.json({ message: 'All notifications marked as read' })
})

// DELETE /notifications/:id
router.delete('/:id', async (req: Request, res: Response) => {
  const notif = await prisma.notification.findFirst({
    where: { id: req.params.id, userId: req.user.id, organizationId: req.user.organizationId },
  })
  if (!notif) throw new AppError('Notification not found', 404, 'NOT_FOUND')

  await prisma.notification.delete({ where: { id: req.params.id } })
  res.json({ message: 'Notification deleted' })
})

export default router
