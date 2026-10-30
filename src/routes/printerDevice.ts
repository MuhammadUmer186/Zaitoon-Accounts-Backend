import { Router } from 'express'
import { authenticateCloudPrinter, pollCloudKitchenPrinter, acknowledgeCloudKitchenPrinter, cloudAckSchema } from '../services/cloudKitchenPrinting'
import { rateLimit } from '../middleware/rateLimit'

const router = Router()
router.use(rateLimit('cloud-printer', 600, 60000))
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
// Device credentials grant access only to this printer's station and branch.
// No user JWT, account password, order mutation or arbitrary print payloads.
router.post('/:id/poll', async (req, res) => {
  const printer = authenticateCloudPrinter(req.params.id, req.get('authorization'))
  const frame = await pollCloudKitchenPrinter(printer)
  if (!frame) { res.status(204).end(); return }
  res.setHeader('X-FoodSync-Frame-Length', String(frame.length))
  res.type('application/octet-stream').send(frame)
})
router.post('/:id/ack', async (req, res) => {
  const printer = authenticateCloudPrinter(req.params.id, req.get('authorization'))
  res.json(await acknowledgeCloudKitchenPrinter(printer, cloudAckSchema.parse(req.body)))
})
export default router
