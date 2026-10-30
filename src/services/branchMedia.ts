import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { UPLOAD_ROOT } from '../middleware/upload'
import { AppError } from '../middleware/error'

type Row = Record<string, unknown>
type Scope = { organizationId: string; branchId: string; syncHr?: boolean }
const kinds = ['Dish', 'Organization', 'Document', 'HrRecord', 'OrderReview'] as const
type Kind = typeof kinds[number]
const extensions = ['png', 'jpg', 'webp', 'pdf'] as const
const reference = z.string().regex(/^fsmedia:1:(Dish|Organization|Document|HrRecord|OrderReview):[a-f0-9]{64}:(png|jpg|webp|pdf):[1-9][0-9]{0,7}$/)
const CHUNK = 192 * 1024, MAX_FILE = 10 * 1024 * 1024
const failure = (message: string, code = 'MEDIA_INVALID', status = 409) => new AppError(message, status, code)
export function mediaReference(value: unknown) {
  if (typeof value !== 'string' || !value.startsWith('fsmedia:')) return null
  reference.parse(value)
  const [, , kind, digest, ext, length] = value.split(':')
  const size = Number(length)
  if (size > MAX_FILE || (['Dish', 'Organization', 'OrderReview'].includes(kind) && (ext === 'pdf' || size > 5 * 1024 * 1024))) throw failure('Media size or format is invalid')
  return { ref: value, kind: kind as Kind, digest, ext, size }
}
function segment(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw failure('Invalid media scope')
  return value
}
export function mediaPath(scope: Scope, ref: string) {
  const media = mediaReference(ref)
  if (!media) throw failure('A portable media reference is required')
  if (media.kind === 'HrRecord' && !scope.syncHr) throw failure('HR media is not authorized', 'BRANCH_FORBIDDEN', 403)
  return path.join(UPLOAD_ROOT, 'branch-media', segment(scope.organizationId), ['Dish', 'Organization'].includes(media.kind) ? 'shared' : segment(scope.branchId), media.kind, `${media.digest}.${media.ext}`)
}
// Check the real path too: a lexically safe path can still be a symlink into
// another installation or private key directory.
export async function checkedUpload(filename: string) {
  const root = await fs.realpath(UPLOAD_ROOT)
  const resolved = await fs.realpath(filename)
  if (!resolved.startsWith(root + path.sep) || !(await fs.stat(resolved)).isFile()) throw failure('Media source is outside uploads', 'MEDIA_SOURCE_INVALID')
  return resolved
}
function extension(bytes: Buffer): typeof extensions[number] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return 'pdf'
  throw failure('Media content must be PNG, JPEG, WEBP or PDF', 'MEDIA_TYPE_INVALID')
}
async function content(filename: string) {
  const resolved = await checkedUpload(filename), stat = await fs.stat(resolved)
  if (stat.size < 1 || stat.size > MAX_FILE) throw failure('Media file exceeds the transfer limit', 'MEDIA_TOO_LARGE', 413)
  return fs.readFile(resolved)
}
async function directory(destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  const root = await fs.realpath(UPLOAD_ROOT), actual = await fs.realpath(path.dirname(destination))
  if (!actual.startsWith(root + path.sep)) throw failure('Unsafe media destination')
}
async function verify(scope: Scope, ref: string) {
  const media = mediaReference(ref)!, bytes = await content(mediaPath(scope, ref))
  if (bytes.length !== media.size || createHash('sha256').update(bytes).digest('hex') !== media.digest || extension(bytes) !== media.ext) throw failure('Media integrity verification failed', 'MEDIA_INTEGRITY')
}
async function publish(scope: Scope, ref: string, bytes: Buffer) {
  const media = mediaReference(ref)!
  if (bytes.length !== media.size || createHash('sha256').update(bytes).digest('hex') !== media.digest || extension(bytes) !== media.ext) throw failure('Media integrity verification failed', 'MEDIA_INTEGRITY')
  const destination = mediaPath(scope, ref)
  await directory(destination)
  const temp = `${destination}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
    // Publish without replacing a concurrent writer's file.
    await fs.link(temp, destination).catch(async error => { if (error.code !== 'EEXIST') throw error; await verify(scope, ref) })
  } finally { await fs.unlink(temp).catch(() => undefined) }
}
function field(kind: Kind, row: Row): unknown {
  return kind === 'HrRecord' ? (row.data as Row | null)?.filePath : row[kind === 'Organization' ? 'logoPath' : kind === 'Document' ? 'filePath' : 'imagePath']
}
function setField(kind: Kind, row: Row, value: string | null) {
  if (kind === 'HrRecord') row.data = { ...(row.data as Row ?? {}), filePath: value }
  else row[kind === 'Organization' ? 'logoPath' : kind === 'Document' ? 'filePath' : 'imagePath'] = value
  if (kind === 'Organization') row.logoUrl = null
  if (kind === 'Document') row.storedFilename = value ? path.basename(value) : ''
}
export function isImmutableMedia(filename: string) {
  return path.resolve(filename).startsWith(path.join(UPLOAD_ROOT, 'branch-media') + path.sep)
}
export function mediaRows(tables: Record<string, Row[]>) {
  return kinds.flatMap(kind => (tables[kind] ?? []).filter(row => field(kind, row) != null && field(kind, row) !== '').map(row => ({ kind, row, value: String(field(kind, row)) })))
}
// Files become immutable before their digest is included in a checkpoint.
// Missing historical images are omitted; missing private attachments fail
// explicitly, so an acknowledged checkpoint cannot silently lose a document.
export async function prepareMedia(tables: Record<string, Row[]>, scope: Scope) {
  for (const { kind, row, value } of mediaRows(tables)) {
    if (mediaReference(value)) continue
    if (isImmutableMedia(value) || ['Document', 'HrRecord'].includes(kind)) {
      const base = isImmutableMedia(value)
        ? path.join(UPLOAD_ROOT, 'branch-media', segment(scope.organizationId), ['Dish', 'Organization'].includes(kind) ? 'shared' : segment(scope.branchId), kind)
        : path.join(UPLOAD_ROOT, ...(kind === 'HrRecord' ? ['hr', segment(scope.organizationId)] : [segment(scope.organizationId)]))
      if (!path.resolve(value).startsWith(base + path.sep) || !(await checkedUpload(value)).startsWith(await fs.realpath(base) + path.sep)) throw failure('Private attachment is outside its organization', 'MEDIA_SOURCE_INVALID')
    }
    let bytes: Buffer
    try { bytes = await content(value) } catch (error) {
      if (['Dish', 'Organization', 'OrderReview'].includes(kind) && (error as NodeJS.ErrnoException).code === 'ENOENT') { setField(kind, row, null); continue }
      throw failure('A referenced attachment cannot be read; repair it before synchronization', 'MEDIA_SOURCE_MISSING')
    }
    const ext = extension(bytes), digest = createHash('sha256').update(bytes).digest('hex'), ref = `fsmedia:1:${kind}:${digest}:${ext}:${bytes.length}`
    await publish(scope, ref, bytes)
    setField(kind, row, ref)
  }
}
// Host paths are never accepted from another machine. References can become
// database paths only after the complete local blob has been authenticated.
export async function hydrateMedia(tables: Record<string, Row[]>, scope: Scope) {
  for (const { kind, row, value } of mediaRows(tables)) {
    const media = mediaReference(value)
    if (!media || media.kind !== kind) throw failure('An incoming attachment requires a matching portable reference')
    await verify(scope, value).catch(() => { throw failure('Attachment transfer is incomplete; checkpoint was not applied', 'MEDIA_INCOMPLETE') })
    setField(kind, row, mediaPath(scope, value))
  }
}
export async function authorizeMedia(db: PrismaClient, token: string) {
  const node = await db.branchSyncNode.findFirst({ where: { tokenHash: createHash('sha256').update(token).digest('hex'), isActive: true, ownsWrites: true } })
  if (!node || !await db.branch.count({ where: { id: node.branchId, organizationId: node.organizationId, isActive: true, organization: { isActive: true } } })) throw failure('Invalid branch credentials', 'BRANCH_UNAUTHORIZED', 401)
  if (node.syncHr) {
    // Confidential media must stop immediately if the enrolling administrator
    // loses HR access, even before the next configuration refresh.
    const { getUserPermissions } = await import('../utils/permissions')
    const user = node.provisionedBy && await db.user.findFirst({ where: { id: node.provisionedBy, organizationId: node.organizationId, isActive: true } })
    const access = user && await getUserPermissions(db, user.id)
    if (!access || !access.permissions.has('can_view_hr') || !access.permissions.has('can_view_payroll')) node.syncHr = false
  }
  return node
}
export const mediaReadSchema = z.object({ kind: z.enum(kinds), id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), ref: reference, offset: z.number().int().min(0).max(MAX_FILE) }).strict()
export async function readBranchMedia(db: PrismaClient, token: string, input: unknown) {
  const data = mediaReadSchema.parse(input), node = await authorizeMedia(db, token)
  if (data.kind === 'HrRecord' && !node.syncHr) throw failure('HR media is not authorized', 'BRANCH_FORBIDDEN', 403)
  const delegate = db[data.kind[0].toLowerCase() + data.kind.slice(1) as keyof PrismaClient] as unknown as { findFirst: (args: unknown) => Promise<Row | null> }
  const row = await delegate.findFirst({ where: data.kind === 'Organization' ? { id: node.organizationId } : { id: data.id, organizationId: node.organizationId, ...(['Document', 'HrRecord', 'OrderReview'].includes(data.kind) && { branchId: node.branchId }) } })
  if (!row || data.kind === 'Organization' && data.id !== node.organizationId) throw failure('Media record not found', 'NOT_FOUND', 404)
  const tables = { [data.kind]: [{ ...row }] }
  await prepareMedia(tables, node)
  if (field(data.kind, tables[data.kind][0]) !== data.ref) throw failure('Media changed; request fresh configuration', 'MEDIA_CHANGED')
  const bytes = await content(mediaPath(node, data.ref))
  if (data.offset > bytes.length) throw failure('Invalid media offset')
  return { ref: data.ref, offset: data.offset, data: bytes.subarray(data.offset, data.offset + CHUNK).toString('base64'), complete: data.offset + CHUNK >= bytes.length }
}
export const mediaWriteSchema = z.object({ ref: reference, offset: z.number().int().min(0).max(MAX_FILE), data: z.string().max(Math.ceil(CHUNK / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict()
const locks = new Map<string, Promise<unknown>>()
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve(), current = before.catch(() => undefined).then(work)
  locks.set(key, current)
  try { return await current } finally { if (locks.get(key) === current) locks.delete(key) }
}
async function stage(scope: Scope, ref: string, offset: number, bytes: Buffer) {
  const media = mediaReference(ref)!, target = mediaPath(scope, ref)
  await directory(target)
  return exclusive(target, async () => {
    try { await verify(scope, ref); return { offset: media.size, complete: true } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const staging = target + '.part'
    let size = 0
    try { const stat = await fs.lstat(staging); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('Unsafe media staging file'); size = stat.size } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (offset !== size) return { offset: size, complete: false }
    if (offset + bytes.length > media.size) throw failure('Media exceeds declared size')
    if (!bytes.length) return { offset: size, complete: false }
    // Serialize the append and final promotion. A lost response simply asks
    // for the current offset; duplicate chunks never append twice.
    const handle = await fs.open(staging, size ? 'r+' : 'wx', 0o600)
    try { await handle.write(bytes, 0, bytes.length, size); await handle.sync() } finally { await handle.close() }
    size += bytes.length
    if (size === media.size) {
      try { await publish(scope, ref, await fs.readFile(staging)) } finally { await fs.unlink(staging).catch(() => undefined) }
    }
    return { offset: size, complete: size === media.size }
  })
}
export async function writeBranchMedia(db: PrismaClient, token: string, input: unknown) {
  const data = mediaWriteSchema.parse(input), node = await authorizeMedia(db, token), media = mediaReference(data.ref)!
  if (['Dish', 'Organization'].includes(media.kind)) throw failure('Catalog images are managed by the cloud', 'BRANCH_FORBIDDEN', 403)
  // Bound incomplete uploads per branch. Completed content is retained with
  // its business data/backups; it is never pruned by a staging cleanup.
  const dir = path.dirname(mediaPath(node, data.ref))
  await directory(path.join(dir, 'placeholder'))
  let partials = (await fs.readdir(dir)).filter(name => name.endsWith('.part'))
  for (const name of partials) {
    const file = path.join(dir, name), stat = await fs.lstat(file)
    if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 24 * 3600000 && !locks.has(file.slice(0, -5))) await fs.unlink(file)
  }
  partials = (await fs.readdir(dir)).filter(name => name.endsWith('.part'))
  if (partials.length >= 32 && !partials.includes(path.basename(mediaPath(node, data.ref)) + '.part')) throw failure('Too many unfinished attachments; retry existing transfers', 'MEDIA_BUSY', 429)
  const disk = await fs.statfs(dir)
  if (disk.bavail * disk.bsize < 1024 ** 3) throw failure('Media storage has less than 1 GB available', 'MEDIA_STORAGE_LOW', 507)
  return stage(node, data.ref, data.offset, Buffer.from(data.data, 'base64'))
}
export function mediaEndpoint(endpoint: string, token: string) {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw failure('Media synchronization requires HTTPS')
  return async (route: 'read' | 'write', body: unknown) => {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/media/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw failure(`Attachment synchronization failed (HTTP ${response.status})`, 'MEDIA_TRANSFER_FAILED')
    return z.object({ offset: z.number().int().min(0).max(MAX_FILE), complete: z.boolean(), ref: reference.optional(), data: z.string().max(Math.ceil(CHUNK / 3) * 4).optional() }).parse(await response.json())
  }
}
export async function pullPackageMedia(tables: Record<string, Row[]>, scope: Scope, endpoint: string, token: string) {
  if (!mediaRows(tables).length) return
  const call = mediaEndpoint(endpoint, token)
  for (const { kind, row, value } of mediaRows(tables)) {
    const media = mediaReference(value)
    if (!media || media.kind !== kind) throw failure('Invalid package media')
    try { await verify(scope, value); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let position = await stage(scope, value, 0, Buffer.alloc(0))
    while (!position.complete) {
      const result = await call('read', { kind, id: row.id, ref: value, offset: position.offset })
      if (result.ref !== value || result.offset !== position.offset || typeof result.data !== 'string') throw failure('Attachment acknowledgment does not match')
      const bytes = Buffer.from(result.data, 'base64')
      if (!bytes.length || bytes.length > CHUNK) throw failure('Invalid attachment chunk')
      position = await stage(scope, value, position.offset, bytes)
    }
  }
}
export async function pushReplicaMedia(tables: Record<string, Row[]>, scope: Scope, endpoint: string, token: string) {
  const call = mediaEndpoint(endpoint, token), sent = new Set<string>()
  for (const { value } of mediaRows(tables)) {
    if (sent.has(value)) continue
    sent.add(value)
    const media = mediaReference(value)
    if (!media) throw failure('Invalid outgoing media')
    const bytes = await content(mediaPath(scope, value))
    let result = await call('write', { ref: value, offset: 0, data: '' })
    while (!result.complete) {
      if (!Number.isInteger(result.offset) || result.offset < 0 || result.offset >= bytes.length) throw failure('Invalid media resume acknowledgment')
      result = await call('write', { ref: value, offset: result.offset, data: bytes.subarray(result.offset, result.offset + CHUNK).toString('base64') })
    }
    if (result.offset !== media.size) throw failure('Invalid attachment completion acknowledgment')
  }
}
