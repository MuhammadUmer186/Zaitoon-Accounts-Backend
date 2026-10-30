import { z } from 'zod'
import { createHash } from 'crypto'
import { isIP } from 'net'
import { Request, Response } from 'express'
import { prisma } from '../config'
import { walletNode } from './branchWallets'
import { getUserPermissions } from '../utils/permissions'
import { assertBranchAccess } from '../utils/branchScope'
import { signBranchRelayToken } from '../utils/jwt'
import { parseVoucher } from '../utils/freeDish'
import { AppError } from '../middleware/error'

const publicPath = /^\/(?:qr\/[a-f0-9]{64}(?:\/submit|\/logo)?|voucher\/FD-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}(?:\/logo)?)$/
const routes = z.enum(['/sections', '/items', '/qr-codes', '/submissions', '/verify', '/redeem'])
const querySchema = z.record(z.string().regex(/^(branchId|qrId|search|status|from|to|page|pageSize|format)$/), z.string().max(200))
// Reuse the ordinary route and its validation, permission gates, reports and
// atomic redemption. The short-lived, server-only capability cannot call any
// other module and is additionally scoped to this node's branch.
export async function cloudFreeDish(token: string, input: unknown, port: number, publicRequest = false) {
  const data = z.object({ actorId: z.string().min(1).optional(), path: z.string().max(150), method: z.enum(['GET', 'POST']), query: querySchema.default({}), body: z.unknown().optional(), clientIp: z.string().max(64).optional() }).strict().parse(input)
  const node = await prisma.$transaction(tx => walletNode(tx, token))
  let accessToken: string | null = null
  if (!publicRequest) {
    const route = routes.parse(data.path)
    if (data.method !== (['/verify', '/redeem'].includes(route) ? 'POST' : 'GET') || !data.actorId) throw new AppError('Unsupported Free Dish relay', 400, 'RELAY_INVALID')
    const user = await prisma.user.findFirst({ where: { id: data.actorId, organizationId: node.organizationId, isActive: true } })
    const access = user && await getUserPermissions(prisma, user.id)
    const required = ['/verify', '/redeem'].includes(route) ? ['free_dish_redeem'] : route === '/sections' ? ['free_dish_manage', 'free_dish_redeem'] : ['free_dish_manage']
    if (!user || !access || !required.some(key => access.permissions.has(key))) throw new AppError('Current cloud Free Dish permission is required', 403, 'FORBIDDEN')
    await assertBranchAccess({ user: { id: user.id, organizationId: node.organizationId } } as Request, node.branchId)
    if (data.method === 'POST') {
      const body = z.object({ input: z.string().trim().min(1).max(500) }).strict().parse(data.body)
      const voucher = await prisma.freeDishSubmission.findFirst({ where: { voucherCode: parseVoucher(body.input), organizationId: node.organizationId, branchId: node.branchId }, select: { id: true } })
      if (!voucher) throw new AppError('Voucher not found at this branch', 404, 'NOT_FOUND')
    }
    if (data.query.branchId && data.query.branchId !== node.branchId) throw new AppError('Voucher relay is limited to this branch', 403, 'BRANCH_FORBIDDEN')
    data.query.branchId = node.branchId
    accessToken = signBranchRelayToken(user.id, node.organizationId, user.email, node.branchId)
  } else {
    if (!publicPath.test(data.path) || data.method !== (data.path.endsWith('/submit') ? 'POST' : 'GET') || Object.keys(data.query).length) throw new AppError('Unsupported public Free Dish relay', 400, 'RELAY_INVALID')
    const [, resource, key] = data.path.split('/')
    const record = resource === 'qr'
      ? await prisma.freeDishQr.findFirst({ where: { publicToken: key, organizationId: node.organizationId, branchId: node.branchId }, select: { id: true } })
      : await prisma.freeDishSubmission.findFirst({ where: { voucherCode: key, organizationId: node.organizationId, branchId: node.branchId }, select: { id: true } })
    if (!record) throw new AppError('Offer or voucher not found at this branch', 404, 'NOT_FOUND')
    if (!data.clientIp || !isIP(data.clientIp)) throw new AppError('Client address required for public relay', 400, 'RELAY_INVALID')
  }
  // Public limits are per guest. Every relayed call reaches the public route
  // from loopback, so the guest is identified explicitly: a private IPv6
  // address derived from this PC and its client, so identical LAN addresses
  // at different branches never share a bucket.
  const guest = publicRequest ? 'fd' + createHash('sha256').update(`${node.id}|${data.clientIp}`).digest('hex').slice(0, 30) : null
  const forwardedFor = guest ? guest.match(/.{4}/g)!.join(':') : null
  const url = new URL(`http://127.0.0.1:${port}/api/v1/${publicRequest ? 'public/' : ''}free-dish${data.path}`)
  for (const [key, value] of Object.entries(data.query)) url.searchParams.set(key, value)
  const result = await fetch(url, { method: data.method, headers: { ...(accessToken && { Authorization: `Bearer ${accessToken}` }), ...(forwardedFor && { 'X-Forwarded-For': forwardedFor }), 'Content-Type': 'application/json' }, ...(data.method === 'POST' && { body: JSON.stringify(data.body) }), signal: AbortSignal.timeout(15000), redirect: 'error' })
  const bytes = Buffer.from(await result.arrayBuffer())
  if (bytes.length > 10 * 1024 * 1024) throw new AppError('Free Dish export exceeds relay size limit', 413, 'RELAY_TOO_LARGE')
  return { status: result.status, type: result.headers.get('content-type') ?? 'application/json', body: bytes.toString('base64') }
}
export async function branchFreeDish(req: Request, res: Response, publicRequest: boolean) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch') return false
  const endpoint = process.env.BRANCH_CLOUD_URL, token = process.env.BRANCH_SYNC_TOKEN
  const offline = () => new AppError('Free Dish needs a connection to the cloud to confirm registration or collection. No offline redemption is recorded.', 503, 'FREE_DISH_OFFLINE')
  if (!endpoint || !token || new URL(endpoint).protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && new URL(endpoint).hostname === '127.0.0.1')) throw offline()
  if (!publicRequest && !['GET'].includes(req.method) && !['/verify', '/redeem'].includes(req.path)) throw new AppError('Manage Free Dish offers and items in the cloud', 409, 'CENTRALLY_MANAGED_CONFIGURATION')
  const runtime = await prisma.branchRuntime.findUnique({ where: { id: 'local' } })
  if (!runtime || runtime.writesFrozen || runtime.replicaChainError) throw new AppError('Resolve branch ownership before operating vouchers', 409, 'BRANCH_RECOVERY_REQUIRED')
  let response: globalThis.Response
  try { response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/branch-sync/free-dish${publicRequest ? '/public' : ''}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(!publicRequest && { actorId: req.user.id }), ...(publicRequest && { clientIp: req.ip }), path: req.path, method: req.method, query: req.query, body: req.body }), signal: AbortSignal.timeout(20000), redirect: 'error' }) } catch (error) {
    // Never sent: nothing happened centrally. Possibly sent (timeout, dropped
    // reply): a collection may have been recorded, so staff must verify
    // before handing anything out.
    const cause = String((error as { cause?: { code?: string } })?.cause?.code ?? '')
    if (req.method === 'POST' && req.path === '/redeem' && !['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'].includes(cause)) throw new AppError('Collection could not be confirmed. Do not hand out the dish yet: verify the voucher again.', 503, 'FREE_DISH_UNCONFIRMED')
    throw offline()
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string; code?: string } | null
    throw new AppError(error?.message ?? 'Central voucher operation was refused', response.status, error?.code ?? 'RELAY_REFUSED')
  }
  const result = z.object({ status: z.number().int().min(200).max(499), type: z.string().max(200), body: z.string().max(14 * 1024 * 1024) }).parse(await response.json())
  res.setHeader('Cache-Control', 'no-store')
  res.status(result.status).type(result.type).send(Buffer.from(result.body, 'base64'))
  return true
}
