// Report regression checks: the financial statements agree with each other
// and with the ledger, every report renders in every format, and the
// organization's regional settings drive the formatting. Runs inside the
// caller's rolled-back transaction.
const assert = require('node:assert/strict')

module.exports = async function reportTests({ api, base, token, org, businessDate, check }) {
  const get = async (path) => {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } })
    return { status: res.status, type: res.headers.get('content-type') ?? '', buf: Buffer.from(await res.arrayBuffer()) }
  }
  const today = businessDate('Asia/Karachi').toISOString().slice(0, 10)

  // ── statements tie out
  let r = await api('GET', '/reports/profit-loss', undefined, true)
  const pl = r.data
  r = await api('GET', '/accounting/trial-balance', undefined, true)
  check('profit or loss agrees with the ledger', () => assert.ok(Math.abs(pl.netProfit - r.data.summary.netIncome) < 0.01, `${pl.netProfit} vs ${r.data.summary.netIncome}`))
  check('profit or loss is a statement with sign-off', () => { assert.equal(pl.report.kind, 'statement'); assert.equal(pl.report.format.currency, 'PKR') })
  r = await api('GET', `/reports/balance-sheet?toDate=${today}`, undefined, true)
  const bs = r.data
  check('statement of financial position balances', () => { assert.equal(r.status, 200); assert.equal(bs.balanced, true) })
  check('balance sheet has comparative column', () => assert.equal(bs.report.sections[0].columns.length, 4))
  r = await api('GET', `/reports/cash-flow?fromDate=2000-01-01&toDate=${today}`, undefined, true)
  check('cash flow statement reconciles opening to closing cash', () => { assert.equal(r.status, 200); assert.equal(r.data.reconciled, true) })
  r = await api('GET', `/reports/trial-balance?fromDate=${today}&toDate=${today}`, undefined, true)
  check('trial balance opening, movement and closing columns balance', () => { assert.equal(r.status, 200); assert.equal(r.data.balanced, true) })
  const inventoryLine = bs.position.currentAssets.find((l) => l.code === 'INVENTORY')
  r = await api('GET', `/reports/general-ledger?toDate=${today}`, undefined, true)
  const glInventory = r.data.accounts.find((a) => a.code === 'INVENTORY')
  check('general ledger closing balance equals the balance sheet', () => assert.ok(inventoryLine && glInventory && Math.abs(inventoryLine.amount - glInventory.closingBalance) < 0.01))
  r = await api('GET', `/reports/general-ledger?fromDate=${today}&toDate=${today}`, undefined, true)
  const withOpening = r.data.accounts.find((a) => a.code === 'INVENTORY')
  check('general ledger opens with the balance brought forward', () => assert.ok(withOpening && Math.abs(withOpening.closingBalance - glInventory.closingBalance) < 0.01))

  // ── every report in every format
  const keys = ['daily-sales', 'branch-sales', 'branch-profit', 'cash-closing', 'expenses', 'purchases', 'supplier-payable', 'inventory-stock', 'food-cost', 'wastage',
    'profit-loss', 'balance-sheet', 'cash-flow', 'trial-balance', 'general-ledger', 'vat-summary', 'audit-log']
  const bad = []
  for (const key of keys) {
    for (const [fmt, type, magic] of [['pdf', 'application/pdf', '%PDF'], ['excel', 'spreadsheetml', 'PK'], ['csv', 'text/csv', '﻿Report,']]) {
      const out = await get(`/reports/${key}?toDate=${today}&format=${fmt}`)
      const head = fmt === 'csv' ? out.buf.toString('utf8').slice(0, 8) : out.buf.subarray(0, magic.length).toString('latin1')
      if (out.status !== 200 || !out.type.includes(type) || head !== magic) bad.push(`${key}.${fmt} ${out.status} ${out.type}`)
    }
  }
  check('every report downloads as PDF, Excel and CSV', () => assert.deepEqual(bad, []))
  const csv = (await get(`/reports/daily-sales?toDate=${today}&format=csv`)).buf.toString('utf8')
  check('CSV is machine-readable: ISO dates, plain numbers, no page breaks', () => {
    assert.ok(/\r\nCurrency,PKR\r\n/.test(csv)); assert.ok(!/PAGE \d+/.test(csv)); assert.ok(/,\d{4}-\d{2}-\d{2},/.test(csv))
  })
  r = await api('GET', `/reports/audit-log?fromDate=${today}&toDate=${today}`, undefined, true)
  check('audit log for today includes today’s activity (local-day range)', () => assert.ok(r.data.report.kpis[0].value > 0, JSON.stringify(r.data.report.kpis[0])))

  // ── regional settings drive the formatting
  r = await api('GET', '/orgs/regions', undefined, true)
  check('country catalogue offers regional defaults', () => { const pk = r.data.regions.find((x) => x.code === 'PK'); assert.equal(pk.currency, 'PKR'); assert.equal(pk.timezone, 'Asia/Karachi') })
  r = await api('PUT', `/orgs/${org.id}`, { currency: 'ZZZ1' }, true)
  check('an unknown currency is refused', () => assert.equal(r.status, 400))
  r = await api('PUT', `/orgs/${org.id}`, { timezone: 'Mars/Olympus' }, true)
  check('an unknown time zone is refused', () => assert.equal(r.status, 400))
  r = await api('PUT', `/orgs/${org.id}`, { country: 'DE', currency: 'EUR', locale: 'de-DE', timezone: 'Europe/Berlin', dateFormat: 'DD.MM.YYYY', taxLabel: 'MwSt', fiscalYearStart: '01-01' }, true)
  check('regional settings save', () => { assert.equal(r.status, 200); assert.equal(r.data.locale, 'de-DE') })
  r = await api('GET', `/reports/vat-summary?fromDate=2026-01-01&toDate=${today}`, undefined, true)
  check('reports follow the new region', () => {
    assert.equal(r.data.report.format.currency, 'EUR'); assert.equal(r.data.report.eyebrow, 'MwSt Return Summary')
    assert.ok(/^01\.01\.2026 – \d\d\.\d\d\.\d{4}$/.test(r.data.report.periodLabel), r.data.report.periodLabel)
  })
  r = await api('PUT', `/orgs/${org.id}`, { country: 'PK', currency: 'PKR', locale: 'en-PK', timezone: 'Asia/Karachi', dateFormat: 'DD MMM YYYY', taxLabel: 'Sales Tax', fiscalYearStart: '07-01' }, true)
  check('regional settings restore', () => assert.equal(r.status, 200))
}
