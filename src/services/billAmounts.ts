import { AppError } from '../middleware/error'

const round = (n: number) => Math.round(n * 100) / 100
export interface BillAmountsInput {
  subtotal: number
  discountAmount: number
  vatAmount: number
  totalAmount: number
  items?: { description: string; quantity: number; unitPrice: number; vatRate: number; vatAmount: number; totalAmount: number; itemId?: string | null; accountId?: string | null }[]
}

export function validateBillAmounts(bill: BillAmountsInput) {
  for (const value of [bill.subtotal, bill.discountAmount, bill.vatAmount, bill.totalAmount]) {
    if (!Number.isFinite(value) || value < 0) throw new AppError('Invalid bill amount', 400, 'VALIDATION_ERROR')
  }
  if (bill.discountAmount > bill.subtotal || Math.round((bill.subtotal - bill.discountAmount + bill.vatAmount) * 100) !== Math.round(bill.totalAmount * 100)) {
    throw new AppError('Bill subtotal, discount, VAT and total do not reconcile', 400, 'BILL_TOTAL_MISMATCH')
  }
  if (!bill.items?.length) return []
  const amounts = bill.items.map((line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0 || !Number.isFinite(line.unitPrice) || line.unitPrice < 0 || !Number.isFinite(line.vatRate) || line.vatRate < 0 || line.vatRate > 100) throw new AppError('Invalid bill line quantity, cost or tax rate', 400, 'VALIDATION_ERROR')
    return round(line.quantity * line.unitPrice)
  })
  const subtotal = round(amounts.reduce((sum, value) => sum + value, 0))
  if (Math.round(subtotal * 100) !== Math.round(bill.subtotal * 100)) throw new AppError('Bill lines do not reconcile to subtotal', 400, 'BILL_TOTAL_MISMATCH')
  let cumulative = 0, allocated = 0
  const lines = bill.items.map((line, index) => {
    cumulative = round(cumulative + amounts[index])
    const targetDiscount = round(subtotal > 0 ? bill.discountAmount * cumulative / subtotal : 0)
    const discount = round(targetDiscount - allocated)
    allocated = targetDiscount
    const net = round(amounts[index] - discount)
    const vat = round(net * line.vatRate / 100)
    if (net < 0 || Math.abs(round(line.vatAmount) - vat) > 0.01 || Math.abs(round(line.totalAmount) - round(net + vat)) > 0.01) throw new AppError('Bill line tax or total does not reconcile', 400, 'BILL_TOTAL_MISMATCH')
    return { ...line, netAmount: net, vatAmount: vat, totalAmount: round(net + vat) }
  })
  if (Math.abs(round(lines.reduce((sum, line) => sum + line.vatAmount, 0)) - round(bill.vatAmount)) > 0.01) throw new AppError('Bill line VAT does not reconcile to header', 400, 'BILL_TOTAL_MISMATCH')
  return lines
}
