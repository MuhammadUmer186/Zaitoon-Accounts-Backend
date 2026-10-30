// Shared by table administration and the floor so a paid table is never
// advertised as free while QR/POS intake is waiting for staff to clear it.
export function tableStatus(table: { needsClearing: boolean; seatedAt: Date | null }, order: { billRequestedAt: Date | null } | null) {
  return order ? order.billRequestedAt ? 'bill_requested' : 'ordered'
    : table.needsClearing ? 'paid_awaiting_clear' : table.seatedAt ? 'seated' : 'free'
}
