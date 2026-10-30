import { ZatcaEnvironment } from './crypto'

// ZATCA Fatoora API (e-invoicing gateway). Sandbox = developer portal,
// simulation = pre-production, core = production.
const BASE: Record<ZatcaEnvironment, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
}

export interface ZatcaResponse { status: number; ok: boolean; data: Record<string, unknown> | null; text: string }

async function call(env: ZatcaEnvironment, path: string, body: unknown, headers: Record<string, string>): Promise<ZatcaResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)
  try {
    const res = await fetch(`${BASE[env]}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Language': 'en', 'Accept-Version': 'V2', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data: Record<string, unknown> | null = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    // 202 = accepted with warnings
    return { status: res.status, ok: res.status === 200 || res.status === 202, data, text }
  } finally {
    clearTimeout(timer)
  }
}

const basic = (binarySecurityToken: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${binarySecurityToken}:${secret}`).toString('base64')}` })

export const zatcaApi = {
  // Compliance CSID from the taxpayer's one-time password (Fatoora portal)
  complianceCsid: (env: ZatcaEnvironment, csrPem: string, otp: string) =>
    call(env, '/compliance', { csr: Buffer.from(csrPem).toString('base64') }, { OTP: otp }),
  // Compliance check of a sample document with the compliance CSID
  complianceInvoice: (env: ZatcaEnvironment, token: string, secret: string, doc: { hash: string; uuid: string; xml: string }) =>
    call(env, '/compliance/invoices', { invoiceHash: doc.hash, uuid: doc.uuid, invoice: Buffer.from(doc.xml).toString('base64') }, basic(token, secret)),
  productionCsid: (env: ZatcaEnvironment, token: string, secret: string, complianceRequestId: string) =>
    call(env, '/production/csids', { compliance_request_id: complianceRequestId }, basic(token, secret)),
  // Simplified (B2C) documents are reported within 24 hours
  report: (env: ZatcaEnvironment, token: string, secret: string, doc: { hash: string; uuid: string; xml: string }) =>
    call(env, '/invoices/reporting/single', { invoiceHash: doc.hash, uuid: doc.uuid, invoice: Buffer.from(doc.xml).toString('base64') }, { ...basic(token, secret), 'Clearance-Status': '0' }),
}
