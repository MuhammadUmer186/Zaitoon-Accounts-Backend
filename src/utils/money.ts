import { AsyncLocalStorage } from 'node:async_hooks'
import { currencyDecimals } from './regions'

// Scoped to an operation/request; one restaurant's currency must never leak
// into another concurrent request. Background jobs can pass a currency.
const currencies = new AsyncLocalStorage<string>()
export const runWithCurrency = <T>(currency: string, fn: () => T): T => currencies.run(currency, fn)
export const currentCurrency = () => currencies.getStore() ?? 'PKR'
export const moneyFactor = (currency = currentCurrency()) => 10 ** currencyDecimals(currency)
export const moneyUnit = (currency = currentCurrency()) => 1 / moneyFactor(currency)
export const moneyTolerance = (currency = currentCurrency()) => moneyUnit(currency) / 2
export const roundMoney = (amount: number, currency = currentCurrency()) => {
  const factor = moneyFactor(currency)
  return Math.round((amount + Number.EPSILON) * factor) / factor
}
export const validMoneyPrecision = (amount: number, currency = currentCurrency()) => Number.isFinite(amount) && Math.abs(amount - roundMoney(amount, currency)) < 0.0000001
