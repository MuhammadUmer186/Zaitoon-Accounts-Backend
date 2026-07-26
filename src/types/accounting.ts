// Account.accountClass / Account.normalBalance are plain String columns in
// Postgres (see schema.prisma for why — db push cannot safely convert an
// existing populated String column to a native enum without data loss).
// These are the TS-level contracts application code validates against.
export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
export type NormalBalance = 'DEBIT' | 'CREDIT'

export const ACCOUNT_CLASSES: AccountClass[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']
