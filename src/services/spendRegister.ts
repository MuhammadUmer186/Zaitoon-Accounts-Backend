import { roundMoney } from '../utils/money'
export interface SpendRow {
  id: string; kind: 'purchase' | 'expense' | 'maintenance' | 'payment'; reference: string; date: Date
  branchId: string; branchName: string; categoryName: string; description: string
  totalAmount: number; paidAmount: number; balanceDue: number
  approvalStatus: string; paymentStatus: string; href: string
}

export function paymentStatus(total: number, paid: number) {
  return paid >= total && total > 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid'
}

// Payment receipts deliberately never enter this total. A bill is counted
// once, regardless of how many instalments settle it. Maintenance is a slice
// of operating expenses, reported on its own but already inside `expenses`.
export function spendSummary(purchases: { total: number; paid: number; due: number }, expenses: { total: number; paid: number; due: number }, maintenance = 0) {
  const round = roundMoney
  return { purchases: round(purchases.total), expenses: round(expenses.total), maintenance: round(maintenance),
    total: round(purchases.total + expenses.total), paid: round(purchases.paid + expenses.paid),
    due: round(purchases.due + expenses.due) }
}
