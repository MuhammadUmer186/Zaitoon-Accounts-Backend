import OpenAI from 'openai'
import sharp from 'sharp'
import { z } from 'zod'
import { prisma, config } from '../config'
import { AppError } from '../middleware/error'
import { hijriToGregorianISO } from '../utils/hijriDate'

// Purchasing → "scan bill": reads an uploaded vendor bill (PDF/JPG/PNG) with
// OpenAI and returns a draft purchase — vendor, date, VAT %, line items —
// already matched against this org's suppliers, catalog items and expense
// categories. Nothing is saved here; the New Purchase form is pre-filled and
// the user reviews it before Apply (which goes through POST /purchasing as
// usual, re-uploading the same file as the mandatory attachment).

// Phone photos are often 5–10 MB; detail beyond ~2400px on the long edge
// doesn't help the model read a bill and only adds upload size and tokens.
const MAX_IMAGE_EDGE = 2400

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] }
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'isPurchaseBill', 'vendorName', 'vendorVatNumber', 'vendorCity', 'invoiceNumber', 'invoiceDate',
    'currency', 'pricesIncludeVat', 'vatPercent', 'subtotal', 'discount', 'vatAmount', 'total',
    'suggestedCategory', 'items', 'warnings',
  ],
  properties: {
    isPurchaseBill: { type: 'boolean' },
    vendorName: nullableString,
    vendorVatNumber: nullableString,
    vendorCity: nullableString,
    invoiceNumber: nullableString,
    invoiceDate: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['year', 'month', 'day', 'calendar'],
          properties: {
            year: { type: 'integer' },
            month: { type: 'integer' },
            day: { type: 'integer' },
            calendar: { type: 'string', enum: ['gregorian', 'hijri'] },
          },
        },
        { type: 'null' },
      ],
    },
    currency: nullableString,
    pricesIncludeVat: { type: 'boolean' },
    vatPercent: nullableNumber,
    subtotal: nullableNumber,
    discount: nullableNumber,
    vatAmount: nullableNumber,
    total: nullableNumber,
    suggestedCategory: nullableString,
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'code', 'quantity', 'unit', 'unitPrice', 'lineTotal'],
        properties: {
          description: { type: 'string' },
          code: nullableString,
          quantity: { type: 'number' },
          unit: nullableString,
          unitPrice: { type: 'number' },
          lineTotal: nullableNumber,
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

// Mirror of OUTPUT_SCHEMA — structured outputs guarantee the shape, this
// guards against a truncated/garbled response slipping through anyway.
const extractionSchema = z.object({
  isPurchaseBill: z.boolean(),
  vendorName: z.string().nullable(),
  vendorVatNumber: z.string().nullable(),
  vendorCity: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z
    .object({ year: z.number().int(), month: z.number().int(), day: z.number().int(), calendar: z.enum(['gregorian', 'hijri']) })
    .nullable(),
  currency: z.string().nullable(),
  pricesIncludeVat: z.boolean(),
  vatPercent: z.number().nullable(),
  subtotal: z.number().nullable(),
  discount: z.number().nullable(),
  vatAmount: z.number().nullable(),
  total: z.number().nullable(),
  suggestedCategory: z.string().nullable(),
  items: z.array(
    z.object({
      description: z.string(),
      code: z.string().nullable(),
      quantity: z.number(),
      unit: z.string().nullable(),
      unitPrice: z.number(),
      lineTotal: z.number().nullable(),
    })
  ),
  warnings: z.array(z.string()),
})

type RawExtraction = z.infer<typeof extractionSchema>

const SYSTEM_PROMPT = `You read vendor purchase bills (tax invoices, cash receipts, delivery invoices) for a restaurant/retail accounting system in Saudi Arabia, and transcribe them into structured data that pre-fills a purchase entry form. A person reviews the form before saving, but they rely on you for exact numbers, so transcribe what is printed rather than estimating.

Bills may be in Arabic, English, or both, printed or handwritten, photographed at an angle, or multi-page PDFs.

Vendor: the seller that issued the bill, never the buyer. The buyer is usually the organization named in the request; do not return it as the vendor. vendorVatNumber is the seller's VAT registration number (Saudi numbers are 15 digits starting and ending with 3) copied digit-for-digit. vendorCity is the seller's city if shown.

Line items: one entry per purchased product or charged service (delivery fees and service charges count as items). Do not add rows for subtotal, VAT, discount, total, rounding, or amount-paid lines. For each item:
- description: the product name as printed. When it is printed in both Arabic and English, use the English text. Keep size/pack details (e.g. "Tomato paste 400g x 24").
- code: the item/SKU/barcode code if the bill shows one, otherwise null.
- quantity: the quantity as a number. Use 1 only when no quantity is shown at all.
- unit: the unit of measure if shown (kg, carton, box, piece, litre, ...), otherwise null.
- unitPrice: price for one unit EXCLUDING VAT, after any discount printed on that line. If the bill only shows VAT-inclusive prices, divide by (1 + VAT rate). If only a line amount is shown, divide it by the quantity. Keep up to 4 decimals rather than rounding to whole numbers.
- lineTotal: the line amount excluding VAT (as printed when printed, otherwise quantity x unitPrice).

Totals: subtotal is the total before VAT and before any invoice-level discount; discount is an invoice-level discount amount not already reflected in the line prices (null if none); vatAmount is the VAT charged; total is the grand total payable. vatPercent is the VAT rate as a percentage (15 for 15%), 0 when the bill explicitly charges no VAT, null when it cannot be determined. pricesIncludeVat is true when the printed item prices already include VAT.

invoiceDate: the issue date as printed, with the calendar it is printed in. If both Gregorian and Hijri dates appear, return the Gregorian one. Do not convert between calendars yourself.

Numbers: plain decimal numbers with "." as the decimal separator and no thousands separators. Read Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and the Arabic decimal mark (٫) correctly.

suggestedCategory: the single best-fitting name from the expense categories listed in the request, copied exactly, or null when none fits.

Use null for anything not visible on the bill rather than guessing. When a value was hard to read, ambiguous, or inferred (handwriting, cut-off text, a quantity you had to assume), still give your best reading and add a short plain-English note to warnings naming the line or field, e.g. "Line 3 quantity is handwritten and unclear (read as 12)". Keep warnings empty when everything was clearly legible.

If the document is not a purchase bill or receipt at all, set isPurchaseBill to false, leave items empty, and say what the document appears to be in warnings.`

export interface ExtractedLine {
  description: string
  quantity: number
  unitCost: number
  unit: string | null
  code: string | null
  itemId: string | null
  itemMatch: 'exact' | 'fuzzy' | null
  matchedItemName: string | null
}

export interface BillExtractionResult {
  isPurchaseBill: boolean
  vendor: {
    name: string | null
    vatNumber: string | null
    city: string | null
    supplierId: string | null
    supplierMatch: 'vat' | 'name' | 'fuzzy' | null
    matchedSupplierName: string | null
  }
  invoiceNumber: string | null
  supplyDate: string | null
  printedDate: string | null
  currency: string | null
  vatPercent: number | null
  categoryId: string | null
  totals: {
    subtotal: number | null
    discount: number | null
    vatAmount: number | null
    total: number | null
    computedSubtotal: number
    computedTotal: number | null
  }
  items: ExtractedLine[]
  warnings: string[]
  model: string
}

let client: OpenAI | null = null
function getClient(): OpenAI {
  if (!config.openaiApiKey) {
    throw new AppError('Bill scanning is not configured — set OPENAI_API_KEY on the server', 503, 'EXTRACTION_UNAVAILABLE')
  }
  client ??= new OpenAI({ apiKey: config.openaiApiKey, timeout: 180_000, maxRetries: 2 })
  return client
}

export function isBillExtractionEnabled(): boolean {
  return !!config.openaiApiKey
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp

// Lowercase, drop Arabic diacritics/tatweel, unify alef/yaa/taa-marbuta
// variants, strip punctuation and collapse whitespace — enough that the same
// vendor/item printed slightly differently compares equal.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    // "1000g" and "1000 g" are the same pack size
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .trim()
}

const COMPANY_WORDS = new Set([
  'co', 'company', 'est', 'establishment', 'ltd', 'llc', 'trading', 'the', 'for', 'and', 'of',
  'شركه', 'مؤسسه', 'للتجاره', 'التجاريه', 'تجاره', 'المحدوده', 'ذ', 'م',
])

function tokens(s: string, dropCompanyWords = false): Set<string> {
  return new Set(normalize(s).split(' ').filter((t) => t && (!dropCompanyWords || !COMPANY_WORDS.has(t))))
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

const digitsOnly = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

function toFileInput(buffer: Buffer, mimetype: string, filename: string) {
  if (mimetype === 'application/pdf') {
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new AppError('This file is not a valid PDF', 400, 'INVALID_FILE')
    }
    return {
      type: 'input_file' as const,
      filename: filename || 'bill.pdf',
      file_data: `data:application/pdf;base64,${buffer.toString('base64')}`,
    }
  }
  return null
}

async function toImageInput(buffer: Buffer) {
  let jpeg: Buffer
  try {
    // .rotate() with no args applies the EXIF orientation, so sideways phone
    // photos reach the model upright.
    jpeg = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toBuffer()
  } catch {
    throw new AppError('Could not read this image — upload a clear JPG or PNG of the bill', 400, 'INVALID_FILE')
  }
  return {
    type: 'input_image' as const,
    // "high" keeps small print and handwritten quantities legible
    detail: 'high' as const,
    image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
  }
}

async function callModel(file: Express.Multer.File, orgName: string, categoryNames: string[]): Promise<RawExtraction> {
  const openai = getClient()
  const fileInput = toFileInput(file.buffer, file.mimetype, file.originalname) ?? (await toImageInput(file.buffer))

  const requestText = [
    `Buyer organization (not the vendor): ${orgName}`,
    `Expense categories: ${categoryNames.length ? categoryNames.map((c) => `"${c}"`).join(', ') : '(none configured)'}`,
    'Transcribe this bill.',
  ].join('\n')

  let response: OpenAI.Responses.Response
  try {
    response = await openai.responses.create({
      model: config.billExtractionModel,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: [fileInput, { type: 'input_text', text: requestText }] }],
      max_output_tokens: 32000,
      // Bills can contain personal/commercial data — don't keep them on OpenAI's side
      store: false,
      text: { format: { type: 'json_schema', name: 'purchase_bill', strict: true, schema: OUTPUT_SCHEMA } },
    })
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
      console.error('Bill extraction auth error:', err.message)
      throw new AppError('Bill scanning is misconfigured on the server (API key rejected)', 503, 'EXTRACTION_UNAVAILABLE')
    }
    if (err instanceof OpenAI.RateLimitError) {
      // 429 also covers an exhausted quota / unpaid billing on the OpenAI account
      console.error('Bill extraction rate limited:', err.message)
      throw new AppError('Bill scanning is busy or out of quota right now — try again later or enter the items manually', 429, 'EXTRACTION_RATE_LIMITED')
    }
    if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.UnprocessableEntityError) {
      console.error('Bill extraction rejected:', err.message)
      throw new AppError('This file could not be read (it may be corrupted, password-protected or too large)', 422, 'EXTRACTION_FAILED')
    }
    if (err instanceof OpenAI.APIError) {
      console.error(`Bill extraction API error ${err.status}:`, err.message)
      throw new AppError('Bill scanning service is temporarily unavailable — enter the items manually or retry', 502, 'EXTRACTION_FAILED')
    }
    throw err
  }

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason
    if (reason === 'content_filter') {
      throw new AppError('This document could not be processed — enter the items manually', 422, 'EXTRACTION_FAILED')
    }
    throw new AppError('This bill is too long to scan in one go — enter the items manually or split the file', 422, 'EXTRACTION_FAILED')
  }

  let text = ''
  for (const item of response.output) {
    if (item.type !== 'message') continue
    for (const part of item.content) {
      if (part.type === 'refusal') {
        console.error('Bill extraction refused:', part.refusal)
        throw new AppError('This document could not be processed — enter the items manually', 422, 'EXTRACTION_FAILED')
      }
      if (part.type === 'output_text') text += part.text
    }
  }
  try {
    return extractionSchema.parse(JSON.parse(text))
  } catch {
    console.error('Bill extraction returned unparseable output:', text.slice(0, 500))
    throw new AppError('Could not understand the scan result — try again or enter the items manually', 502, 'EXTRACTION_FAILED')
  }
}

