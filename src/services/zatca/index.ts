import crypto from 'node:crypto'
import { Prisma, ZatcaDocument } from '@prisma/client'
import { prisma } from '../../config'
import { AppError } from '../../middleware/error'
import { zonedParts } from '../../utils/reportFormat'
import { isValidTimezone } from '../../utils/menu'
import { zatcaApi, ZatcaResponse } from './api'
import {
  ZatcaEnvironment, generateKeyPair, createCsr, certificateBody, certificateInfo, seal, unseal, FIRST_PREVIOUS_HASH,
} from './crypto'
import { signInvoice, DocumentType, PAYMENT_MEANS, Seller, InvoiceInput } from './invoice'

// ZATCA (Saudi e-invoicing, Fatoora phase 2) for the POS:
//   onboarding  — per branch: key pair → CSR → compliance CSID (OTP from the
//                 Fatoora portal) → compliance checks (simplified invoice,
//                 credit note, debit note) → production CSID
//   issuing     — every paid order gets a signed simplified tax invoice with
//                 QR; a refund gets a credit note referencing it. Documents of
//                 one device are numbered (ICV) and hash-chained (PIH) inside
//                 a row lock, so the chain can never fork.
//   reporting   — documents are reported to ZATCA from a queue with retries
//                 (B2C documents must be reported within 24 hours).

type Tx = Prisma.TransactionClient

export const VAT_NUMBER = /^3\d{13}3$/

export interface OnboardInput {
  organizationId: string
  branchId: string
  counterCode?: string
  environment: ZatcaEnvironment
  otp: string
  street: string
  building: string
  district: string
  city: string
  postalCode: string
  industry?: string
}

interface LogStep { step: string; ok: boolean; at: string; detail?: string }

const issues = (r: ZatcaResponse) => {
  const v = (r.data?.validationResults ?? {}) as { errorMessages?: { code: string; message: string }[]; warningMessages?: { code: string; message: string }[] }
  return [...(v.errorMessages ?? []), ...(v.warningMessages ?? [])].map((m) => `${m.code}: ${m.message}`).join(' · ') || (r.data?.message as string) || r.text.slice(0, 300)
}

async function sellerFor(organizationId: string, device: { street: string; building: string; district: string; city: string; postalCode: string }): Promise<Seller> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, vatNumber: true, crNumber: true } })
  if (!org.vatNumber || !VAT_NUMBER.test(org.vatNumber)) throw new AppError('Set the 15-digit VAT registration number (starts and ends with 3) in Settings → Organization first', 400, 'ZATCA_SETUP')
  if (!org.crNumber) throw new AppError('Set the commercial registration (CR) number first', 400, 'ZATCA_SETUP')
  return { name: org.name, vatNumber: org.vatNumber, crn: org.crNumber, ...device }
}

