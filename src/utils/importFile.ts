import ExcelJS from 'exceljs'

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
