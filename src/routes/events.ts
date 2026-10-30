import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth'
import { getBranchScope } from '../utils/branchScope'
import { openStream } from '../utils/liveEvents'

const router = Router()

router.use(authenticate)

// GET /events/stream — live updates for the signed-in staff member: events
// of their organization, limited to the branches they can access.
router.get('/stream', async (req: Request, res: Response) => {
  const { organizationId, id: userId } = req.user
  const scope = await getBranchScope(req)
  openStream(req, res, (e) => {
    if (e.organizationId !== organizationId) return null
    if (scope.restricted && e.branchId && !scope.branchIds.includes(e.branchId)) return null
    const { organizationId: _org, ...payload } = e
    return payload
  })
})

export default router