// KSA local date/time of a moment, in the organization's zone
function issuedAtFor(when: Date, timezone: string) {
  const p = zonedParts(when, isValidTimezone(timezone) ? timezone : 'Asia/Riyadh')
  const pad = (n: number) => String(n).padStart(2, '0')
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.hh)}:${pad(p.mm)}:${pad(when.getUTCSeconds())}` }
}

export async function onboardDevice(input: OnboardInput) {
  const branch = await prisma.branch.findFirst({ where: { id: input.branchId, organizationId: input.organizationId }, select: { id: true, name: true, code: true, vatRate: true } })
  if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')
  if (!(branch.vatRate > 0)) throw new AppError('Set the branch VAT rate (15%) before onboarding', 400, 'ZATCA_SETUP')
  for (const [k, re, label] of [['building', /^\d{4}$/, 'Building number must be 4 digits'], ['postalCode', /^\d{5}$/, 'Postal code must be 5 digits']] as const) {
    if (!re.test(String(input[k]))) throw new AppError(label, 400, 'VALIDATION_ERROR')
  }
  const address = { street: input.street.trim(), building: input.building, district: input.district.trim(), city: input.city.trim(), postalCode: input.postalCode }
  const seller = await sellerFor(input.organizationId, address)
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: input.organizationId }, select: { timezone: true } })

  const log: LogStep[] = []
  const step = (name: string, ok: boolean, detail?: string) => log.push({ step: name, ok, at: new Date().toISOString(), detail })
  const keys = generateKeyPair()
  const egsSerial = `1-FoodSync|2-POS|3-${crypto.randomUUID()}`
  const counterCode = input.counterCode ?? 'main'
  const commonName = `FoodSync-${branch.code}-${counterCode}`
  const csr = createCsr({
    environment: input.environment, commonName, organizationUnit: branch.name, organizationName: seller.name, vatNumber: seller.vatNumber,
    egsSerial, invoiceTypes: '0100', location: `${address.building} ${address.street}, ${address.district}, ${address.city}`, industry: input.industry || 'Restaurant',
  }, keys)
  step('Key pair and certificate request created', true)

  const base = {
    organizationId: input.organizationId, environment: input.environment, status: 'onboarding', egsSerial, commonName, ...address,
    industry: input.industry || 'Restaurant', csr, privateKeySealed: seal(keys.privateKeyPem), icv: 0, lastInvoiceHash: null,
    complianceToken: null, complianceSecretSealed: null, complianceRequestId: null, productionToken: null, productionSecretSealed: null, lastError: null,
  }
  const existing = await prisma.zatcaDevice.findUnique({ where: { branchId_counterCode: { branchId: branch.id, counterCode } } })
  if (existing && (await prisma.zatcaDocument.count({ where: { deviceId: existing.id } })) > 0 && existing.environment === 'production') {
    throw new AppError('This counter already issues production invoices — renew the certificate instead of onboarding again', 409, 'ZATCA_ACTIVE')
  }
  let device = existing
    ? await prisma.zatcaDevice.update({ where: { id: existing.id }, data: { ...base, onboardingLog: log as unknown as Prisma.InputJsonValue } })
    : await prisma.zatcaDevice.create({ data: { ...base, branchId: branch.id, counterCode, onboardingLog: log as unknown as Prisma.InputJsonValue } })
  const fail = async (msg: string) => {
    step('Stopped', false, msg)
    await prisma.zatcaDevice.update({ where: { id: device.id }, data: { status: 'failed', lastError: msg, onboardingLog: log as unknown as Prisma.InputJsonValue } })
    throw new AppError(`ZATCA onboarding failed: ${msg}`, 400, 'ZATCA_ONBOARDING')
  }

  // 1. compliance CSID
  const cc = await zatcaApi.complianceCsid(input.environment, csr, input.otp.trim())
  if (!cc.ok || !cc.data?.binarySecurityToken) await fail(`compliance certificate refused (${cc.status}) — ${issues(cc)}`)
  const complianceToken = String(cc.data!.binarySecurityToken)
  const complianceSecret = String(cc.data!.secret)
  step('Compliance certificate issued', true)

  // 2. compliance checks: one of each simplified document
  const cert = certificateInfo(certificateBody(complianceToken))
  let previousHash = FIRST_PREVIOUS_HASH
  const issuedAt = issuedAtFor(new Date(), org.timezone)
  for (const [i, type] of (['invoice', 'credit', 'debit'] as DocumentType[]).entries()) {
    const uuid = crypto.randomUUID()
    const doc = signInvoice({
      type, invoiceNo: `COMPLIANCE-${i + 1}`, uuid, icv: i + 1, previousHash, issuedAt, seller,
      lines: [{ name: 'Compliance check item', quantity: 1, unitPriceInclusive: 11.5 }], discountInclusive: 0, vatRate: branch.vatRate,
      paymentMeans: '10', ...(type !== 'invoice' && { billingReference: 'COMPLIANCE-1', reason: 'Compliance check' }),
    }, cert, keys.privateKeyPem)
    const res = await zatcaApi.complianceInvoice(input.environment, complianceToken, complianceSecret, { hash: doc.hash, uuid, xml: doc.xml })
    const status = (res.data?.validationResults as { status?: string } | undefined)?.status
    if (!res.ok || status === 'ERROR') await fail(`compliance check (${type}) failed — ${issues(res)}`)
    step(`Compliance check passed: simplified ${type === 'invoice' ? 'tax invoice' : `${type} note`}`, true, status)
    previousHash = doc.hash
  }

  // 3. production CSID
  const pc = await zatcaApi.productionCsid(input.environment, complianceToken, complianceSecret, String(cc.data!.requestID))
  if (!pc.ok || !pc.data?.binarySecurityToken) await fail(`production certificate refused (${pc.status}) — ${issues(pc)}`)
  const productionToken = String(pc.data!.binarySecurityToken)
  const prodCert = new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----\n${certificateBody(productionToken)}\n-----END CERTIFICATE-----`)
  step('Production certificate issued — the branch can issue e-invoices', true)

  device = await prisma.zatcaDevice.update({
    where: { id: device.id },
    data: {
      status: 'active', complianceToken, complianceSecretSealed: seal(complianceSecret), complianceRequestId: String(cc.data!.requestID),
      productionToken, productionSecretSealed: seal(String(pc.data!.secret)), certificateExpiresAt: new Date(prodCert.validTo),
      onboardingLog: log as unknown as Prisma.InputJsonValue, lastError: null,
    },
  })
  return { device: publicDevice(device), log }
}

