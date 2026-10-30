import 'dotenv/config'
import app from './app'
import { config, prisma } from './config'
import { bootstrapSuperAdmin } from './utils/bootstrapSuperAdmin'
import { startPaymentWorker } from './services/payments'
import { startZatcaWorker } from './services/zatca'
import { startBranchSyncWorker } from './services/branchSync'
import { startBranchControlPlaneMaintenance } from './services/branchReplicaTransport'
import { startKitchenPrintWorker } from './services/kitchenPrinting'

async function main() {
  try {
    await prisma.$connect()
    console.log('Database connected successfully')

    await bootstrapSuperAdmin(prisma)
    // reports queued ZATCA e-invoices (retries failures with back-off)
    startZatcaWorker()
    startPaymentWorker()
    startBranchSyncWorker()
    startBranchControlPlaneMaintenance()
    startKitchenPrintWorker()

    app.listen(config.port, process.env.BIND_HOST || '0.0.0.0', () => {
      console.log(`FoodSync Backend running on http://localhost:${config.port}`)
      console.log(`API base: http://localhost:${config.port}${config.apiPrefix}`)
      console.log(`Health: http://localhost:${config.port}${config.apiPrefix}/health`)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    await prisma.$disconnect()
    process.exit(1)
  }
}

process.on('SIGINT', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await prisma.$disconnect()
  process.exit(0)
})

main()
