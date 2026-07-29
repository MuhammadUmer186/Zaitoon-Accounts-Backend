import { Response } from 'express'
import ExcelJS from 'exceljs'
import { AppError } from '../middleware/error'

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

  try {
    if (isCsv) {
      const { Readable } = await import('stream')
      await wb.csv.read(Readable.from(file.buffer))
    } else {
      await wb.xlsx.load(file.buffer as unknown as ExcelJS.Buffer)
    }
  } catch {
    // A renamed/corrupt/wrong-type file makes exceljs throw deep inside its
    // zip/xml parser (e.g. "Cannot read properties of undefined") rather
    // than a clean error — surface a message the user can act on instead of
    // a 500.
    throw new AppError(
      `Could not read "${file.originalname}" as a CSV or Excel file. Make sure it's a valid .csv or .xlsx file and try again.`,
      400,
      'INVALID_IMPORT_FILE'
    )
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

// Guards against uploading a spreadsheet whose columns don't match the
// expected import template at all (wrong file, renamed export, hand-typed
// headers, ...). Without this, every row would just report every field as
// "required" — technically correct but useless for figuring out what's
// actually wrong. Only checks that *some* recognized column made it through;
// per-row validation still catches individually missing/invalid fields.
export function assertRecognizedColumns(rows: Record<string, string>[], expectedColumns: string[]): void {
  if (rows.length === 0) return
  const foundColumns = Object.keys(rows[0])
  const matched = expectedColumns.filter((c) => foundColumns.includes(c))
  if (matched.length === 0) {
    throw new AppError(
      `This file's column headers don't match the import template. Expected columns: ${expectedColumns.join(', ')}. Found: ${foundColumns.join(', ') || '(none)'}. Download the template and use its exact header row.`,
      400,
      'IMPORT_COLUMNS_MISMATCH'
    )
  }
}