export function publicDevice(d: { id: string; branchId: string; counterCode: string; environment: string; status: string; commonName: string; street: string; building: string; district: string; city: string; postalCode: string; industry: string; icv: number; certificateExpiresAt: Date | null; onboardingLog: unknown; lastError: string | null; updatedAt: Date }) {
  const { id, branchId, counterCode, environment, status, commonName, street, building, district, city, postalCode, industry, icv, certificateExpiresAt, onboardingLog, lastError, updatedAt } = d
  return { id, branchId, counterCode, environment, status, commonName, street, building, district, city, postalCode, industry, icv, certificateExpiresAt, onboardingLog, lastError, updatedAt }
}

// ── Issuing ──────────────────────────────────────────────────────────────────

// Signs the document for an order on its branch device (if that branch is
// onboarded) and queues it for reporting. Safe to call more than once per
// order and type: an existing document is returned.
export async function issueForOrder(orderId: string, type: 'invoice' | 'credit', reason?: string, checkId?: string): Promise<ZatcaDocument | null> {
  const order = await prisma.customerOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: { where: { status: { not: 'cancelled' } }, orderBy: { createdAt: 'asc' } }, organization: { select: { zatcaEnabled: true, timezone: true } } },
  })
  if (!order.organization.zatcaEnabled) return null
  const checks = await prisma.orderCheck.findMany({ where: { orderId } })
  if (!checkId && checks.length) {
    let first = null
    for (const c of checks.filter((c) => type === 'invoice' ? ['paid', 'refunded'].includes(c.status) : c.status === 'refunded')) {
      // Issue the original first if its earlier attempt failed before a refund.
      if (type === 'credit') await issueForOrder(orderId, 'invoice', undefined, c.id)
      const doc = await issueForOrder(orderId, type, reason, c.id)
      first ??= doc
    }
    return first
  }
  const check = checkId ? checks.find((c) => c.id === checkId) : null
  if (checkId && (!check || !['paid', 'refunded'].includes(check.status) || (type === 'credit' && check.status !== 'refunded'))) throw new AppError('This check is not eligible for this document', 409, 'INVALID_STATUS')
  // Refunds must follow the original issuing counter even if the order moved.
  const originalInvoice = type === 'credit' ? await prisma.zatcaDocument.findFirst({ where: { orderId, checkId: checkId ?? null, type: 'invoice' } }) : null
  const device = originalInvoice
    ? await prisma.zatcaDevice.findUnique({ where: { id: originalInvoice.deviceId } })
    : await prisma.zatcaDevice.findUnique({ where: { branchId_counterCode: { branchId: order.branchId, counterCode: check?.counterCode ?? order.counterCode } } })
  if (!device || device.status !== 'active') return null
  const documentScope = { orderId, checkId: checkId ?? null }
  const already = await prisma.zatcaDocument.findFirst({ where: { ...documentScope, type } })
  if (already) return already
  const original = type === 'credit' ? await prisma.zatcaDocument.findFirst({ where: { ...documentScope, type: 'invoice' } }) : null
  if (type === 'credit' && !original) return null // paid before e-invoicing started
  const seller = await sellerFor(order.organizationId, device)
  // a credit note reverses what the invoice billed
  type Billed = Pick<InvoiceInput, 'lines' | 'discountInclusive' | 'vatRate' | 'paymentMeans' | 'payableInclusive' | 'deliveryCharge'>
  const billed: Billed = original?.billed
    ? (original.billed as unknown as Billed)
    : check ? {
        lines: check.lines as unknown as InvoiceInput['lines'], discountInclusive: check.discountAmount, vatRate: check.vatRate,
        payableInclusive: check.totalAmount, paymentMeans: PAYMENT_MEANS[(check.payments as { method: string }[] | null)?.[0]?.method ?? 'cash'] ?? '10',
      } : {
        lines: order.items.map((i) => ({ name: i.dishName, quantity: i.quantity, unitPriceInclusive: i.unitPrice })),
        discountInclusive: order.discountAmount + order.promotionAmount, vatRate: order.vatRate || 15,
        paymentMeans: PAYMENT_MEANS[order.paymentMethod ?? 'cash'] ?? '10', payableInclusive: order.totalAmount,
        ...(order.deliveryFee > 0 && { deliveryCharge: { amountInclusive: order.deliveryFee, vatRate: order.deliveryFeeVatRate, taxCategory: order.deliveryFeeTaxCategory, reasonCode: order.deliveryFeeTaxReasonCode, reason: order.deliveryFeeTaxReason } }),
      }
  if (billed.lines.length === 0) return null

  const doc = await prisma.$transaction(async (tx: Tx) => {
    // the device row lock serializes the counter and the hash chain
    await tx.$queryRaw`SELECT id FROM "ZatcaDevice" WHERE id = ${device.id} FOR UPDATE`
    // Concurrent sync retries can both pass the earlier lookup before this lock.
    const existing = await tx.zatcaDocument.findFirst({ where: { ...documentScope, type } })
    if (existing) return existing
    const d = await tx.zatcaDevice.findUniqueOrThrow({ where: { id: device.id } })
    const icv = d.icv + 1
    const previousHash = d.lastInvoiceHash ?? FIRST_PREVIOUS_HASH
    const when = type === 'invoice' ? check?.paidAt ?? order.closedAt ?? new Date() : check?.refundedAt ?? new Date()
    const uuid = crypto.randomUUID()
    const invoiceNo = `${type === 'invoice' ? 'INV' : 'CRN'}-${order.orderNo}${check ? `-C${check.number}` : ''}`
    const cert = certificateInfo(certificateBody(d.productionToken!))
    const signed = signInvoice({
      type, invoiceNo, uuid, icv, previousHash, issuedAt: issuedAtFor(when, order.organization.timezone), seller,
      ...billed, ...(original && { billingReference: original.invoiceNo, reason: reason || order.cancelReason || 'Refund' }),
    }, cert, unseal(d.privateKeySealed!))
    await tx.zatcaDevice.update({ where: { id: d.id }, data: { icv, lastInvoiceHash: signed.hash } })
    return tx.zatcaDocument.create({
      data: {
        organizationId: order.organizationId, branchId: order.branchId, deviceId: d.id, orderId, checkId, type, invoiceNo, uuid, icv,
        hash: signed.hash, previousHash, qr: signed.qr, xml: signed.xml, issuedAt: when,
        totalAmount: signed.totals.payable, vatAmount: signed.totals.vat, billed: billed as unknown as Prisma.InputJsonValue,
      },
    })
  })
  void reportDocument(doc.id).catch(() => {}) // reported in the background; the queue retries
  return doc
}

