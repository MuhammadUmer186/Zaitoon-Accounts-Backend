import { AppError } from '../middleware/error'

// Settings → Table service: a branch can switch its whole table system off
// (Branch.tableOrderingEnabled). The POS then takes dine-in orders without a
// table, and the floor plan, waiter screen, table moves and table QR ordering
// are unavailable.
export const TABLES_OFF_MESSAGE = 'Table service is switched off for this branch (Settings → Table Service). Take the dine-in order without a table.'

export function assertTableService(branch: { tableOrderingEnabled: boolean }) {
  if (!branch.tableOrderingEnabled) throw new AppError(TABLES_OFF_MESSAGE, 409, 'TABLES_DISABLED')
}
