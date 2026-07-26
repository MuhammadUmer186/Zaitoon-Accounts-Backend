// Resolves the start of the fiscal year containing `asOf`, given the org's
// fiscalYearStart setting ("MM-DD"). Used for YTD figures and Current Year
// Earnings, computed live rather than requiring a year-end closing workflow.
export function fiscalYearStartFor(asOf: Date, fiscalYearStart: string): Date {
  const [month, day] = fiscalYearStart.split('-').map(Number)
  const candidate = new Date(Date.UTC(asOf.getUTCFullYear(), (month || 1) - 1, day || 1))
  if (candidate > asOf) candidate.setUTCFullYear(candidate.getUTCFullYear() - 1)
  return candidate
}
