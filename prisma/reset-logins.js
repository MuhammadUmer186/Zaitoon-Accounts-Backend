require('dotenv/config')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

// Deletes every user login EXCEPT the env Super Admin (SUPER_ADMIN_EMAIL), so
// the remaining users can be created again from Users & Roles. Their roles,
// branch access, sessions and notifications go with them (cascade). Business
// records (sales, expenses, bills, ...) are untouched — they only store the
// creator's id, which simply won't resolve to a name any more.
//
// Dry run by default — lists what would be deleted:
//   npm run db:reset-logins
// Actually delete:
//   npm run db:reset-logins -- --confirm
//
// The Super Admin must already exist: start the backend once with
// SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD set (see .env.example) first.

async function main() {
  const confirm = process.argv.includes('--confirm')
  const email = process.env.SUPER_ADMIN_EMAIL && process.env.SUPER_ADMIN_EMAIL.trim()
  if (!email) {
    console.error('SUPER_ADMIN_EMAIL is not set — refusing to run (it decides which login is kept).')
    process.exitCode = 1
    return
  }

  const keep = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    include: { roles: { include: { role: true } } },
  })
  if (!keep) {
    console.error(`No user ${email} found. Restart the backend with SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD set so it gets created, then run this again.`)
    process.exitCode = 1
    return
  }
  if (!keep.roles.some((r) => r.role.name === 'super_admin')) {
    console.error(`${keep.email} does not have the Super Admin role yet — restart the backend with the SUPER_ADMIN_* env set, then run this again.`)
    process.exitCode = 1
    return
  }

  const others = await prisma.user.findMany({
    where: { id: { not: keep.id } },
    select: { email: true, firstName: true, lastName: true, roles: { select: { role: { select: { name: true } } } } },
    orderBy: { email: 'asc' },
  })

  console.log(`Keeping: ${keep.email} (Super Admin)`)
  if (others.length === 0) {
    console.log('No other logins exist — nothing to do.')
    return
  }
  console.log(`${confirm ? 'Deleting' : 'Would delete'} ${others.length} login(s):`)
  for (const u of others) {
    console.log(`  - ${u.email}  (${u.firstName} ${u.lastName}; ${u.roles.map((r) => r.role.name).join(', ') || 'no role'})`)
  }

  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to delete them:  npm run db:reset-logins -- --confirm')
    return
  }

  const { count } = await prisma.user.deleteMany({ where: { id: { not: keep.id } } })
  console.log(`\nDeleted ${count} login(s). Only ${keep.email} can sign in now — recreate the others from Users & Roles.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
