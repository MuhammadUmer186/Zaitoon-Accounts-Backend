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

export function toHijriDate(date: Date): string {
  const jdn = gregorianToJDN(date.getFullYear(), date.getMonth() + 1, date.getDate())
  const { day, month, year } = jdnToHijri(jdn)
  const monthName = HIJRI_MONTHS_AR[month - 1] ?? ''
  return `${toEasternArabicNumerals(day)} ${monthName} ${toEasternArabicNumerals(year)}هـ`
}
