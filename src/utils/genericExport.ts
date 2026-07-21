import { Response } from 'express'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

// A generic tabular exporter shared by every simple "list" report (daily
// sales, expenses, cash closings, wastage, audit log, ...). Structured
// reports (P&L, trial balance, balance sheet, VAT summary) flatten their
// own shape into rows before calling these, rather than each hand-rolling
// its own CSV/Excel/PDF writer.

function csvEscape(value: unknown): string {
  const s = value == null ? '' : String(value)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function humanize(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

const fileStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

export function sendRowsCsv(res: Response, rows: Record<string, unknown>[], reportName: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${reportName}-${fileStamp()}.csv"`)

  if (rows.length === 0) {
    res.send('No data for the selected filters\r\n')
    return
  }
  const cols = Object.keys(rows[0])
  const lines = [cols.map(humanize).join(',')]
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(','))
  res.send(lines.join('\r\n'))
}

export async function sendRowsExcel(res: Response, rows: Record<string, unknown>[], reportName: string, sheetTitle?: string): Promise<void> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Zaitoon Accounts'
  wb.created = new Date()
  const ws = wb.addWorksheet((sheetTitle ?? 'Report').slice(0, 31))

  const cols = rows.length > 0 ? Object.keys(rows[0]) : ['message']
  ws.columns = cols.map((c) => ({ header: humanize(c), key: c, width: 20 }))
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }

  if (rows.length === 0) ws.addRow({ message: 'No data for the selected filters' })
  else for (const r of rows) ws.addRow(r)

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${reportName}-${fileStamp()}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}

export function sendRowsPdf(res: Response, rows: Record<string, unknown>[], reportName: string, title: string): void {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${reportName}-${fileStamp()}.pdf"`)

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' })
  doc.pipe(res)

  doc.fontSize(15).font('Helvetica-Bold').text(title, { align: 'center' })
  doc.fontSize(8).font('Helvetica').fillColor('#6b7280')
  doc.text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' })
  doc.fillColor('#111827')
  doc.moveDown(0.8)

  if (rows.length === 0) {
    doc.fontSize(11).text('No data for the selected filters', { align: 'center' })
    doc.end()
    return
  }

  const cols = Object.keys(rows[0]).slice(0, 10)
  const startX = 36
  const pageWidth = 760
  const colWidth = pageWidth / cols.length
  const pageBottom = 500

  function drawHeaderRow() {
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151')
    cols.forEach((c, i) => doc.text(humanize(c), startX + i * colWidth, doc.y, { width: colWidth - 4 }))
    doc.moveDown(0.5)
    doc.moveTo(startX, doc.y).lineTo(startX + pageWidth, doc.y).strokeColor('#d1d5db').stroke()
    doc.moveDown(0.3)
    doc.font('Helvetica').fillColor('#111827')
  }

  drawHeaderRow()
  for (const r of rows) {
    if (doc.y > pageBottom) {
      doc.addPage()
      drawHeaderRow()
    }
    const y = doc.y
    cols.forEach((c, i) => {
      const v = r[c]
      const text = typeof v === 'number' ? v.toFixed(2) : String(v ?? '')
      doc.fontSize(7).text(text.slice(0, 45), startX + i * colWidth, y, { width: colWidth - 4 })
    })
    doc.moveDown(0.7)
  }
  doc.end()
}

// Dispatches to the right exporter based on the ?format= query value.
// Returns true if it handled (and sent) the response.
export async function tryExportRows(res: Response, format: string | undefined, rows: Record<string, unknown>[], reportName: string, title: string): Promise<boolean> {
  if (format === 'csv') { sendRowsCsv(res, rows, reportName); return true }
  if (format === 'excel') { await sendRowsExcel(res, rows, reportName, title); return true }
  if (format === 'pdf') { sendRowsPdf(res, rows, reportName, title); return true }
  return false
}