// ── Reporting queue ──────────────────────────────────────────────────────────

const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720]

export async function reportDocument(documentId: string) {
  const doc = await prisma.zatcaDocument.findUniqueOrThrow({ where: { id: documentId }, include: { device: true } })
  if (doc.status === 'reported' || doc.status === 'warnings' || doc.status === 'rejected') return doc
  const d = doc.device
  let res: ZatcaResponse
  try {
    res = await zatcaApi.report(d.environment as ZatcaEnvironment, d.productionToken!, unseal(d.productionSecretSealed!), { hash: doc.hash, uuid: doc.uuid, xml: doc.xml })
  } catch (err) {
    res = { status: 0, ok: false, data: null, text: String((err as Error).message ?? err) }
  }
  const warnings = ((res.data?.validationResults as { warningMessages?: unknown[] } | undefined)?.warningMessages ?? []).length > 0
  // 400 = rejected by ZATCA (fix needed, never retried); other failures retry with back-off
  const status = res.ok ? (warnings || res.status === 202 ? 'warnings' : 'reported') : res.status === 400 ? 'rejected' : 'failed'
  const attempts = doc.attempts + 1
  return prisma.zatcaDocument.update({
    where: { id: doc.id },
    data: {
      status, attempts, response: (res.data ?? { error: res.text.slice(0, 1000) }) as Prisma.InputJsonValue,
      ...(res.ok && { reportedAt: new Date() }),
      ...(status === 'failed' && { nextAttemptAt: new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000) }),
    },
  })
}

let running = false
export async function reportDue(limit = 50) {
  if (running) return 0
  running = true
  try {
    // A branch PC reports the invoices it signs. The cloud never reports them
    // again (their copies arrive here through synchronization).
    const pcBranches = process.env.FOODSYNC_DEPLOYMENT_MODE === 'branch' ? [] : (await prisma.branchSyncNode.findMany({ where: { ownsWrites: true }, select: { branchId: true } })).map(n => n.branchId)
    const due = await prisma.zatcaDocument.findMany({
      where: { status: { in: ['pending', 'failed'] }, nextAttemptAt: { lte: new Date() }, ...(pcBranches.length && { branchId: { notIn: pcBranches } }) },
      orderBy: [{ deviceId: 'asc' }, { icv: 'asc' }],
      take: limit,
      select: { id: true },
    })
    for (const d of due) await reportDocument(d.id).catch(() => {})
    return due.length
  } finally {
    running = false
  }
}

export function startZatcaWorker() {
  const timer = setInterval(() => { void reportDue().catch(() => {}) }, 60_000)
  timer.unref()
}
