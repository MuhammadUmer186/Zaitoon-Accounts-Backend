import 'dotenv/config'
import app from './app'
import { config, prisma } from './config'

async function main() {
  try {
    await prisma.$connect()
    console.log('Database connected successfully')

    app.listen(config.port, () => {
      console.log(`Zaitoon Backend running on http://localhost:${config.port}`)
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
