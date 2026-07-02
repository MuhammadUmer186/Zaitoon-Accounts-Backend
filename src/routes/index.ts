import { Router } from 'express'
import authRouter from './auth'
import orgsRouter from './orgs'
import branchesRouter from './branches'
import usersRouter from './users'
import aclRouter from './acl'
import salesRouter from './sales'
import cashClosingRouter from './cashClosing'
import expensesRouter from './expenses'
import suppliersRouter from './suppliers'
import inventoryRouter from './inventory'
import accountingRouter from './accounting'
import reportsRouter from './reports'
import notificationsRouter from './notifications'
import syncRouter from './sync'
import targetsRouter from './targets'

const router = Router()

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

router.use('/auth', authRouter)
router.use('/orgs', orgsRouter)
router.use('/branches', branchesRouter)
router.use('/users', usersRouter)
router.use('/acl', aclRouter)
router.use('/sales', salesRouter)
router.use('/cash-closing', cashClosingRouter)
router.use('/expenses', expensesRouter)
router.use('/suppliers', suppliersRouter)
router.use('/inventory', inventoryRouter)
router.use('/accounting', accountingRouter)
router.use('/reports', reportsRouter)
router.use('/notifications', notificationsRouter)
router.use('/sync', syncRouter)
router.use('/targets', targetsRouter)

export default router
