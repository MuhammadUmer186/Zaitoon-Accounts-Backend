import { randomInt } from 'crypto'
import { getCountries, parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { z } from 'zod'
import { AppError } from '../middleware/error'

export const countries = getCountries()
export const guestSchema = z.object({
  fullName: z.string().trim().min(2).max(120), country: z.enum(countries as [string, ...string[]]),
  dialingCountry: z.enum(countries as [string, ...string[]]), whatsapp: z.string().trim().min(4).max(40),
  email: z.string().trim().toLowerCase().email().max(160), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export function normalizeGuest(input: unknown, today: string) {
  const b = guestSchema.parse(input)
  const phone = parsePhoneNumberFromString(b.whatsapp, b.dialingCountry as any)
  if (!phone?.isValid()) throw new AppError('Enter a valid WhatsApp number', 400, 'INVALID_PHONE')
  const dob = new Date(b.dateOfBirth + 'T00:00:00Z')
  const oldest = new Date(today + 'T00:00:00Z'); oldest.setUTCFullYear(oldest.getUTCFullYear() - 120)
  if (!Number.isFinite(+dob) || dob.toISOString().slice(0, 10) !== b.dateOfBirth || b.dateOfBirth > today || dob < oldest) throw new AppError('Enter a real birth date within the last 120 years', 400, 'VALIDATION_ERROR')
  return { fullName: b.fullName, country: b.country, normalizedWhatsApp: phone.number, normalizedEmail: b.email, dateOfBirth: dob }
}
export function voucherCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const part = () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('')
  return `FD-${part()}-${part()}`
}
export function parseVoucher(input: string) {
  let code = input.trim().toUpperCase()
  if (/^https?:\/\//i.test(input)) {
    let url: URL
    try { url = new URL(input.trim()) } catch { throw new AppError('Invalid voucher URL', 400, 'VALIDATION_ERROR') }
    const allowed = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '')
    if (!allowed || url.origin !== new URL(allowed).origin || !/^\/fd\/v\/[^/]+$/.test(url.pathname) || url.search || url.hash) throw new AppError('Unsupported voucher URL', 400, 'VALIDATION_ERROR')
    code = url.pathname.split('/').pop()!.toUpperCase()
  }
  code = code.replace(/^FD([A-HJ-NP-Z2-9]{5})([A-HJ-NP-Z2-9]{5})$/, 'FD-$1-$2')
  if (!/^FD-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(code)) throw new AppError('Enter a Free Dish voucher code', 400, 'VALIDATION_ERROR')
  return code
}
export function voucherState(v: { status: string; expiresAt: Date | null }, now = new Date()) {
  return v.status === 'redeemed' ? 'redeemed' : v.expiresAt && v.expiresAt <= now ? 'expired' : 'valid'
}
export function businessDay(now: Date, timezone: string) { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) }
export function dayBoundary(day: string, timezone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new AppError('Invalid date filter', 400, 'VALIDATION_ERROR')
  const target = Date.parse(day + 'T00:00:00Z'); let result = target
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(result)).map(p => [p.type, p.value]))
    result += target - Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`)
  }
  return new Date(result)
}
