import { PrismaClient } from '@prisma/client'

// Permissions added by later modules. Created on startup when missing so a
// deployment doesn't depend on someone running `npm run db:sync-permissions`.
// Super Admin and Administrator get them automatically (utils/permissions.ts);
// other roles are granted them from Users & Roles → Roles.
const PERMISSIONS = [
  { key: 'free_dish_manage', module: 'free_dish', description: 'Free Dish: create section QR codes and view guest registrations' },
  { key: 'free_dish_redeem', module: 'free_dish', description: 'Free Dish: scan guest vouchers and give the free dish' },
]

export async function ensurePermissions(prisma: PrismaClient) {
  try {
    for (const p of PERMISSIONS) {
      await prisma.permission.upsert({ where: { key: p.key }, update: {}, create: p })
    }
  } catch (err) {
    console.error('[permissions] could not ensure permissions:', err)
  }
}
