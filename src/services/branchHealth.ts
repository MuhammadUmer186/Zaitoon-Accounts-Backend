import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import path from 'path'
import { createHash } from 'crypto'
import { prisma } from '../config'

// Actionable alerts for a branch PC. Each alert names a condition someone must
// fix; "a timer fired" is never treated as success.
export type BranchAlert = { code: string; severity: 'warning' | 'critical'; message: string }
type Runtime = { lastSyncedAt: Date | null; lastReplicaAt: Date | null; dataRevision: bigint; lastReplicaRevision: bigint; replicaChainError: string | null; replicaError: string | null; configurationSyncedAt: Date | null; configurationError: string | null; writesFrozen?: string | null; handoverState?: string | null }
type BackupStatus = { lastSuccessAt?: string; healthy?: boolean; offsiteHealthy?: boolean | null; archive?: { healthy?: boolean } | null; capacity?: { backupLow?: boolean; systemLow?: boolean } | null; certificateExpiresAt?: string | null } | null
const MINUTE = 60000

export function evaluateBranchAlerts(input: { runtime: Runtime | null; outboxPending: number; backup: BackupStatus; cloudConfigured: boolean; now: number; zatcaOverdue?: number }): BranchAlert[] {
  const { runtime, backup, now } = input, alerts: BranchAlert[] = []
  const age = (value?: Date | string | null) => value ? now - new Date(value).getTime() : Infinity
  if (!runtime) return [{ code: 'BRANCH_NOT_PROVISIONED', severity: 'critical', message: 'This PC is not provisioned for a branch.' }]
  if (runtime.writesFrozen === 'released') return [{ code: 'BRANCH_HANDED_OVER', severity: 'critical', message: runtime.handoverState ?? 'This PC no longer records transactions for the branch.' }]
  if (runtime.handoverState) alerts.push({ code: 'HANDOVER_IN_PROGRESS', severity: 'warning', message: runtime.handoverState })
  if (input.cloudConfigured) {
    if (age(runtime.lastSyncedAt) > 30 * MINUTE) alerts.push({ code: 'CLOUD_UNREACHABLE', severity: 'warning', message: 'No confirmed contact with the cloud for over 30 minutes. Local trading continues.' })
    if (runtime.replicaChainError) alerts.push({ code: 'ERP_CHAIN_BROKEN', severity: 'critical', message: runtime.replicaChainError })
    else if (runtime.replicaError) alerts.push({ code: 'ERP_CHECKPOINT_REFUSED', severity: 'critical', message: runtime.replicaError })
    else if (runtime.dataRevision > runtime.lastReplicaRevision && age(runtime.lastReplicaAt) > 60 * MINUTE) alerts.push({ code: 'ERP_CHECKPOINT_STALE', severity: 'warning', message: 'Central reports have not received this branch\'s records for over an hour.' })
    if (input.outboxPending > 1000) alerts.push({ code: 'OUTBOX_BACKLOG', severity: 'warning', message: `${input.outboxPending} summary records are waiting to upload.` })
    if (runtime.configurationError || age(runtime.configurationSyncedAt) > 24 * 60 * MINUTE) alerts.push({ code: 'CONFIGURATION_STALE', severity: 'warning', message: 'Menu, staff and settings have not updated from the cloud in over a day.' })
  }
  // Simplified invoices must reach ZATCA within 24 hours of issue.
  if (input.zatcaOverdue) alerts.push({ code: 'ZATCA_REPORTING_OVERDUE', severity: 'critical', message: `${input.zatcaOverdue} e-invoice${input.zatcaOverdue === 1 ? ' has' : 's have'} not been accepted by ZATCA for over 6 hours (the limit is 24 hours). Check the internet connection and the e-invoicing page.` })
  if (!backup) alerts.push({ code: 'BACKUP_UNKNOWN', severity: 'critical', message: 'No backup status is available. Check the FoodSyncBackup service.' })
  else {
    if (!backup.healthy || age(backup.lastSuccessAt) > 45 * MINUTE) alerts.push({ code: 'BACKUP_STALE', severity: 'critical', message: 'No successful encrypted backup in the last 45 minutes.' })
    if (backup.archive && backup.archive.healthy === false) alerts.push({ code: 'WAL_ARCHIVE_FAILING', severity: 'critical', message: 'Continuous database archiving is failing; the system disk can fill. Check the backup disk.' })
    if (backup.capacity?.backupLow) alerts.push({ code: 'BACKUP_DISK_LOW', severity: 'critical', message: 'The backup disk is nearly full.' })
    if (backup.capacity?.systemLow) alerts.push({ code: 'SYSTEM_DISK_LOW', severity: 'critical', message: 'The PC system disk is nearly full.' })
    if (backup.offsiteHealthy === false) alerts.push({ code: 'OFFSITE_BACKUP_FAILING', severity: 'warning', message: 'The last off-site backup upload failed.' })
    if (backup.certificateExpiresAt && new Date(backup.certificateExpiresAt).getTime() - now < 14 * 24 * 60 * MINUTE) alerts.push({ code: 'CERTIFICATE_EXPIRING', severity: 'warning', message: `The local HTTPS certificate expires ${new Date(backup.certificateExpiresAt).toISOString().slice(0, 10)}.` })
  }
  return alerts
}

