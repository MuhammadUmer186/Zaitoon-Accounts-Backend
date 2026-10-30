import offlinePosRouter from './offlinePos'
import printerDeviceRouter from './printerDevice'
import commerceSettingsRouter from './commerceSettings'
import customersRouter from './customers'
import paymentsRouter, { callbackRouter, publicPaymentsRouter } from './payments'
import { devicesRouter, publicCheckoutRouter } from './checkout'
import giftCardsRouter from './giftCards'
import { couponRouter, promotionsRouter } from './promotions'
import { floorRouter, floorOrdersRouter, waiterRouter } from './floor'
import deliveryRouter from './delivery'
import callCenterRouter from './callCenter'
import posControlsRouter from './posControls'
import { Router } from 'express'
import authRouter from './auth'
import orgsRouter from './orgs'
import branchesRouter from './branches'
import usersRouter from './users'
import aclRouter from './acl'
import salesRouter from './sales'
import cashClosingRouter from './cashClosing'
import expensesRouter from './expenses'
import spendRegisterRouter from './spendRegister'
import suppliersRouter from './suppliers'
import inventoryRouter from './inventory'
import accountingRouter from './accounting'
import accountsRouter from './accounts'
import bankAccountsRouter from './bankAccounts'
import taxRatesRouter from './taxRates'
import accountingSettingsRouter from './accountingSettings'
import accountingPeriodsRouter from './accountingPeriods'
import reportsRouter from './reports'
import reportsCatalogRouter from './reportsCatalog'
import notificationsRouter from './notifications'
import syncRouter from './sync'
import branchOperationsRouter from './branchOperations'
import branchSyncRouter from './branchSync'
import { branchPilotPolicy } from '../middleware/branchPilot'
import targetsRouter from './targets'
import documentsRouter from './documents'
import purchaseOrdersRouter from './purchaseOrders'
import purchasingRouter from './purchasing'
import alertsRouter from './alerts'
import menuRouter from './menu'
import tablesRouter from './tables'
import ordersRouter from './orders'
import kitchenRouter from './kitchen'
import reviewsRouter from './reviews'
import publicRouter from './public'
import eventsRouter from './events'
import posRouter from './pos'
import zatcaRouter from './zatca'
import onlineRouter from './online'
import hrRouter from './hr'
import { freeDishRouter, publicFreeDishRouter } from './freeDish'

const router = Router()
router.use('/printer-device', printerDeviceRouter)
router.use(branchPilotPolicy)
router.use('/free-dish', freeDishRouter)
router.use('/public/free-dish', publicFreeDishRouter)
router.use('/hr', hrRouter)

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
router.use('/expenses/register', spendRegisterRouter)
router.use('/expenses', expensesRouter)
router.use('/suppliers', suppliersRouter)
router.use('/inventory', inventoryRouter)
router.use('/accounting', accountingRouter)
router.use('/accounts', accountsRouter)
router.use('/bank-accounts', bankAccountsRouter)
router.use('/tax-rates', taxRatesRouter)
router.use('/accounting-settings', accountingSettingsRouter)
router.use('/accounting-periods', accountingPeriodsRouter)
router.use('/reports', reportsRouter)
router.use('/reports', reportsCatalogRouter)
router.use('/notifications', notificationsRouter)
router.use('/sync', syncRouter)
router.use('/branch-operations', branchOperationsRouter)
router.use('/branch-sync', branchSyncRouter)
router.use('/targets', targetsRouter)
router.use('/documents', documentsRouter)
router.use('/purchase-orders', purchaseOrdersRouter)
router.use('/purchasing', purchasingRouter)
router.use('/alerts', alertsRouter)
router.use('/menu', menuRouter)
router.use('/tables', tablesRouter)
router.use('/floor', floorRouter)
router.use('/commerce-settings', commerceSettingsRouter)
router.use('/customers', customersRouter)
router.use('/payments/callbacks', callbackRouter)
router.use('/public/payments', publicPaymentsRouter)
router.use('/payments', paymentsRouter)
router.use('/checkout-devices', devicesRouter)
router.use('/public/checkout', publicCheckoutRouter)
router.use('/gift-cards', giftCardsRouter)
router.use('/promotions', promotionsRouter)
router.use('/orders', couponRouter)
router.use('/waiter', waiterRouter)
router.use('/orders', floorOrdersRouter)
router.use('/orders', ordersRouter)
router.use('/kitchen', kitchenRouter)
router.use('/reviews', reviewsRouter)
router.use('/events', eventsRouter)
router.use('/pos', offlinePosRouter)
router.use('/delivery', deliveryRouter)
router.use('/call-center', callCenterRouter)
router.use('/pos', posControlsRouter)
router.use('/pos', posRouter)
router.use('/zatca', zatcaRouter)
// QR ordering & reviews — no login
router.use('/public', publicRouter)
router.use('/public/online', onlineRouter)

export default router
