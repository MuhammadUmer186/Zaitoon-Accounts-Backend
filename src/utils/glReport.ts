import { Response } from 'express'
import ExcelJS from 'exceljs'
import PDFDocument from 'pdfkit'

export interface GLReportLine {
  date: Date
  entryNo: string
  description: string
  branch: string | null
  debit: number
  credit: number
  balance: number
}

export interface GLReportAccount {
  accountId: string
  code: string
  name: string
  accountType: string
  lines: GLReportLine[]
  closingBalance: number
}

export interface GLReportData {
  generatedAt: string
  branchName: string | null
  fromDate: string | null
  toDate: string | null
  accounts: GLReportAccount[]
  totals: { debit: number; credit: number }
}

function csvEscape(value: string): string {
  if (value == null) return ''
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function fmt(n: number): string {
  return n.toFixed(2)
}

const fileStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')

export function sendGeneralLedgerCsv(res: Response, report: GLReportData): void {
  const rows: string[] = []
  rows.push('Account Code,Account Name,Date,Entry No,Branch,Description,Debit,Credit,Balance')

  for (const acc of report.accounts) {
    for (const l of acc.lines) {
      rows.push([
        acc.code,
        csvEscape(acc.name),
        l.date.toISOString().slice(0, 10),
        l.entryNo,
        csvEscape(l.branch ?? ''),
        csvEscape(l.description),
        fmt(l.debit),
        fmt(l.credit),
        fmt(l.balance),
      ].join(','))
    }
    rows.push([acc.code, csvEscape(`${acc.name} — Closing Balance`), '', '', '', '', '', '', fmt(acc.closingBalance)].join(','))
  }
  rows.push(['', '', '', '', '', 'GRAND TOTAL', fmt(report.totals.debit), fmt(report.totals.credit), ''].join(','))

  const csv = rows.join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="general-ledger-${fileStamp()}.csv"`)
  res.send(csv)
}

export async function sendGeneralLedgerExcel(res: Response, report: GLReportData): Promise<void> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Zaitoon Accounts'
  wb.created = new Date()

  const ws = wb.addWorksheet('General Ledger')
  ws.columns = [
    { header: 'Account Code', key: 'code', width: 14 },
    { header: 'Account Name', key: 'name', width: 26 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Entry No', key: 'entryNo', width: 18 },
    { header: 'Branch', key: 'branch', width: 18 },
    { header: 'Description', key: 'description', width: 36 },
    { header: 'Debit', key: 'debit', width: 14 },
    { header: 'Credit', key: 'credit', width: 14 },
    { header: 'Balance', key: 'balance', width: 14 },
  ]
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } }

  for (const acc of report.accounts) {
    for (const l of acc.lines) {
      ws.addRow({
        code: acc.code,
        name: acc.name,
        date: l.date.toISOString().slice(0, 10),
        entryNo: l.entryNo,
        branch: l.branch ?? '',
        description: l.description,
        debit: l.debit || null,
        credit: l.credit || null,
        balance: l.balance,
      })
    }
    const closingRow = ws.addRow({ name: `${acc.name} — Closing Balance`, balance: acc.closingBalance })
    closingRow.font = { bold: true, italic: true }
  }

  const grandRow = ws.addRow({ description: 'GRAND TOTAL', debit: report.totals.debit, credit: report.totals.credit })
  grandRow.font = { bold: true }

  ws.getColumn('debit').numFmt = '#,##0.00'
  ws.getColumn('credit').numFmt = '#,##0.00'
  ws.getColumn('balance').numFmt = '#,##0.00'

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="general-ledger-${fileStamp()}.xlsx"`)
  await wb.xlsx.write(res)
  res.end()
}

export function sendGeneralLedgerPdf(res: Response, report: GLReportData): void {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="general-ledger-${fileStamp()}.pdf"`)

  const doc = new PDFDocument({ margin: 40, size: 'A4' })
  doc.pipe(res)

  const cols = [
    { key: 'date', label: 'Date', x: 40, width: 55 },
    { key: 'entryNo', label: 'Entry No', x: 95, width: 75 },
    { key: 'description', label: 'Description', x: 170, width: 175 },
    { key: 'debit', label: 'Debit', x: 345, width: 60, align: 'right' as const },
    { key: 'credit', label: 'Credit', x: 405, width: 60, align: 'right' as const },
    { key: 'balance', label: 'Balance', x: 465, width: 65, align: 'right' as const },
  ]
  const pageBottom = 780

  function drawHeader() {
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#374151')
    for (const c of cols) doc.text(c.label, c.x, doc.y, { width: c.width, align: c.align ?? 'left' })
    doc.moveDown(0.4)
    doc.moveTo(40, doc.y).lineTo(530, doc.y).strokeColor('#d1d5db').stroke()
    doc.moveDown(0.3)
    doc.font('Helvetica').fillColor('#111827')
  }

  function ensureSpace(rowsNeeded = 1) {
    if (doc.y + rowsNeeded * 12 > pageBottom) {
      doc.addPage()
      drawHeader()
    }
  }

  doc.fontSize(16).font('Helvetica-Bold').text('General Ledger Report', { align: 'center' })
  doc.moveDown(0.2)
  doc.fontSize(9).font('Helvetica').fillColor('#6b7280')
  doc.text(`Generated: ${new Date(report.generatedAt).toLocaleString()}`, { align: 'center' })
  const periodText = report.fromDate || report.toDate
    ? `Period: ${report.fromDate ?? 'Inception'} to ${report.toDate ?? 'Present'}`
    : 'Period: All time'
  doc.text(periodText + (report.branchName ? ` — ${report.branchName}` : ' — All Branches'), { align: 'center' })
  doc.fillColor('#111827')
  doc.moveDown(1)

  for (const acc of report.accounts) {
    ensureSpace(3)
    doc.fontSize(11).font('Helvetica-Bold').text(`${acc.code} — ${acc.name}`, 40)
    doc.moveDown(0.3)
    drawHeader()

    doc.fontSize(8)
    for (const l of acc.lines) {
      ensureSpace(1)
      const y = doc.y
      doc.text(l.date.toISOString().slice(0, 10), cols[0].x, y, { width: cols[0].width })
      doc.text(l.entryNo, cols[1].x, y, { width: cols[1].width })
      doc.text(l.description.slice(0, 60), cols[2].x, y, { width: cols[2].width })
      doc.text(l.debit ? fmt(l.debit) : '', cols[3].x, y, { width: cols[3].width, align: 'right' })
      doc.text(l.credit ? fmt(l.credit) : '', cols[4].x, y, { width: cols[4].width, align: 'right' })
      doc.text(fmt(l.balance), cols[5].x, y, { width: cols[5].width, align: 'right' })
      doc.moveDown(0.5)
    }
    if (acc.lines.length === 0) {
      doc.fillColor('#9ca3af').text('No activity in this period', 40)
      doc.fillColor('#111827')
      doc.moveDown(0.5)
    }

    ensureSpace(1)
    doc.font('Helvetica-Bold').text(`Closing Balance: ${fmt(acc.closingBalance)}`, 40, doc.y, { width: 490, align: 'right' })
    doc.font('Helvetica')
    doc.moveDown(1)
  }

  ensureSpace(2)
  doc.moveTo(40, doc.y).lineTo(530, doc.y).strokeColor('#111827').stroke()
  doc.moveDown(0.3)
  doc.fontSize(11).font('Helvetica-Bold')
    .text(`Grand Total — Debit: ${fmt(report.totals.debit)}   Credit: ${fmt(report.totals.credit)}`, 40, doc.y, { width: 490, align: 'right' })

  doc.end()
}
