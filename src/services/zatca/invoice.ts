import crypto from 'node:crypto'
import { el, render, without, amount, XmlNode } from './xml'
import { CertificateInfo, signHash, tlv } from './crypto'

// ZATCA (KSA) e-invoice: UBL 2.1 XML with the KSA extensions, signed with the
// EGS unit's cryptographic stamp (XAdES enveloped signature), chained to the
// previous invoice's hash, with the phase-2 TLV QR code.

export type DocumentType = 'invoice' | 'credit' | 'debit'
const TYPE_CODE: Record<DocumentType, string> = { invoice: '388', credit: '381', debit: '383' }
// gift cards and points are prepaid stored value ("not defined"); a house
// account is a credit sale (30, credit transfer)
export const PAYMENT_MEANS: Record<string, string> = { cash: '10', card: '48', mada: '48', bank_transfer: '42', other: '1', split: '1', gift_card: '1', loyalty: '1', house_account: '30' }

export interface Seller {
  name: string // legal (registration) name
  vatNumber: string
  crn: string // commercial registration number
  street: string
  building: string // 4 digits
  district: string
  city: string
  postalCode: string // 5 digits
}

export interface InvoiceLine {
  name: string
  quantity: number
  unitPriceInclusive: number // menu price, VAT-inclusive
}