export async function readBackupStatus(): Promise<BackupStatus> {
  try { return JSON.parse(await readFile(path.join(process.env.BRANCH_STATUS_DIR || 'branch-status', 'backup.json'), 'utf8')) } catch { return null }
}
export async function currentBranchAlerts(now = Date.now()) {
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  const outboxPending = runtime ? await prisma.branchOutbox.count({ where: { nodeId: runtime.nodeId, acknowledgedAt: null } }) : 0
  const zatcaOverdue = await prisma.zatcaDocument.count({ where: { status: { in: ['pending', 'failed', 'rejected'] }, issuedAt: { lt: new Date(now - 6 * 60 * MINUTE) } } })
  return evaluateBranchAlerts({ runtime, outboxPending, backup: await readBackupStatus(), cloudConfigured: !!process.env.BRANCH_CLOUD_URL && !!process.env.BRANCH_SYNC_TOKEN, now, zatcaOverdue })
}
export const alertDigest = (alerts: { code: string }[]) => createHash('sha256').update(alerts.map(a => a.code).sort().join(',')).digest('hex')

// Windows Event Log entries let standard monitoring tools pick up a change.
let lastLogged = ''
function logToWindows(alerts: BranchAlert[]) {
  const digest = alertDigest(alerts)
  if (digest === lastLogged || process.platform !== 'win32') return
  lastLogged = digest
  const critical = alerts.some(a => a.severity === 'critical')
  const text = alerts.length ? `FoodSync branch alerts: ${alerts.map(a => a.code).join(', ')}` : 'FoodSync branch alerts cleared'
  execFile('eventcreate.exe', ['/L', 'APPLICATION', '/SO', 'FoodSync', '/T', critical ? 'ERROR' : alerts.length ? 'WARNING' : 'INFORMATION', '/ID', critical ? '901' : alerts.length ? '902' : '900', '/D', text], { windowsHide: true }, () => undefined)
}

// Branch PC: report alerts to the cloud (best effort) and the local event log.
export async function reportBranchHealth() {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return
  const alerts = await currentBranchAlerts()
  logToWindows(alerts)
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  if (!endpoint || !token) return alerts
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) return alerts
  await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/health`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ alerts }), redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => undefined)
  return alerts
}

// Cloud side --------------------------------------------------------------
type NodeHealth = { isActive: boolean; ownsWrites: boolean; lastSeenAt: Date | null; replicaError: string | null; healthReport: unknown; healthReportedAt: Date | null; walletRestoreDetectedAt?: Date | null; staleWalletHolds?: number }
// Reported alerts plus what only the cloud can observe (a PC gone silent).
export function cloudBranchAlerts(node: NodeHealth, now = Date.now()): BranchAlert[] {
  const alerts: BranchAlert[] = []
  // A revoked PC reports nothing, but customer money it left withheld still matters.
  if (!node.isActive && node.ownsWrites) alerts.push({ code: 'BRANCH_FENCED_WITHOUT_PC', severity: 'critical', message: 'This branch\'s PC credentials are revoked while it still owns the branch. A reviewed handover is required.' })
  else {
    const silentFor = node.lastSeenAt ? now - node.lastSeenAt.getTime() : Infinity
    if (silentFor > 10 * MINUTE) alerts.push({ code: 'PC_SILENT', severity: silentFor > 60 * MINUTE ? 'critical' : 'warning', message: node.lastSeenAt ? `No contact from the branch PC since ${node.lastSeenAt.toISOString()}.` : 'The branch PC has never connected.' })
    const reported = node.healthReportedAt && now - node.healthReportedAt.getTime() < 15 * MINUTE && Array.isArray((node.healthReport as { alerts?: unknown })?.alerts) ? (node.healthReport as { alerts: BranchAlert[] }).alerts : []
    alerts.push(...reported)
  }
  if (node.replicaError && !alerts.some(a => a.code === 'ERP_CHECKPOINT_REFUSED')) alerts.push({ code: 'ERP_CHECKPOINT_REFUSED', severity: 'critical', message: node.replicaError })
  if (node.staleWalletHolds) alerts.push({ code: 'WALLET_HOLDS_UNRESOLVED', severity: 'warning', message: `${node.staleWalletHolds} shared-balance hold${node.staleWalletHolds === 1 ? ' is' : 's are'} still withheld from customers after 15 minutes. If the PC cannot reconnect, review them on the Branch PC panel.` })
  if (node.walletRestoreDetectedAt) alerts.push({ code: 'WALLET_RESTORE_DETECTED', severity: 'critical', message: 'This PC was restored from an older backup. Shared-balance payments are paused until its wallet holds are reviewed on the Branch PC panel.' })
  return alerts
}

// Posts each change of a branch's alert set to ALERT_WEBHOOK_URL. Recorded as
// notified only after the receiver accepted it, so a failed post is retried.
export async function notifyBranchAlerts(now = Date.now()) {
  const target = process.env.ALERT_WEBHOOK_URL
  if (!target || process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch') return { sent: 0 }
  const nodes = await prisma.branchSyncNode.findMany({ where: { ownsWrites: true } })
  let sent = 0
  for (const node of nodes) {
    const staleWalletHolds = await prisma.branchWalletReservation.count({ where: { nodeId: node.id, state: 'reserved', createdAt: { lt: new Date(now - 15 * MINUTE) } } })
    const alerts = cloudBranchAlerts({ ...node, staleWalletHolds }, now), digest = alertDigest(alerts)
    if (digest === node.alertsNotified) continue
    const branch = await prisma.branch.findUnique({ where: { id: node.branchId }, select: { name: true } })
    const response = await fetch(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: 'foodsync.branch.alerts', organizationId: node.organizationId, branchId: node.branchId, branchName: branch?.name ?? null, cleared: alerts.length === 0, alerts, at: new Date(now).toISOString() }), redirect: 'error', signal: AbortSignal.timeout(10000) }).catch(() => null)
    if (response?.ok) { await prisma.branchSyncNode.update({ where: { id: node.id }, data: { alertsNotified: digest } }); sent++ }
  }
  return { sent }
}
