import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requireAnyPermission, requirePermission } from '../middleware/authorize'
import { getUserPermissions } from '../utils/permissions'
import { AppError } from '../middleware/error'
import { assertBranchAccess, branchFilter } from '../utils/branchScope'
import { logAudit } from '../utils/audit'
import { readKitchenPrinters } from '../services/kitchenPrinting'
import { readCloudKitchenPrinters } from '../services/cloudKitchenPrinting'
import { agentAckSchema, agentPollSchema, ackNetworkAgent, assertNoPrinterInFlight, assertPrinterOwner, authenticateNetworkAgent, networkPrinterSchema, localDispatchStatus, newAgentToken, pollNetworkAgent, printerPublic, queuePrinterTest, takeOverLocalDispatch, takeOverSchema } from '../services/networkKitchenPrinting'

export const networkAgentRouter = Router()
networkAgentRouter.post('/:id/poll', async (req, res) => {
  const printer = await authenticateNetworkAgent(req.params.id, req.get('authorization'))
  const { instanceId } = agentPollSchema.parse(req.body)
  const job = await pollNetworkAgent(printer, instanceId)
  if (!job) { res.status(204).end(); return }
  res.json(job)
})
networkAgentRouter.post('/:id/ack', async (req, res) => {
  const printer = await authenticateNetworkAgent(req.params.id, req.get('authorization'))
  res.json(await ackNetworkAgent(printer, agentAckSchema.parse(req.body)))
})