export interface InvoiceInput {
  type: DocumentType
  invoiceNo: string
  uuid: string
  icv: number // invoice counter value of this EGS unit
  previousHash: string // PIH
  issuedAt: { date: string; time: string } // KSA local date (YYYY-MM-DD) and time (HH:mm:ss)
  seller: Seller
  lines: InvoiceLine[]
  deliveryCharge?: { amountInclusive: number; vatRate: number; taxCategory: string; reasonCode?: string | null; reason?: string | null }
  discountInclusive: number // order-level discount, VAT-inclusive
  vatRate: number // e.g. 15
  paymentMeans: string // ZATCA payment means code
  payableInclusive?: number // what the customer actually paid, to absorb rounding
  billingReference?: string // original invoice number (credit / debit notes)
  reason?: string // credit / debit note reason (KSA-10)
  currency?: string
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const NS = {
  xmlns: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  'xmlns:cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  'xmlns:cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  'xmlns:ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
}

// Amounts as ZATCA computes them: net line amounts from VAT-inclusive menu
// prices, document discount as an allowance, VAT on the taxable total.
export function computeTotals(input: InvoiceInput) {
  const rate = input.vatRate / 100
  const lines = input.lines.map((l, i) => {
    const unitNet = r2(l.unitPriceInclusive / (1 + rate))
    const lineNet = r2(unitNet * l.quantity)
    const lineVat = r2(lineNet * rate)
    return { id: i + 1, name: l.name, quantity: l.quantity, unitNet, lineNet, lineVat, lineGross: r2(lineNet + lineVat) }
  })
  const lineTotal = r2(lines.reduce((s, l) => s + l.lineNet, 0))
  const discountNet = r2(input.discountInclusive / (1 + rate))
  const foodTaxable = r2(lineTotal - discountNet)
  const charge = input.deliveryCharge
  const chargeNet = charge ? r2(charge.amountInclusive / (1 + charge.vatRate / 100)) : 0
  const breakdowns = [{ category: 'S', rate: input.vatRate, taxable: foodTaxable, reasonCode: null as string | null, reason: null as string | null }]
  if (chargeNet > 0 && charge) {
    const same = breakdowns.find((b) => b.category === charge.taxCategory && b.rate === charge.vatRate)
    if (same) same.taxable = r2(same.taxable + chargeNet)
    else breakdowns.push({ category: charge.taxCategory, rate: charge.vatRate, taxable: chargeNet, reasonCode: charge.reasonCode ?? null, reason: charge.reason ?? null })
  }
  const taxExclusive = r2(foodTaxable + chargeNet)
  const vat = r2(breakdowns.reduce((n, b) => n + r2(b.taxable * b.rate / 100), 0))
  const taxInclusive = r2(taxExclusive + vat)
  let rounding = 0
  if (input.payableInclusive !== undefined) {
    const diff = r2(input.payableInclusive - taxInclusive)
    if (Math.abs(diff) <= 0.1) rounding = diff // halala differences from inclusive pricing
  }
  return { lines, lineTotal, discountNet, chargeNet, breakdowns, taxExclusive, vat, taxInclusive, rounding, payable: r2(taxInclusive + rounding) }
}

const taxCategory = (rate: number, category = 'S', reasonCode?: string | null, reason?: string | null) => el('cac:TaxCategory', [
  el('cbc:ID', category),
  el('cbc:Percent', amount(rate)),
  reasonCode ? el('cbc:TaxExemptionReasonCode', reasonCode) : null,
  reason ? el('cbc:TaxExemptionReason', reason) : null,
  el('cac:TaxScheme', [el('cbc:ID', 'VAT')]),
])

function invoiceTree(input: InvoiceInput, qr: string | null, signature: XmlNode | null): XmlNode {
  const t = computeTotals(input)
  const cur = input.currency ?? 'SAR'
  const money = (n: number) => ({ currencyID: cur }) as Record<string, string>
  const s = input.seller
  return el('Invoice', NS, [
    signature ? el('ext:UBLExtensions', [signature]) : null,
    el('cbc:ProfileID', 'reporting:1.0'),
    el('cbc:ID', input.invoiceNo),
    el('cbc:UUID', input.uuid),
    el('cbc:IssueDate', input.issuedAt.date),
    el('cbc:IssueTime', input.issuedAt.time),
    el('cbc:InvoiceTypeCode', { name: '0200000' }, TYPE_CODE[input.type]),
    el('cbc:DocumentCurrencyCode', cur),
    el('cbc:TaxCurrencyCode', cur),
    input.billingReference ? el('cac:BillingReference', [el('cac:InvoiceDocumentReference', [el('cbc:ID', input.billingReference)])]) : null,
    el('cac:AdditionalDocumentReference', [el('cbc:ID', 'ICV'), el('cbc:UUID', String(input.icv))]),
    el('cac:AdditionalDocumentReference', [el('cbc:ID', 'PIH'), el('cac:Attachment', [el('cbc:EmbeddedDocumentBinaryObject', { mimeCode: 'text/plain' }, input.previousHash)])]),
    qr !== null ? el('cac:AdditionalDocumentReference', [el('cbc:ID', 'QR'), el('cac:Attachment', [el('cbc:EmbeddedDocumentBinaryObject', { mimeCode: 'text/plain' }, qr)])]) : null,
    signature ? el('cac:Signature', [el('cbc:ID', 'urn:oasis:names:specification:ubl:signature:Invoice'), el('cbc:SignatureMethod', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades')]) : null,
    el('cac:AccountingSupplierParty', [el('cac:Party', [
      el('cac:PartyIdentification', [el('cbc:ID', { schemeID: 'CRN' }, s.crn)]),
      el('cac:PostalAddress', [
        el('cbc:StreetName', s.street), el('cbc:BuildingNumber', s.building), el('cbc:CitySubdivisionName', s.district),
        el('cbc:CityName', s.city), el('cbc:PostalZone', s.postalCode), el('cac:Country', [el('cbc:IdentificationCode', 'SA')]),
      ]),
      el('cac:PartyTaxScheme', [el('cbc:CompanyID', s.vatNumber), el('cac:TaxScheme', [el('cbc:ID', 'VAT')])]),
      el('cac:PartyLegalEntity', [el('cbc:RegistrationName', s.name)]),
    ])]),
    el('cac:AccountingCustomerParty', []),
    el('cac:PaymentMeans', [
      el('cbc:PaymentMeansCode', input.paymentMeans),
      input.type !== 'invoice' ? el('cbc:InstructionNote', input.reason || 'Refund') : null,
    ]),
    t.discountNet > 0 ? el('cac:AllowanceCharge', [
      el('cbc:ChargeIndicator', 'false'),
      el('cbc:AllowanceChargeReason', 'discount'),
      el('cbc:Amount', money(t.discountNet), amount(t.discountNet)),
      taxCategory(input.vatRate),
    ]) : null,
    t.chargeNet > 0 && input.deliveryCharge ? el('cac:AllowanceCharge', [
      el('cbc:ChargeIndicator', 'true'),
      el('cbc:AllowanceChargeReasonCode', 'FC'),
      el('cbc:AllowanceChargeReason', 'Delivery'),
      el('cbc:Amount', money(t.chargeNet), amount(t.chargeNet)),
      taxCategory(input.deliveryCharge.vatRate, input.deliveryCharge.taxCategory),
    ]) : null,
    el('cac:TaxTotal', [el('cbc:TaxAmount', money(t.vat), amount(t.vat))]),
    el('cac:TaxTotal', [
      el('cbc:TaxAmount', money(t.vat), amount(t.vat)),
      ...t.breakdowns.map((b) => el('cac:TaxSubtotal', [
        el('cbc:TaxableAmount', money(b.taxable), amount(b.taxable)),
        el('cbc:TaxAmount', money(b.taxable * b.rate / 100), amount(b.taxable * b.rate / 100)),
        taxCategory(b.rate, b.category, b.reasonCode, b.reason),
      ])),
    ]),
    el('cac:LegalMonetaryTotal', [
      el('cbc:LineExtensionAmount', money(t.lineTotal), amount(t.lineTotal)),
      el('cbc:TaxExclusiveAmount', money(t.taxExclusive), amount(t.taxExclusive)),
      el('cbc:TaxInclusiveAmount', money(t.taxInclusive), amount(t.taxInclusive)),
      el('cbc:AllowanceTotalAmount', money(t.discountNet), amount(t.discountNet)),
      t.chargeNet > 0 ? el('cbc:ChargeTotalAmount', money(t.chargeNet), amount(t.chargeNet)) : null,
      el('cbc:PrepaidAmount', money(0), amount(0)),
      t.rounding ? el('cbc:PayableRoundingAmount', money(t.rounding), amount(t.rounding)) : null,
      el('cbc:PayableAmount', money(t.payable), amount(t.payable)),
    ]),
    ...t.lines.map((l) => el('cac:InvoiceLine', [
      el('cbc:ID', String(l.id)),
      el('cbc:InvoicedQuantity', { unitCode: 'PCE' }, String(l.quantity)),
      el('cbc:LineExtensionAmount', money(l.lineNet), amount(l.lineNet)),
      el('cac:TaxTotal', [el('cbc:TaxAmount', money(l.lineVat), amount(l.lineVat)), el('cbc:RoundingAmount', money(l.lineGross), amount(l.lineGross))]),
      el('cac:Item', [el('cbc:Name', l.name), el('cac:ClassifiedTaxCategory', [el('cbc:ID', 'S'), el('cbc:Percent', amount(input.vatRate)), el('cac:TaxScheme', [el('cbc:ID', 'VAT')])])]),
      el('cac:Price', [el('cbc:PriceAmount', money(l.unitNet), amount(l.unitNet))]),
    ])),
  ])
}

const DS = 'http://www.w3.org/2000/09/xmldsig#'
const XADES = 'http://uri.etsi.org/01903/v1.3.2#'
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256'

export interface SignedInvoice {
  xml: string
  hash: string // base64 SHA-256 of the canonical invoice (this becomes the next PIH)
  qr: string // base64 TLV
  totals: ReturnType<typeof computeTotals>
}

export function signInvoice(input: InvoiceInput, cert: CertificateInfo, privateKeyPem: string, signingTime = new Date()): SignedInvoice {
  // 1. hash of the invoice without UBLExtensions / Signature / QR
  const unsigned = invoiceTree(input, null, null)
  const hash = crypto.createHash('sha256').update(render(unsigned)).digest('base64')
  // 2. cryptographic stamp
  const signatureValue = signHash(hash, privateKeyPem)
  const time = signingTime.toISOString().slice(0, 19)
  // ZATCA's validator digests SignedProperties in this exact layout (spacing
  // and per-element ds namespace included), and expects it embedded in the
  // second layout below — anything else fails "signed-properties-hashing"
  // once a production CSID is used. Do not reformat these two templates.
  const FOR_SIGNING = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${time}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${cert.hash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${cert.issuer}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${cert.serialNumber}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`
  const EMBEDDED = `<xades:SignedProperties Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${time}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
                                                    <ds:DigestValue>${cert.hash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName>${cert.issuer}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber>${cert.serialNumber}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`
  const propsDigest = Buffer.from(crypto.createHash('sha256').update(FOR_SIGNING).digest('hex')).toString('base64')
  // 3. QR (phase 2: tags 1–9). Tag 4 is the amount due (BT-115, PayableAmount,
  // after halala rounding), not TaxInclusiveAmount, or ZATCA warns
  // invoiceTotal_QRCODE_INVALID
  const totals = computeTotals(input)
  const qr = tlv([
    input.seller.name, input.seller.vatNumber, `${input.issuedAt.date}T${input.issuedAt.time}`,
    amount(totals.payable), amount(totals.vat), hash, signatureValue, cert.publicKeyDer, cert.signature,
  ])
  const transform = (xpath: string) => el('ds:Transform', { Algorithm: 'http://www.w3.org/TR/1999/REC-xpath-19991116' }, [el('ds:XPath', xpath)])
  const signature = el('ext:UBLExtension', [
    el('ext:ExtensionURI', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'),
    el('ext:ExtensionContent', [el('sig:UBLDocumentSignatures', {
      'xmlns:sig': 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
      'xmlns:sac': 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
      'xmlns:sbc': 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
    }, [el('sac:SignatureInformation', [
      el('cbc:ID', 'urn:oasis:names:specification:ubl:signature:1'),
      el('sbc:ReferencedSignatureID', 'urn:oasis:names:specification:ubl:signature:Invoice'),
      el('ds:Signature', { 'xmlns:ds': DS, Id: 'signature' }, [
        el('ds:SignedInfo', [
          el('ds:CanonicalizationMethod', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
          el('ds:SignatureMethod', { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256' }),
          el('ds:Reference', { Id: 'invoiceSignedData', URI: '' }, [
            el('ds:Transforms', [
              transform('not(//ancestor-or-self::ext:UBLExtensions)'),
              transform('not(//ancestor-or-self::cac:Signature)'),
              transform("not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])"),
              el('ds:Transform', { Algorithm: 'http://www.w3.org/2006/12/xml-c14n11' }),
            ]),
            el('ds:DigestMethod', { Algorithm: SHA256 }),
            el('ds:DigestValue', hash),
          ]),
          el('ds:Reference', { Type: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties', URI: '#xadesSignedProperties' }, [
            el('ds:DigestMethod', { Algorithm: SHA256 }),
            el('ds:DigestValue', propsDigest),
          ]),
        ]),
        el('ds:SignatureValue', signatureValue),
        el('ds:KeyInfo', [el('ds:X509Data', [el('ds:X509Certificate', cert.body)])]),
        el('ds:Object', [el('xades:QualifyingProperties', { 'xmlns:xades': XADES, Target: 'signature' }, [{ name: '#raw', children: [EMBEDDED] }])]),
      ]),
    ])])]),
  ])
  const signed = invoiceTree(input, qr, signature)
  // sanity: the signed document minus the excluded parts hashes the same
  const check = without(signed, (n) => n.name === 'ext:UBLExtensions' || n.name === 'cac:Signature'
    || (n.name === 'cac:AdditionalDocumentReference' && n.children.some((c) => typeof c === 'object' && c?.name === 'cbc:ID' && c.children[0] === 'QR')))
  if (crypto.createHash('sha256').update(render(check)).digest('base64') !== hash) throw new Error('ZATCA invoice hash mismatch')
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n${render(signed)}`, hash, qr, totals }
}
