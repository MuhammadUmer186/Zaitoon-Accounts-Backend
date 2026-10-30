import { roundMoney as regionalRoundMoney } from '../utils/money'
import { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'

type Db = PrismaClient | Prisma.TransactionClient
export const roundMoney = (n: number) => regionalRoundMoney(n)
export const normalizeArea = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

export function normalizePhone(value: string, country: string) {
  let digits = value.replace(/\D/g, '')
  const internationalPrefix = digits.startsWith('00')
  if (internationalPrefix) digits = digits.slice(2)
  if (digits.length < 7 || digits.length > 15) throw new AppError('Enter a phone number with 7 to 15 digits', 400, 'VALIDATION_ERROR')
  if (value.trim().startsWith('+')) return `+${digits}`
  if (internationalPrefix) return `+${digits}`
  const prefix = country === 'PK' ? '92' : country === 'SA' ? '966' : ''
  if (prefix && digits.startsWith('0')) return `+${prefix}${digits.slice(1)}`
  return prefix && digits.startsWith(prefix) ? `+${digits}` : digits
}

export async function validateDeliveryTax(db: Db, organizationId: string, branch: { vatEnabled: boolean; vatRate: number }, zone: { fee: number; feeVatRate: number | null; feeTaxCategory: string; feeTaxReasonCode?: string | null; feeTaxReason?: string | null }) {
  if (!zone.fee || !await db.organization.count({ where: { id: organizationId, zatcaEnabled: true } })) return
  if (!branch.vatEnabled || branch.vatRate <= 0 || zone.feeTaxCategory === 'O') throw new AppError('This KSA menu uses standard-rated food. Outside-scope charges cannot be mixed with it; configure the applicable VAT treatment.', 400, 'DELIVERY_TAX_CONFIGURATION')
  if (zone.feeTaxCategory === 'S' && (zone.feeVatRate ?? branch.vatRate) <= 0 || zone.feeTaxCategory !== 'S' && (!zone.feeTaxReasonCode?.startsWith('VATEX-SA-') || !zone.feeTaxReason)) throw new AppError('Configure the delivery charge VAT rate and applicable KSA exemption reason', 400, 'DELIVERY_TAX_CONFIGURATION')
}

export async function deliveryQuote(db: Db, organizationId: string, branch: { id: string; vatEnabled: boolean; vatRate: number }, orderType: string, zoneId?: string | null, area?: string | null, required = false) {
  if (orderType !== 'delivery') {
    if (zoneId) throw new AppError('Only delivery orders have a delivery zone', 400, 'VALIDATION_ERROR')
    return {}
  }
  if (!zoneId) {
    if (required || await db.deliveryZone.count({ where: { organizationId, branchId: branch.id, isActive: true } })) throw new AppError('Choose a delivery zone', 400, 'DELIVERY_ZONE_REQUIRED')
    return { deliveryStatus: 'unassigned', deliveryPaymentMode: 'prepaid' }
  }
  const zone = await db.deliveryZone.findFirst({ where: { id: zoneId, organizationId, branchId: branch.id, isActive: true } })
  if (!zone) throw new AppError('Delivery zone is unavailable in this branch', 409, 'DELIVERY_ZONE_UNAVAILABLE')
  await validateDeliveryTax(db, organizationId, branch, zone)
  if (zone.areas.length && !zone.areas.includes(normalizeArea(area ?? ''))) throw new AppError('Choose an area or postal code covered by this zone', 400, 'DELIVERY_AREA_UNAVAILABLE')
  const rate = zone.feeVatRate ?? (branch.vatEnabled ? branch.vatRate : 0)
  return {
    deliveryZoneId: zone.id, deliveryZoneName: zone.name, deliveryArea: area?.trim() || null,
    deliveryMinimumOrder: zone.minimumOrder, deliveryFee: zone.fee, deliveryFeeVatRate: rate,
    deliveryFeeVatAmount: roundMoney(zone.fee * rate / (100 + rate)), deliveryFeeTaxCategory: zone.feeTaxCategory,
    deliveryFeeTaxReasonCode: zone.feeTaxReasonCode, deliveryFeeTaxReason: zone.feeTaxReason,
    deliveryStatus: 'unassigned', deliveryPaymentMode: 'prepaid',
    estimatedReadyAt: new Date(Date.now() + zone.etaMinutes * 60000),
  }
}
