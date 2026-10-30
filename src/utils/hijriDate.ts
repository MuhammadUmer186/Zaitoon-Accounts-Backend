// Gregorian -> Hijri conversion, ported from frontend/src/lib/hijri.ts so the
// date stored on a Purchasing Bill matches exactly what the frontend's
// DatePicker already shows the user underneath every date field in this app
// (same tabular/civil calendar, same Arabic month names/numerals) — keeping
// one Hijri calendar system app-wide instead of two that could disagree by a day.
const HIJRI_MONTHS_AR = [
  'محرم', 'صفر', 'ربيع الأول', 'ربيع الآخر', 'جمادى الأولى', 'جمادى الآخرة',
  'رجب', 'شعبان', 'رمضان', 'شوال', 'ذو القعدة', 'ذو الحجة',
]

const EASTERN_ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩']

function toEasternArabicNumerals(n: number): string {
  return String(n).split('').map((d) => EASTERN_ARABIC_DIGITS[parseInt(d, 10)] ?? d).join('')
}

function gregorianToJDN(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12)
  const y = year + 4800 - a
  const m = month + 12 * a - 3
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045
}

const ISLAMIC_CIVIL_EPOCH = 1948439

function jdnToHijri(jdn: number): { day: number; month: number; year: number } {
  let l = jdn - ISLAMIC_CIVIL_EPOCH + 10632
  const n = Math.floor((l - 1) / 10631)
  l = l - 10631 * n + 354
  const j = Math.floor((10985 - l) / 5316) * Math.floor((50 * l) / 17719) + Math.floor(l / 5670) * Math.floor((43 * l) / 15238)
  l = l - Math.floor((30 - j) / 15) * Math.floor((17719 * j) / 50) - Math.floor(j / 16) * Math.floor((15238 * j) / 43) + 29
  const month = Math.floor((24 * l) / 709)
  const day = l - Math.floor((709 * month) / 24)
  const year = 30 * n + j - 30
  return { day, month, year }
}

function hijriToJDN(year: number, month: number, day: number): number {
  return day + Math.ceil(29.5 * (month - 1)) + (year - 1) * 354 + Math.floor((3 + 11 * year) / 30) + ISLAMIC_CIVIL_EPOCH - 1
}

function jdnToGregorian(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044
  const b = Math.floor((4 * a + 3) / 146097)
  const c = a - Math.floor((146097 * b) / 4)
  const d = Math.floor((4 * c + 3) / 1461)
  const e = c - Math.floor((1461 * d) / 4)
  const m = Math.floor((5 * e + 2) / 153)
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: 100 * b + d - 4800 + Math.floor(m / 10),
  }
}

// Hijri -> Gregorian on the same tabular calendar as toHijriDate (exact
// inverse), used when a scanned bill prints only a Hijri date. Returns
// YYYY-MM-DD, or null for an out-of-range day/month.
export function hijriToGregorianISO(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 30) return null
  const g = jdnToGregorian(hijriToJDN(year, month, day))
  return `${g.year}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`
}

export function toHijriDate(date: Date): string {
  const jdn = gregorianToJDN(date.getFullYear(), date.getMonth() + 1, date.getDate())
  const { day, month, year } = jdnToHijri(jdn)
  const monthName = HIJRI_MONTHS_AR[month - 1] ?? ''
  return `${toEasternArabicNumerals(day)} ${monthName} ${toEasternArabicNumerals(year)}هـ`
}