export async function extractBill(organizationId: string, file: Express.Multer.File): Promise<BillExtractionResult> {
  const [org, categories, suppliers, items] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    prisma.expenseCategory.findMany({ where: { organizationId, isActive: true }, select: { id: true, name: true } }),
    prisma.supplier.findMany({ where: { organizationId, isActive: true }, select: { id: true, name: true, tradeName: true, vatNumber: true } }),
    prisma.item.findMany({ where: { organizationId, isActive: true }, select: { id: true, code: true, name: true } }),
  ])

  const raw = await callModel(file, org?.name ?? 'Unknown', categories.map((c) => c.name))
  const warnings = [...raw.warnings]

  // ── Vendor → existing supplier ──
  let supplierMatch: BillExtractionResult['vendor']['supplierMatch'] = null
  let matchedSupplier: (typeof suppliers)[number] | undefined
  const vatDigits = digitsOnly(raw.vendorVatNumber)
  if (vatDigits.length >= 10) {
    matchedSupplier = suppliers.find((s) => digitsOnly(s.vatNumber) === vatDigits)
    if (matchedSupplier) supplierMatch = 'vat'
  }
  if (!matchedSupplier && raw.vendorName) {
    const target = normalize(raw.vendorName)
    matchedSupplier = suppliers.find((s) => normalize(s.name) === target || (s.tradeName && normalize(s.tradeName) === target))
    if (matchedSupplier) {
      supplierMatch = 'name'
    } else {
      const targetTokens = tokens(raw.vendorName, true)
      let best = 0
      for (const s of suppliers) {
        const score = Math.max(jaccard(targetTokens, tokens(s.name, true)), s.tradeName ? jaccard(targetTokens, tokens(s.tradeName, true)) : 0)
        if (score > best) { best = score; matchedSupplier = s }
      }
      if (best >= 0.6) supplierMatch = 'fuzzy'
      else matchedSupplier = undefined
    }
  }
  // A supplier matched by name whose VAT number differs from the bill's is
  // probably a different legal entity with a similar name.
  if (matchedSupplier && supplierMatch !== 'vat' && vatDigits && digitsOnly(matchedSupplier.vatNumber) && digitsOnly(matchedSupplier.vatNumber) !== vatDigits) {
    warnings.push(`Vendor "${matchedSupplier.name}" was matched by name, but its saved VAT number differs from the bill's (${raw.vendorVatNumber}) — confirm it is the same vendor`)
  }

  // ── Line items → catalog items ──
  const itemByCode = new Map(items.map((i) => [i.code.trim().toLowerCase(), i]))
  const itemByName = new Map(items.map((i) => [normalize(i.name), i]))
  const itemTokens = items.map((i) => ({ item: i, tokens: tokens(i.name) }))

  const lines: ExtractedLine[] = []
  raw.items.forEach((line, idx) => {
    const description = line.description.trim()
    if (!description) return
    if (!(line.quantity > 0)) {
      warnings.push(`Line ${idx + 1} ("${description}") has no valid quantity — it was skipped`)
      return
    }
    if (line.unitPrice < 0) {
      warnings.push(`Line ${idx + 1} ("${description}") has a negative price (a return or discount line?) — it was skipped`)
      return
    }

    let match: (typeof items)[number] | undefined
    let itemMatch: ExtractedLine['itemMatch'] = null
    if (line.code) match = itemByCode.get(line.code.trim().toLowerCase())
    if (!match) match = itemByName.get(normalize(description))
    if (match) {
      itemMatch = 'exact'
    } else {
      const lineTokens = tokens(description)
      let best = 0
      for (const c of itemTokens) {
        const score = jaccard(lineTokens, c.tokens)
        if (score > best) { best = score; match = c.item }
      }
      if (best >= 0.5) itemMatch = 'fuzzy'
      else match = undefined
    }

    lines.push({
      description,
      quantity: round(line.quantity, 4),
      unitCost: round(line.unitPrice, 4),
      unit: line.unit,
      code: line.code,
      itemId: match?.id ?? null,
      itemMatch,
      matchedItemName: match?.name ?? null,
    })
  })

  // ── VAT % ──
  let vatPercent = raw.vatPercent
  if (vatPercent == null && raw.vatAmount != null && raw.subtotal) {
    const base = raw.subtotal - (raw.discount ?? 0)
    if (base > 0) {
      vatPercent = round((raw.vatAmount / base) * 100, 2)
      if (Math.abs(vatPercent - 15) < 0.3) vatPercent = 15
    }
  }
  if (vatPercent != null && (vatPercent < 0 || vatPercent > 100)) {
    warnings.push(`VAT rate read as ${vatPercent}% looks wrong — check it`)
    vatPercent = null
  }

  // ── Date ──
  let supplyDate: string | null = null
  let printedDate: string | null = null
  if (raw.invoiceDate) {
    const { year, month, day, calendar } = raw.invoiceDate
    printedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}${calendar === 'hijri' ? ' (Hijri)' : ''}`
    if (calendar === 'hijri') {
      supplyDate = hijriToGregorianISO(year, month, day)
    } else {
      const d = new Date(Date.UTC(year, month - 1, day))
      supplyDate = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : null
    }
    if (!supplyDate) {
      warnings.push(`The bill date (${printedDate}) is not a valid date — set the supply date manually`)
    } else {
      const ageDays = (Date.now() - Date.parse(supplyDate)) / 86_400_000
      if (ageDays < -1) warnings.push(`The bill date ${supplyDate} is in the future — check it`)
      else if (ageDays > 366) warnings.push(`The bill date ${supplyDate} is more than a year old — check it`)
    }
  }

  // ── Arithmetic cross-checks against the printed totals ──
  const computedSubtotal = round(lines.reduce((s, l) => s + l.quantity * l.unitCost, 0), 2)
  const tolerance = (amount: number) => Math.max(0.05, Math.abs(amount) * 0.005)
  if (raw.subtotal != null && Math.abs(computedSubtotal - raw.subtotal) > tolerance(raw.subtotal)) {
    warnings.push(`Line items add up to ${computedSubtotal.toFixed(2)} but the bill's subtotal is ${raw.subtotal.toFixed(2)} — a line may be missing or misread`)
  }
  if (raw.discount) {
    warnings.push(`The bill has an invoice-level discount of ${raw.discount.toFixed(2)} that is not included in the line items — adjust unit costs so the total matches the bill`)
  }
  const computedTotal = vatPercent != null ? round(computedSubtotal * (1 + vatPercent / 100), 2) : null
  if (computedTotal != null && raw.total != null && !raw.discount && Math.abs(computedTotal - raw.total) > tolerance(raw.total)) {
    warnings.push(`Calculated total ${computedTotal.toFixed(2)} differs from the bill's total ${raw.total.toFixed(2)} — check quantities, prices and VAT`)
  }
  if (raw.currency && !/^(sar|sr|ر\.?\s?س|riyal|ريال|﷼)/i.test(raw.currency.trim())) {
    warnings.push(`The bill is in ${raw.currency}, not SAR — convert the amounts before applying`)
  }
  if (raw.isPurchaseBill && lines.length === 0) {
    warnings.push('No line items could be read from this bill — enter them manually')
  }

  const category = raw.suggestedCategory
    ? categories.find((c) => c.name.trim().toLowerCase() === raw.suggestedCategory!.trim().toLowerCase())
    : undefined

  return {
    isPurchaseBill: raw.isPurchaseBill,
    vendor: {
      name: raw.vendorName,
      vatNumber: raw.vendorVatNumber,
      city: raw.vendorCity,
      supplierId: matchedSupplier?.id ?? null,
      supplierMatch,
      matchedSupplierName: matchedSupplier?.name ?? null,
    },
    invoiceNumber: raw.invoiceNumber,
    supplyDate,
    printedDate,
    currency: raw.currency,
    vatPercent,
    categoryId: category?.id ?? null,
    totals: {
      subtotal: raw.subtotal,
      discount: raw.discount,
      vatAmount: raw.vatAmount,
      total: raw.total,
      computedSubtotal,
      computedTotal,
    },
    items: lines,
    warnings,
    model: config.billExtractionModel,
  }
}