const router = Router()
router.use(authenticate)
// Cashiers can read their branch's enabled native routes and dispatch its durable
// kitchen queue. Printer administration remains restricted to Settings access.
// "ipad" is the stored value of the cashier-device connection: the iPad app or
// the Windows PC print bridge, which share one bridge contract.
const cashierAccess = requireAnyPermission('can_manage_orders', 'can_take_orders', 'can_manage_kitchen', 'can_manage_settings')
router.get('/local/status', cashierAccess, async (req, res) => {
  const { branchId, instanceId } = z.object({ branchId: z.string().min(1), instanceId: z.string().uuid().optional() }).parse(req.query)
  await assertBranchAccess(req, branchId)
  res.json({ printers: await localDispatchStatus(req.user.organizationId, branchId, instanceId) })
})
router.post('/local/take-over', cashierAccess, async (req, res) => {
  const body = takeOverSchema.parse(req.body)
  await assertBranchAccess(req, body.branchId)
  const { permissions } = await getUserPermissions(prisma, req.user.id)
  res.json(await takeOverLocalDispatch(req.user.organizationId, body, permissions.has('can_manage_settings'), async (db, previous) => {
    await logAudit(db, { req, action: 'take_over_print_dispatch', module: 'kitchen', branchId: body.branchId, resourceType: 'network_printer', resourceId: body.branchId, oldData: { previous }, newData: { instanceId: body.instanceId, label: body.label } })
  }))
})
router.get('/ipad/connections', cashierAccess, async (req, res) => {
  const branch = await branchFilter(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined)
  const rows = await prisma.networkKitchenPrinter.findMany({ where: { organizationId: req.user.organizationId, enabled: true, deliveryMode: 'ipad', ...(branch && { branchId: branch }) } })
  res.json({ printers: rows.map(p => ({ id: p.id, branchId: p.branchId, stationId: p.stationId, name: p.name, host: p.host, port: p.port, paperWidth: p.paperWidth })) })
})
async function nativePrinter(req: import('express').Request) {
  const p = await findPrinter(req)
  if (!p.enabled || p.deliveryMode !== 'ipad') throw new AppError('This printer is not enabled for local iPad printing', 409, 'PRINTER_MODE')
  await assertPrinterOwner(p)
  return p
}
router.post('/ipad/:id/claim', cashierAccess, async (req, res) => {
  const p = await nativePrinter(req)
  const job = await pollNetworkAgent(p, agentPollSchema.parse(req.body).instanceId)
  if (!job) { res.status(204).end(); return }
  res.json(job)
})
router.post('/ipad/:id/ack', cashierAccess, async (req, res) => {
  res.json(await ackNetworkAgent(await nativePrinter(req), agentAckSchema.parse(req.body)))
})
router.use(requirePermission('can_manage_settings'))
router.post('/:id/release-ipad', async (req, res) => {
  const p = await findPrinter(req)
  if (p.deliveryMode !== 'ipad') throw new AppError('This printer does not use the cashier-device connection', 409, 'PRINTER_MODE')
  await prisma.$transaction(async db => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
    await assertNoPrinterInFlight(db, p.id)
    await db.networkKitchenPrinter.update({ where: { id: p.id }, data: { agentInstanceId: null, dispatcherLabel: null, lastSeenAt: null } })
    await logAudit(db, { req, action: 'release_ipad', module: 'kitchen', branchId: p.branchId, resourceType: 'network_printer', resourceId: p.id })
  })
  res.json({ released: true })
})
router.get('/', async (req, res) => {
  const branch = await branchFilter(req, typeof req.query.branchId === 'string' ? req.query.branchId : undefined)
  const printers = await prisma.networkKitchenPrinter.findMany({ where: { organizationId: req.user.organizationId, ...(branch && { branchId: branch }) }, orderBy: { name: 'asc' } })
  await prisma.kitchenPrintJob.updateMany({ where: { organizationId: req.user.organizationId, printerId: { in: printers.map(p => p.id) }, state: 'sending', updatedAt: { lt: new Date(Date.now() - 60000) } }, data: { state: 'uncertain', lastError: 'Print connection interrupted; check paper output and review this job in Kitchen' } })
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  const stations = await prisma.kitchenStation.findMany({ where: { organizationId: req.user.organizationId, isActive: true }, select: { id: true, name: true } })
  const jobs = await prisma.kitchenPrintJob.findMany({ where: { organizationId: req.user.organizationId, printerId: { in: printers.map(p => p.id) } }, orderBy: { sequence: 'desc' }, take: 100, select: { id: true, printerId: true, kind: true, state: true, lastError: true, createdAt: true } })
  res.json({ printers: printers.map(printerPublic), stations, jobs, deliveryMode: runtime || process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch' ? 'branch' : 'agent' })
})
async function findPrinter(req: import('express').Request) {
  const p = await prisma.networkKitchenPrinter.findFirst({ where: { id: req.params.id, organizationId: req.user.organizationId } })
  if (!p) throw new AppError('Printer not found', 404, 'NOT_FOUND')
  await assertBranchAccess(req, p.branchId)
  return p
}
async function save(req: import('express').Request, id?: string) {
  const body = networkPrinterSchema.parse(req.body)
  await assertBranchAccess(req, body.branchId)
  if (id) {
    const old = await findPrinter(req)
    if (old.branchId !== body.branchId) throw new AppError('Create a separate printer when moving branches', 400, 'VALIDATION_ERROR')
  }
  if (!await prisma.branch.count({ where: { id: body.branchId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (!['none', 'cashier'].includes(body.stationId) && !await prisma.kitchenStation.count({ where: { id: body.stationId, organizationId: req.user.organizationId, isActive: true } })) throw new AppError('Kitchen station not found', 404, 'NOT_FOUND')
  if (body.stationId === 'cashier' && body.deliveryMode !== 'ipad') throw new AppError('Cashier receipts print from the cashier device: choose the iPad app / PC print bridge connection', 400, 'PRINTER_MODE')
  const printerId = id ?? `net-${randomUUID()}`
  let legacyIds: string[] = []
  if (body.enabled) {
    // A Settings route replaces its legacy station without dropping queued
    // slips or losing dispatch history needed for later cancellation slips.
    let legacy: { id: string; organizationId: string; branchId: string; stationId: string }[] = []
    try { legacy.push(...readKitchenPrinters()) } catch { /* malformed legacy routes cannot dispatch */ }
    try { legacy.push(...readCloudKitchenPrinters()) } catch { /* managed settings remain usable */ }
    legacyIds = [...new Set(legacy.filter(p => p.organizationId === req.user.organizationId && p.branchId === body.branchId && p.stationId === body.stationId && p.id !== printerId).map(p => p.id))].sort()
  }
  return prisma.$transaction(async db => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${body.branchId}`}))`
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${req.user.organizationId}:${body.branchId}:${printerId}`}))`
    if (body.enabled) await assertPrinterOwner({ ...body, organizationId: req.user.organizationId }, db)
    for (const legacyId of legacyIds) {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-enqueue:${req.user.organizationId}:${body.branchId}:${legacyId}`}))`
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${req.user.organizationId}:${body.branchId}:${legacyId}`}))`
      await assertNoPrinterInFlight(db, legacyId)
    }
    const previous = id ? await db.networkKitchenPrinter.findUniqueOrThrow({ where: { id } }) : null
    if (previous) await assertNoPrinterInFlight(db, printerId)
    if (previous && previous.stationId !== body.stationId && await db.kitchenPrintJob.count({ where: { printerId, state: { in: ['queued', 'blocked'] } } })) throw new AppError('Finish or discard pending slips before changing printer role or station', 409, 'PRINT_IN_PROGRESS')
    const connectionChanged = previous && previous.deliveryMode !== body.deliveryMode
    if (connectionChanged && previous.deliveryMode === 'ipad' && await db.kitchenPrintJob.count({ where: { printerId, state: { in: ['queued', 'blocked'] } } })) throw new AppError('Finish or discard pending cashier-device slips before changing the print connection', 409, 'PRINT_IN_PROGRESS')
    // A new cashier-device printer joins the branch's current dispatcher, so
    // one device keeps serving every station after hardware is added.
    const unbound = body.deliveryMode === 'ipad' && (!previous || connectionChanged || !previous.agentInstanceId)
    const dispatcher = unbound ? await db.networkKitchenPrinter.findFirst({ where: { organizationId: req.user.organizationId, branchId: body.branchId, deliveryMode: 'ipad', enabled: true, agentInstanceId: { not: null }, id: { not: printerId } }, orderBy: { lastSeenAt: 'desc' } }) : null
    const binding = dispatcher ? { agentInstanceId: dispatcher.agentInstanceId, dispatcherLabel: dispatcher.dispatcherLabel, lastSeenAt: dispatcher.lastSeenAt } : connectionChanged ? { agentInstanceId: null, dispatcherLabel: null, lastSeenAt: null } : {}
    const p = await db.networkKitchenPrinter.upsert({ where: { id: printerId }, create: { id: printerId, organizationId: req.user.organizationId, ...body, ...binding }, update: { ...body, ...(!previous?.enabled && body.enabled && { enabledAt: new Date() }), ...(connectionChanged && { agentTokenHash: null }), ...binding } })
    if (legacyIds.length) await db.kitchenPrintJob.updateMany({ where: { organizationId: req.user.organizationId, branchId: body.branchId, printerId: { in: legacyIds } }, data: { printerId } })
    await logAudit(db, { req, action: id ? 'update' : 'create', module: 'kitchen', branchId: body.branchId, resourceType: 'network_printer', resourceId: p.id, newData: body })
    return printerPublic(p)
  })
}
router.post('/', async (req, res) => { res.status(201).json(await save(req)) })
router.put('/:id', async (req, res) => { res.json(await save(req, req.params.id)) })
router.post('/:id/test', async (req, res) => {
  const p = await findPrinter(req)
  const job = await queuePrinterTest(p)
  await logAudit(prisma, { req, action: 'test_print', module: 'kitchen', branchId: p.branchId, resourceType: 'network_printer', resourceId: p.id })
  res.status(202).json({ jobId: job.id, state: job.state })
})
// The PC bridge holds no credential: the cashier's signed-in browser claims and
// acknowledges jobs, and the bridge only trusts this portal's origin.
router.post('/pc-bridge-package', async (req, res) => {
  const { portalOrigin } = z.object({ portalOrigin: z.string().url().refine(s => { const u = new URL(s); return u.origin === s.replace(/\/+$/, '') && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) }, 'Use the HTTPS address of the FoodSync portal') }).strict().parse(req.body)
  const scriptDir = path.resolve(__dirname, '../../scripts')
  const zip = new JSZip()
  zip.file('bridge.cjs', fs.readFileSync(path.join(scriptDir, 'local-print-bridge.cjs')))
  zip.file('Install-PrintBridge.ps1', fs.readFileSync(path.join(scriptDir, 'Install-PrintBridge.ps1')))
  zip.file('Uninstall-PrintBridge.ps1', fs.readFileSync(path.join(scriptDir, 'Uninstall-PrintBridge.ps1')))
  zip.file('Install-PrintBridge.cmd', '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-PrintBridge.ps1"\r\npause\r\n')
  zip.file('Uninstall-PrintBridge.cmd', '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-PrintBridge.ps1"\r\npause\r\n')
  zip.file('Run-PrintBridge.cmd', '@echo off\r\nnode "%~dp0bridge.cjs" "%~dp0config.json"\r\npause\r\n')
  zip.file('config.json', JSON.stringify({ allowedOrigins: [portalOrigin.replace(/\/+$/, '')], port: 9147 }, null, 2))
  zip.file('README.txt', [
    'FoodSync PC print bridge',
    'Lets this Windows PC print cashier receipts and kitchen slips straight to LAN ESC/POS printers (TCP 9100) from FoodSync in Edge or Chrome.',
    '',
    '1. Install Node.js 20 LTS or later (nodejs.org).',
    '2. Extract this folder somewhere permanent, e.g. C:\\FoodSync\\PrintBridge.',
    '3. Double-click Install-PrintBridge.cmd as the Windows user who operates the till. No administrator rights are needed.',
    '4. Open FoodSync, Settings > Printers. If the browser asks to allow access to devices or apps on your local network, choose Allow.',
    '5. Use "Test from this device" on each printer.',
    '',
    `Only ${portalOrigin.replace(/\/+$/, '')} can use this bridge. It listens on 127.0.0.1:9147 and opens no router or firewall ports.`,
    'journal.json prevents repeated slips. Do not delete it while a print is held for review.',
    'Run-PrintBridge.cmd runs the bridge in a window to show errors. Uninstall-PrintBridge.cmd removes it from sign-in.',
  ].join('\r\n') + '\r\n')
  const archive = await zip.generateAsync({ type: 'nodebuffer' })
  await logAudit(prisma, { req, action: 'download_pc_bridge', module: 'kitchen', resourceType: 'network_printer', resourceId: 'pc-bridge', newData: { portalOrigin } })
  res.setHeader('Content-Disposition', 'attachment; filename="foodsync-print-bridge.zip"')
  res.type('application/zip').send(archive)
})
router.post('/:id/agent-package', async (req, res) => {
  const p = await findPrinter(req)
  const { serverUrl } = z.object({ serverUrl: z.string().url().refine(s => { const u = new URL(s); return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) }, 'Use the public HTTPS API URL') }).strict().parse(req.body)
  if (p.deliveryMode !== 'agent') throw new AppError('Branch PCs print directly; an agent is not needed', 409, 'PRINTER_MODE')
  await assertPrinterOwner(p)
  // Read the complete bundle before rotating any credentials.
  const scriptDir = path.resolve(__dirname, '../../scripts')
  const zip = new JSZip()
  zip.file('agent.cjs', fs.readFileSync(path.join(scriptDir, 'print-agent.cjs')))
  zip.file('rawPrinter.js', fs.readFileSync(path.resolve(__dirname, '../../dist/services/rawPrinter.js')))
  zip.file('Install-PrintAgent.ps1', fs.readFileSync(path.join(scriptDir, 'Install-PrintAgent.ps1')))
  zip.file('Install-PrintAgent.cmd', '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-PrintAgent.ps1"\r\nif errorlevel 1 pause\r\n')
  zip.file('Run-PrintAgent.ps1', '$ErrorActionPreference = "Stop"\nSet-Location -LiteralPath $PSScriptRoot\n& node (Join-Path $PSScriptRoot "agent.cjs") (Join-Path $PSScriptRoot "config.json")\n')
  const credential = newAgentToken()
  zip.file('config.json', JSON.stringify({ serverUrl: serverUrl.replace(/\/+$/, ''), printerId: p.id, token: credential.token }, null, 2))
  zip.file('README.txt', 'FoodSync local print agent\r\nRequires Node.js 20 or later. Extract into a permanent folder on ONE always-on restaurant PC.\r\nRun: node agent.cjs config.json\r\nFor Windows automatic startup, run Install-PrintAgent.cmd as the Windows user who operates this PC.\r\nKeep config.json private. Pairing another package revokes this one.\r\nThe PC must reach the printer IP and public HTTPS FoodSync API. No inbound router ports are needed.\r\nDo not run two copies or delete journal.json during a print attempt.\r\nPrinter IP changes are made in FoodSync Settings; the agent reads them automatically.\r\n')
  const archive = await zip.generateAsync({ type: 'nodebuffer' })
  await prisma.$transaction(async db => {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`print-deliver:${p.organizationId}:${p.branchId}:${p.id}`}))`
    await assertNoPrinterInFlight(db, p.id)
    await db.networkKitchenPrinter.update({ where: { id: p.id }, data: { agentTokenHash: credential.hash, agentInstanceId: null, lastSeenAt: null } })
    await logAudit(db, { req, action: 'pair_agent', module: 'kitchen', branchId: p.branchId, resourceType: 'network_printer', resourceId: p.id })
  })
  res.setHeader('Content-Disposition', `attachment; filename="foodsync-print-agent-${p.id}.zip"`)
  res.type('application/zip').send(archive)
})
export default router
