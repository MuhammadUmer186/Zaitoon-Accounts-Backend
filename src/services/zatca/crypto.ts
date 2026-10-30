import crypto from 'node:crypto'
import { KJUR, X509 } from 'jsrsasign'
import { config } from '../../config'

// Keys, CSR and certificate handling for a ZATCA EGS unit (one per branch
// POS). The ECDSA curve is secp256k1 as ZATCA requires.

export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production'

export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  return {
    privateKeyPem: privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

// Certificate template name per environment (CSR extension 1.3.6.1.4.1.311.20.2)
const TEMPLATE: Record<ZatcaEnvironment, string> = {
  sandbox: 'TSTZATCA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
}

export interface CsrInput {
  environment: ZatcaEnvironment
  commonName: string // EGS name, e.g. "FoodSync-<branch code>"
  organizationUnit: string // branch name (or the 10-digit TIN for VAT groups)
  organizationName: string // taxpayer legal name
  vatNumber: string // 15 digits, starts and ends with 3
  egsSerial: string // 1-<solution>|2-<model>|3-<serial>
  invoiceTypes: string // TSCZ flags: "0100" simplified only, "1100" standard + simplified
  location: string // branch address
  industry: string
}

export function createCsr(input: CsrInput, keys: { privateKeyPem: string; publicKeyPem: string }): string {
  const csr = new KJUR.asn1.csr.CertificationRequest({
    subject: { array: [
      [{ type: 'C', value: 'SA', ds: 'prn' }],
      [{ type: 'OU', value: input.organizationUnit, ds: 'utf8' }],
      [{ type: 'O', value: input.organizationName, ds: 'utf8' }],
      [{ type: 'CN', value: input.commonName, ds: 'utf8' }],
    ] },
    sbjpubkey: keys.publicKeyPem,
    extreq: [
      { extname: '1.3.6.1.4.1.311.20.2', extn: { utf8str: TEMPLATE[input.environment] } },
      { extname: 'subjectAltName', array: [{ dn: { array: [
        [{ type: '2.5.4.4', value: input.egsSerial, ds: 'utf8' }], // SN
        [{ type: '0.9.2342.19200300.100.1.1', value: input.vatNumber, ds: 'utf8' }], // UID
        [{ type: '2.5.4.12', value: input.invoiceTypes, ds: 'utf8' }], // title
        [{ type: '2.5.4.26', value: input.location, ds: 'utf8' }], // registeredAddress
        [{ type: '2.5.4.15', value: input.industry, ds: 'utf8' }], // businessCategory
      ] } }] },
    ],
    sigalg: 'SHA256withECDSA',
    sbjprvkey: keys.privateKeyPem,
  } as never)
  return csr.getPEM()
}

// ZATCA returns the certificate as base64 of the base64 DER body
export const certificateBody = (binarySecurityToken: string) => Buffer.from(binarySecurityToken, 'base64').toString('utf8').trim()
const pem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`

export interface CertificateInfo {
  body: string
  hash: string // base64( hex( sha256(body) ) )
  issuer: string
  serialNumber: string // decimal
  publicKeyDer: Buffer
  signature: Buffer
}

export function certificateInfo(body: string): CertificateInfo {
  const x509 = new crypto.X509Certificate(pem(body))
  const parsed = new X509()
  parsed.readCertPEM(pem(body))
  return {
    body,
    hash: Buffer.from(crypto.createHash('sha256').update(body).digest('hex')).toString('base64'),
    issuer: x509.issuer.split('\n').reverse().join(', '),
    serialNumber: BigInt(`0x${x509.serialNumber}`).toString(10),
    publicKeyDer: x509.publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
    signature: Buffer.from(parsed.getSignatureValueHex(), 'hex'),
  }
}

// Cryptographic stamp: ECDSA over the invoice hash bytes
export function signHash(invoiceHashBase64: string, privateKeyPem: string): string {
  const signer = crypto.createSign('sha256')
  signer.update(Buffer.from(invoiceHashBase64, 'base64'))
  return signer.sign(privateKeyPem).toString('base64')
}

// Secrets at rest (private key, API secrets): AES-256-GCM
const secretKey = () => crypto.createHash('sha256').update(process.env.ZATCA_ENCRYPTION_KEY || `zatca:${config.jwtSecret}`).digest()
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}
export function unseal(sealed: string): string {
  const [iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64'))
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

// Hash chain start: base64 of the hex SHA-256 of "0"
export const FIRST_PREVIOUS_HASH = Buffer.from(crypto.createHash('sha256').update('0').digest('hex')).toString('base64')

export function tlv(values: (string | Buffer)[]): string {
  const parts = values.map((v, i) => {
    const b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')
    if (b.length > 255) throw new Error(`QR tag ${i + 1} too long`)
    return Buffer.concat([Buffer.from([i + 1, b.length]), b])
  })
  return Buffer.concat(parts).toString('base64')
}
