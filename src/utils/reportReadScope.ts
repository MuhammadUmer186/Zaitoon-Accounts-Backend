import { AsyncLocalStorage } from 'node:async_hooks'

// Scope the complete report call chain, including shared financial helpers.
export const reportReadScope = new AsyncLocalStorage<{ organizationId: string; branchIds?: string[] }>()
