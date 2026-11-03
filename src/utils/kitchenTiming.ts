// Preserve first arrival times. Recalling a served line clears servedAt.
export function kitchenTiming(status: string, line: { preparingAt?: Date | null; readyAt?: Date | null; servedAt?: Date | null }, now = new Date()) {
  if (status === 'preparing') return { preparingAt: line.preparingAt ?? now, servedAt: null }
  if (status === 'ready') return { readyAt: line.readyAt ?? now, servedAt: null }
  if (status === 'served') return { servedAt: line.servedAt ?? now }
  return {}
}
