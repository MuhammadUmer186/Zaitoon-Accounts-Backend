// Run in the backend container console. Reads configuration; does not write DB.
// Output includes a NEW PRIVATE device key. Do not publish or paste it in chat.
const { PrismaClient } = require('@prisma/client');
const crypto = require('node:crypto');
require('dotenv').config();
const db = new PrismaClient();
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
(async () => {
  if (args.includes('--list')) {
    const branches = await db.branch.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true, organizationId: true } });
    const stations = await db.kitchenStation.findMany({ where: { isActive: true }, select: { id: true, name: true, organizationId: true } });
    console.log(JSON.stringify({ branches, stations }, null, 2)); return;
  }
  const branchId = option('--branch-id'), branchCode = option('--branch-code');
  if (!branchId && !branchCode) throw new Error('Use --list first, then --branch-id ID --station-id ID (or none) --portal https://YOUR-STAFF-PORTAL');
  const branches = await db.branch.findMany({ where: { isActive: true, ...(branchId ? { id: branchId } : { code: branchCode }) } });
  if (branches.length !== 1) throw new Error('Choose one unambiguous branch using --branch-id from --list.');
  const branch = branches[0], stationId = option('--station-id');
  if (!stationId) throw new Error('Supply --station-id from --list, or none for unrouted dishes.');
  if (stationId !== 'none' && !await db.kitchenStation.count({ where: { id: stationId, organizationId: branch.organizationId, isActive: true } })) throw new Error('Station must be active and belong to this branch organization.');
  if (await db.branchSyncNode.count({ where: { branchId: branch.id, organizationId: branch.organizationId, ownsWrites: true } })) throw new Error('This branch is owned by a branch PC. Use its existing local printing setup.');
  const portal = new URL(option('--portal') || '');
  if (portal.protocol !== 'https:' || portal.username || portal.password || portal.pathname !== '/' || portal.search || portal.hash) throw new Error('Supply the staff portal HTTPS origin only, without a path or credentials.');
  const id = option('--id') || 'cloud-kitchen';
  if (!/^cloud-[a-zA-Z0-9_-]{1,34}$/.test(id)) throw new Error('Use a cloud- ID with letters, digits, hyphens or underscores (max 40 characters).');
  const configured = JSON.parse(process.env.KITCHEN_CLOUD_PRINTERS_JSON || '[]');
  if (configured.some(p => p.id === id || (p.organizationId === branch.organizationId && p.branchId === branch.id && p.stationId === stationId))) throw new Error('This ID or station is already configured. Preserve its existing key and activation time; do not blindly replace an active device.');
  const key = crypto.randomBytes(32).toString('hex');
  const printer = { id, organizationId: branch.organizationId, branchId: branch.id, stationId, key, enabledAt: new Date().toISOString() };
  console.log('PRIVATE: add this Dokploy environment variable, then redeploy:');
  console.log('KITCHEN_CLOUD_PRINTERS_JSON=' + JSON.stringify([...configured, printer]));
  console.log('\nAdd these lines to your PRIVATE PrinterConfig.h, preserving Wi-Fi settings:');
  console.log(`#define FOODSYNC_PRINT_KEY "${key}"\n#define FOODSYNC_CLOUD_URL "${portal.origin}/api/v1/printer-device"\n#define FOODSYNC_CLOUD_DEVICE_ID "${id}"`);
  console.log('\nCheck existing paper tickets before activation. New paid orders after the activation time will print.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.$disconnect());
