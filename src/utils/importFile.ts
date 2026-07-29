import { Response } from 'express'
import ExcelJS from 'exceljs'

// Writes a template CSV with the literal column keys as the header row
// (e.g. "branchName", not "Branch Name") — the round-trip counterpart to
// parseImportFile below, which reads header text back verbatim to build each
// row's keys. Deliberately does NOT use genericExport's sendRowsCsv, which
// humanizes headers for human-readable report downloads and would silently
// break every import that re-uploads its own template.
export function sendImportTemplate(res: Response, columns: string[], reportName: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${reportName}.csv"`)
  res.send(columns.join(',') + '\r\n')
}

// Shared CSV/Excel row parser for every "upload a spreadsheet" import flow
// (Chart of Accounts, Purchasing, ...). Reads the first sheet, treats row 1
// as headers, and returns one plain string-keyed record per non-blank row.
export async function parseImportFile(file: Express.Multer.File): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook()
  const isCsv = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')

  if (isCsv) {
    const { Readable } = await import('stream')
    await wb.csv.read(Readable.from(file.buffer))
  } else {
    await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer)
  }

  const ws = wb.worksheets[0]
  if (!ws) return []

  const headerRow = ws.getRow(1).values as unknown[]
  const headers = headerRow.slice(1).map((h) => String(h ?? '').trim())

  const rows: Record<string, string>[] = []
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const values = row.values as unknown[]
    const record: Record<string, string> = {}
    headers.forEach((h, i) => { record[h] = String(values[i + 1] ?? '').trim() })
    if (Object.values(record).some((v) => v !== '')) rows.push(record)
  })
  return rows
}
