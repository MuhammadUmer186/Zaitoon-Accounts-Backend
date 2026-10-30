// Regional defaults per country. Choosing a country in Settings fills in the
// currency, time zone, number/date style, sales-tax name and fiscal year;
// each can still be changed by hand afterwards. This is the single source
// for the Settings screen (GET /orgs/regions) and for report formatting.

export interface Region {
  code: string // ISO 3166-1 alpha-2
  name: string
  currency: string // ISO 4217
  locale: string // BCP 47, drives digit grouping and month names
  timezone: string // IANA zone of the capital / main business centre
  taxLabel: string // what the indirect tax is called on documents
  taxRate: number // standard rate, % (informational default for new branches)
  fiscalYearStart: string // MM-DD
  dateFormat: DateFormat
}

export const DATE_FORMATS = ['DD MMM YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'] as const
export type DateFormat = (typeof DATE_FORMATS)[number]

const r = (code: string, name: string, currency: string, locale: string, timezone: string, taxLabel: string, taxRate: number, fiscalYearStart: string, dateFormat: DateFormat): Region =>
  ({ code, name, currency, locale, timezone, taxLabel, taxRate, fiscalYearStart, dateFormat })

// Standard rates and fiscal years as commonly applied to restaurants; they are
// starting points the owner confirms in Settings, not tax advice.
export const REGIONS: Region[] = [
  r('PK', 'Pakistan', 'PKR', 'en-PK', 'Asia/Karachi', 'Sales Tax', 16, '07-01', 'DD MMM YYYY'),
  r('AE', 'United Arab Emirates', 'AED', 'en-AE', 'Asia/Dubai', 'VAT', 5, '01-01', 'DD/MM/YYYY'),
  r('SA', 'Saudi Arabia', 'SAR', 'en-SA', 'Asia/Riyadh', 'VAT', 15, '01-01', 'DD/MM/YYYY'),
  r('QA', 'Qatar', 'QAR', 'en-QA', 'Asia/Qatar', 'Tax', 0, '01-01', 'DD/MM/YYYY'),
  r('KW', 'Kuwait', 'KWD', 'en-KW', 'Asia/Kuwait', 'Tax', 0, '04-01', 'DD/MM/YYYY'),
  r('BH', 'Bahrain', 'BHD', 'en-BH', 'Asia/Bahrain', 'VAT', 10, '01-01', 'DD/MM/YYYY'),
  r('OM', 'Oman', 'OMR', 'en-OM', 'Asia/Muscat', 'VAT', 5, '01-01', 'DD/MM/YYYY'),
  r('IN', 'India', 'INR', 'en-IN', 'Asia/Kolkata', 'GST', 5, '04-01', 'DD/MM/YYYY'),
  r('BD', 'Bangladesh', 'BDT', 'en-BD', 'Asia/Dhaka', 'VAT', 15, '07-01', 'DD/MM/YYYY'),
  r('LK', 'Sri Lanka', 'LKR', 'en-LK', 'Asia/Colombo', 'VAT', 18, '04-01', 'DD/MM/YYYY'),
  r('NP', 'Nepal', 'NPR', 'en-NP', 'Asia/Kathmandu', 'VAT', 13, '07-16', 'DD/MM/YYYY'),
  r('AF', 'Afghanistan', 'AFN', 'en-AF', 'Asia/Kabul', 'BRT', 10, '12-21', 'DD/MM/YYYY'),
  r('GB', 'United Kingdom', 'GBP', 'en-GB', 'Europe/London', 'VAT', 20, '04-06', 'DD/MM/YYYY'),
  r('IE', 'Ireland', 'EUR', 'en-IE', 'Europe/Dublin', 'VAT', 13.5, '01-01', 'DD/MM/YYYY'),
  r('US', 'United States', 'USD', 'en-US', 'America/New_York', 'Sales Tax', 0, '01-01', 'MM/DD/YYYY'),
  r('CA', 'Canada', 'CAD', 'en-CA', 'America/Toronto', 'GST/HST', 13, '01-01', 'YYYY-MM-DD'),
  r('AU', 'Australia', 'AUD', 'en-AU', 'Australia/Sydney', 'GST', 10, '07-01', 'DD/MM/YYYY'),
  r('NZ', 'New Zealand', 'NZD', 'en-NZ', 'Pacific/Auckland', 'GST', 15, '04-01', 'DD/MM/YYYY'),
  r('SG', 'Singapore', 'SGD', 'en-SG', 'Asia/Singapore', 'GST', 9, '01-01', 'DD/MM/YYYY'),
  r('MY', 'Malaysia', 'MYR', 'en-MY', 'Asia/Kuala_Lumpur', 'SST', 6, '01-01', 'DD/MM/YYYY'),
  r('ID', 'Indonesia', 'IDR', 'id-ID', 'Asia/Jakarta', 'PB1', 10, '01-01', 'DD/MM/YYYY'),
  r('TH', 'Thailand', 'THB', 'en-TH', 'Asia/Bangkok', 'VAT', 7, '01-01', 'DD/MM/YYYY'),
  r('PH', 'Philippines', 'PHP', 'en-PH', 'Asia/Manila', 'VAT', 12, '01-01', 'MM/DD/YYYY'),
  r('CN', 'China', 'CNY', 'zh-CN', 'Asia/Shanghai', 'VAT', 6, '01-01', 'YYYY-MM-DD'),
  r('HK', 'Hong Kong', 'HKD', 'en-HK', 'Asia/Hong_Kong', 'Tax', 0, '04-01', 'DD/MM/YYYY'),
  r('JP', 'Japan', 'JPY', 'ja-JP', 'Asia/Tokyo', 'Consumption Tax', 10, '04-01', 'YYYY-MM-DD'),
  r('KR', 'South Korea', 'KRW', 'ko-KR', 'Asia/Seoul', 'VAT', 10, '01-01', 'YYYY-MM-DD'),
  r('TR', 'Türkiye', 'TRY', 'tr-TR', 'Europe/Istanbul', 'KDV', 10, '01-01', 'DD.MM.YYYY'),
  r('EG', 'Egypt', 'EGP', 'en-EG', 'Africa/Cairo', 'VAT', 14, '07-01', 'DD/MM/YYYY'),
  r('ZA', 'South Africa', 'ZAR', 'en-ZA', 'Africa/Johannesburg', 'VAT', 15, '03-01', 'YYYY-MM-DD'),
  r('NG', 'Nigeria', 'NGN', 'en-NG', 'Africa/Lagos', 'VAT', 7.5, '01-01', 'DD/MM/YYYY'),
  r('KE', 'Kenya', 'KES', 'en-KE', 'Africa/Nairobi', 'VAT', 16, '07-01', 'DD/MM/YYYY'),
  r('MA', 'Morocco', 'MAD', 'fr-MA', 'Africa/Casablanca', 'TVA', 10, '01-01', 'DD/MM/YYYY'),
  r('DE', 'Germany', 'EUR', 'de-DE', 'Europe/Berlin', 'MwSt', 19, '01-01', 'DD.MM.YYYY'),
  r('FR', 'France', 'EUR', 'fr-FR', 'Europe/Paris', 'TVA', 10, '01-01', 'DD/MM/YYYY'),
  r('IT', 'Italy', 'EUR', 'it-IT', 'Europe/Rome', 'IVA', 10, '01-01', 'DD/MM/YYYY'),
  r('ES', 'Spain', 'EUR', 'es-ES', 'Europe/Madrid', 'IVA', 10, '01-01', 'DD/MM/YYYY'),
  r('NL', 'Netherlands', 'EUR', 'nl-NL', 'Europe/Amsterdam', 'BTW', 9, '01-01', 'DD/MM/YYYY'),
  r('SE', 'Sweden', 'SEK', 'sv-SE', 'Europe/Stockholm', 'Moms', 12, '01-01', 'YYYY-MM-DD'),
  r('NO', 'Norway', 'NOK', 'nb-NO', 'Europe/Oslo', 'MVA', 15, '01-01', 'DD.MM.YYYY'),
  r('CH', 'Switzerland', 'CHF', 'de-CH', 'Europe/Zurich', 'MWST', 8.1, '01-01', 'DD.MM.YYYY'),
].sort((a, b) => a.name.localeCompare(b.name))

export const regionFor = (code?: string | null) => REGIONS.find((x) => x.code === code)

// Country-only API updates follow the same defaults as the Settings selector.
// Explicit values in the request always win, including deliberate overrides.
export function countryDefaults(code: string) {
  const region = regionFor(code)
  if (!region) return {}
  const { currency, locale, timezone, taxLabel, fiscalYearStart, dateFormat } = region
  return { currency, locale, timezone, taxLabel, fiscalYearStart, dateFormat }
}

// Minor-unit digits of a currency (JPY 0, KWD 3, PKR 2 …) from the runtime's
// ISO 4217 data
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

export function isValidLocale(locale: string): boolean {
  try { return Intl.NumberFormat.supportedLocalesOf([locale]).length > 0 } catch { return false }
}

export function isValidCurrency(currency: string): boolean {
  try { new Intl.NumberFormat('en', { style: 'currency', currency }); return /^[A-Z]{3}$/.test(currency) } catch { return false }
}

export function publicRegion(org?: { currency: string; locale: string; timezone: string; dateFormat: string; taxLabel: string } | null) {
  return org ? { currency: org.currency, locale: org.locale, timezone: org.timezone, dateFormat: org.dateFormat, taxLabel: org.taxLabel } : countryDefaults('PK')
}
