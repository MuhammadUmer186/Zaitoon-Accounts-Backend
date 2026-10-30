// ZATCA e-invoicing checks. The ZATCA API is replaced by a stub that issues a
// self-signed secp256k1 certificate, so the suite runs offline; set
// ZATCA_SANDBOX=1 to run onboarding and reporting against ZATCA's sandbox.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')

function selfSignedBody() {
  const rs = require('jsrsasign')
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const cert = new rs.KJUR.asn1.x509.Certificate({
    version: 3, serial: { int: 4242 }, issuer: { str: '/CN=TestCA' }, subject: { str: '/CN=Test EGS' },
    notbefore: '250101000000Z', notafter: '351231235959Z',
    sbjpubkey: publicKey.export({ type: 'spki', format: 'pem' }), sigalg: 'SHA256withECDSA',
    cakey: privateKey.export({ type: 'sec1', format: 'pem' }),
  })
  return cert.getPEM().replace(/-----[^-]+-----|\s/g, '')
}

const parseTlv = (b64) => {
  const b = Buffer.from(b64, 'base64'); const out = {}
  for (let i = 0; i < b.length;) { const t = b[i], l = b[i + 1]; out[t] = b.subarray(i + 2, i + 2 + l); i += 2 + l }
  return out
}

module.exports = async function zatcaTests({ tx, api, signAccessToken, check }) {
  const live = process.env.ZATCA_SANDBOX === '1'
  const apiModule = require('../dist/services/zatca/api')
  const realApi = { ...apiModule.zatcaApi }
  const token = Buffer.from(selfSignedBody()).toString('base64')
  let reportReply = { status: 200, ok: true, data: { reportingStatus: 'REPORTED', validationResults: { status: 'PASS', warningMessages: [] } }, text: '' }
  const reported = []
  if (!live) {
    Object.assign(apiModule.zatcaApi, {
      complianceCsid: async (_env, csr, otp) => (otp === '000000' ? { status: 400, ok: false, data: { message: 'Invalid OTP' }, text: '' } : { status: 200, ok: true, data: { binarySecurityToken: token, secret: 's3cret', requestID: 77, csr }, text: '' }),
      complianceInvoice: async () => ({ status: 200, ok: true, data: { validationResults: { status: 'PASS' } }, text: '' }),
      productionCsid: async () => ({ status: 200, ok: true, data: { binarySecurityToken: token, secret: 'pr0d', requestID: 78 }, text: '' }),
      report: async (_env, _t, _s, doc) => { reported.push(doc); return reportReply },
    })
  }

  try {
    const org = await tx.organization.create({ data: { requireTillForCash: false, name: 'Shawarma House Co', tradeName: 'Shawarma House', country: 'SA', currency: 'SAR', timezone: 'Asia/Riyadh', locale: 'en-SA', taxLabel: 'VAT' } })
    const branch = await tx.branch.create({ data: { organizationId: org.id, name: 'Olaya', code: 'OLY', vatRate: 15 } })
    const other = await tx.branch.create({ data: { organizationId: org.id, name: 'Malaz', code: 'MLZ', vatRate: 15 } })
    const user = await tx.user.create({ data: { organizationId: org.id, email: 'zatca@example.invalid', passwordHash: 'x', firstName: 'Z', lastName: 'Admin' } })
    const role = await tx.role.create({ data: { organizationId: org.id, name: 'super_admin', displayName: 'SA' } })
    await tx.userRole.create({ data: { roleId: role.id, userId: user.id } })
    const t = signAccessToken(user.id, org.id, user.email)
    const shift = await tx.menuShift.create({ data: { organizationId: org.id, name: 'All day', startTime: '00:00', endTime: '00:00' } })
    const cat = await tx.menuCategory.create({ data: { organizationId: org.id, name: 'Menu' } })
    const dish = await tx.dish.create({ data: { organizationId: org.id, categoryId: cat.id, name: 'Chicken Shawarma', price: 17.25, shifts: { create: { shiftId: shift.id } } } })
    const sell = async (branchId, qty = 2) => {
      const o = await api('POST', '/pos/orders', { branchId, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: qty }] }, t)
      assert.equal(o.status, 201, JSON.stringify(o.data))
      return api('POST', `/orders/${o.data.id}/complete`, { paymentMethod: 'card' }, t)
    }

    let r = await api('PUT', '/zatca/settings', { zatcaEnabled: true }, t)
    check('e-invoicing cannot start without VAT and CR numbers', () => assert.equal(r.status, 400))
    r = await api('PUT', '/zatca/settings', { vatNumber: '123', crNumber: '1010010000' }, t)
    check('an invalid VAT registration number is refused', () => assert.equal(r.status, 400))
    r = await api('PUT', '/zatca/settings', { vatNumber: '399999999900003', crNumber: '1010010000', zatcaEnabled: true }, t)
    check('ZATCA settings save', () => { assert.equal(r.status, 200); assert.equal(r.data.zatcaEnabled, true) })
    const address = { street: 'King Fahd Road', building: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211' }
    r = await api('POST', '/zatca/devices', { branchId: branch.id, environment: 'sandbox', otp: '12345', ...address }, t)
    check('the OTP must be 6 digits', () => assert.equal(r.status, 400))
    r = await api('POST', '/zatca/devices', { branchId: branch.id, environment: 'sandbox', otp: '123345', ...address, building: '12' }, t)
    check('a 4-digit building number is required', () => assert.equal(r.status, 400))
    if (!live) {
      r = await api('POST', '/zatca/devices', { branchId: branch.id, environment: 'sandbox', otp: '000000', ...address }, t)
      check('a refused OTP leaves the device failed with the reason', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Invalid OTP/) })
    }
    r = await api('POST', '/zatca/devices', { branchId: branch.id, environment: 'sandbox', otp: '123345', ...address }, t)
    check('branch onboarding completes compliance checks and issues the production CSID', () => {
      assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.device.status, 'active')
      assert.equal(r.data.log.filter((s) => s.step.startsWith('Compliance check passed')).length, 3)
    })
    const device = await tx.zatcaDevice.findUnique({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } } })
    check('device secrets are stored encrypted', () => { assert.ok(!device.privateKeySealed.includes('PRIVATE KEY')); assert.ok(!device.productionSecretSealed.includes('pr0d')) })

    // ── invoices on payment
    r = await sell(branch.id)
    const first = r.data.zatcaDocuments?.[0]
    check('a paid order gets a simplified tax invoice with QR', () => { assert.equal(r.status, 200); assert.ok(first); assert.equal(first.type, 'invoice'); assert.ok(first.qr) })
    const tags = parseTlv(first.qr)
    check('QR carries seller, VAT number, time, total, VAT, hash and the stamp', () => {
      assert.equal(tags[1].toString(), 'Shawarma House Co'); assert.equal(tags[2].toString(), '399999999900003')
      assert.match(tags[3].toString(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/); assert.equal(tags[4].toString(), '34.50'); assert.equal(tags[5].toString(), '4.50')
      assert.ok(tags[6] && tags[7] && tags[8] && tags[9])
    })
    const doc1 = await tx.zatcaDocument.findFirst({ where: { orderId: r.data.id } })
    r = await sell(branch.id, 3)
    const doc2 = await tx.zatcaDocument.findFirst({ where: { orderId: r.data.id } })
    check('invoices are counted and hash-chained per device', () => { assert.equal(doc1.icv, 1); assert.equal(doc2.icv, 2); assert.equal(doc2.previousHash, doc1.hash) })
    check('the XML is a signed UBL simplified invoice', () => {
      for (const s of ['<cbc:ProfileID>reporting:1.0</cbc:ProfileID>', 'name="0200000">388<', '<ds:SignatureValue>', `<cbc:UUID>${doc2.icv}</cbc:UUID>`, '<cbc:PayableAmount currencyID="SAR">51.75</cbc:PayableAmount>']) assert.ok(doc2.xml.includes(s), s)
    })
    {
      // halala rounding: 4 x 1400 inclusive = 5599.99 + 0.01 rounding; the QR
      // total (tag 4) must be the amount due (BT-115), not TaxInclusiveAmount
      const { signInvoice } = require('../dist/services/zatca/invoice.js')
      const zc = require('../dist/services/zatca/crypto.js')
      const signed = signInvoice({
        type: 'invoice', invoiceNo: 'R-1', uuid: crypto.randomUUID(), icv: 1, previousHash: zc.FIRST_PREVIOUS_HASH, issuedAt: { date: '2026-10-16', time: '19:08:00' },
        seller: { name: 'Shawarma House Co', vatNumber: '399999999900003', crn: '1010010000', street: 'King Fahd Road', building: '1234', district: 'Al Olaya', city: 'Riyadh', postalCode: '12211' },
        lines: [{ name: 'Platter', quantity: 4, unitPriceInclusive: 1400 }], discountInclusive: 0, vatRate: 15, paymentMeans: '10', payableInclusive: 5600,
      }, zc.certificateInfo(selfSignedBody()), zc.generateKeyPair().privateKeyPem)
      const qrTags = parseTlv(signed.qr)
      check('with halala rounding the QR total is the amount due', () => {
        assert.equal(qrTags[4].toString(), '5600.00'); assert.equal(qrTags[5].toString(), '730.43')
        for (const x of ['<cbc:TaxInclusiveAmount currencyID="SAR">5599.99<', '<cbc:PayableRoundingAmount currencyID="SAR">0.01<', '<cbc:PayableAmount currencyID="SAR">5600.00<']) assert.ok(signed.xml.includes(x), x)
      })
    }
    await new Promise((res) => setTimeout(res, live ? 4000 : 100))
    const afterReport = await tx.zatcaDocument.findUnique({ where: { id: doc1.id } })
    check('invoices are reported to ZATCA', () => assert.equal(afterReport.status, 'reported', JSON.stringify(afterReport.response)))

    // ── refunds are credit notes
    r = await api('POST', `/orders/${doc2.orderId}/refund`, { reason: 'Wrong order' }, t)
    const credit = await tx.zatcaDocument.findFirst({ where: { orderId: doc2.orderId, type: 'credit' } })
    check('a refund issues a credit note referencing the invoice', () => {
      assert.equal(r.status, 200); assert.ok(credit); assert.equal(credit.icv, 3); assert.equal(credit.previousHash, doc2.hash)
      assert.ok(credit.xml.includes(`<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${doc2.invoiceNo}</cbc:ID>`)); assert.ok(credit.xml.includes('>381<'))
      assert.ok(credit.xml.includes('<cbc:InstructionNote>Wrong order</cbc:InstructionNote>'))
    })
    await new Promise((res) => setTimeout(res, live ? 4000 : 100))
    const creditReported = await tx.zatcaDocument.findUnique({ where: { id: credit.id } })
    check('the credit note is reported to ZATCA', () => assert.equal(creditReported.status, 'reported', JSON.stringify(creditReported.response)))

    if (!live) {
      // ── reporting queue: retry transient failures, stop on rejection
      reportReply = { status: 503, ok: false, data: null, text: 'Service unavailable' }
      r = await sell(branch.id, 1)
      await new Promise((res) => setTimeout(res, 100))
      const failed = await tx.zatcaDocument.findFirst({ where: { orderId: r.data.id } })
      check('a ZATCA outage leaves the invoice queued for retry', () => { assert.equal(failed.status, 'failed'); assert.ok(failed.nextAttemptAt > new Date()) })
      reportReply = { status: 200, ok: true, data: { reportingStatus: 'REPORTED', validationResults: { status: 'PASS', warningMessages: [] } }, text: '' }
      r = await api('POST', `/zatca/documents/${failed.id}/report`, {}, t)
      check('a queued invoice reports once ZATCA is back', () => assert.equal(r.data.status, 'reported'))
      reportReply = { status: 400, ok: false, data: { validationResults: { errorMessages: [{ code: 'X', message: 'bad' }] } }, text: '' }
      r = await sell(branch.id, 1)
      await new Promise((res) => setTimeout(res, 100))
      const rejected = await tx.zatcaDocument.findFirst({ where: { orderId: r.data.id } })
      check('a rejected invoice is not retried and keeps ZATCA’s reason', () => { assert.equal(rejected.status, 'rejected'); assert.equal(rejected.response.validationResults.errorMessages[0].code, 'X') })
    }

    r = await sell(other.id)
    check('a branch that is not onboarded issues no e-invoice', () => assert.equal(r.data.zatcaDocuments.length, 0))
    r = await api('GET', '/zatca', undefined, t)
    check('the ZATCA screen lists devices and the queue', () => { assert.equal(r.status, 200); assert.equal(r.data.branches.find((b) => b.id === branch.id).device.status, 'active'); assert.ok(r.data.queue.reported >= 1) })
    r = await api('GET', '/zatca/documents', undefined, t)
    check('documents list without exposing the XML', () => { assert.ok(r.data.total >= 3); assert.equal(r.data.data[0].xml, undefined) })
    if (!live) reportReply = { status: 200, ok: true, data: { reportingStatus: 'REPORTED', validationResults: { status: 'PASS', warningMessages: [] } }, text: '' }
    const offlineDevice = crypto.randomUUID()
    const offlineBoot = await api('POST', '/pos/offline/bootstrap', { deviceId: offlineDevice, branchId: branch.id, name: 'Offline KSA' }, t)
    const recordedAt = new Date(Date.now() - 30000).toISOString()
    const offlineSale = { clientUuid: crypto.randomUUID(), deviceId: offlineDevice, sequence: 1, lease: offlineBoot.data.lease, createdAt: recordedAt, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 2 }], expectedTotal: 34.5, vatRate: 15, payment: { paidAt: recordedAt, payments: [{ method: 'card', amount: 34.5 }] } }
    r = await api('POST', '/pos/orders/sync', { orders: [offlineSale] }, t)
    const synced = r.data.results[0]
    const offlineInvoice = await tx.zatcaDocument.findFirst({ where: { orderId: synced.order?.id, type: 'invoice' } })
    check('KSA offline payment gets its signed QR on sync with the original payment time', () => {
      assert.equal(synced.status, 'synced', JSON.stringify(synced)); assert.equal(synced.fiscalPending, false)
      assert.ok(offlineInvoice?.qr); assert.equal(offlineInvoice.issuedAt.toISOString(), recordedAt)
      assert.equal(parseTlv(offlineInvoice.qr)[4].toString(), '34.50')
    })
    const afterOffline = await tx.zatcaDevice.findUniqueOrThrow({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } } })
    r = await api('POST', '/pos/orders/sync', { orders: [offlineSale] }, t)
    const invoiceCount = await tx.zatcaDocument.count({ where: { orderId: synced.order.id, type: 'invoice' } })
    const afterRetry = await tx.zatcaDevice.findUniqueOrThrow({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } } })
    check('an offline sync replay preserves one fiscal document and one hash-chain counter', () => {
      assert.equal(r.data.results[0].duplicate, true); assert.equal(invoiceCount, 1); assert.equal(afterRetry.icv, afterOffline.icv); assert.equal(afterRetry.lastInvoiceHash, afterOffline.lastInvoiceHash)
    })
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const offlineReported = await tx.zatcaDocument.findUniqueOrThrow({ where: { id: offlineInvoice.id } })
    check('the offline invoice reports through the existing ZATCA queue', () => assert.equal(offlineReported.status, 'reported', JSON.stringify(offlineReported.response)))
    const deliveryZone = await tx.deliveryZone.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Invoice delivery', fee: 11.5, minimumOrder: 0, etaMinutes: 30 } })
    const deliveredSale = async (zoneId) => {
      const created = await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'delivery', deliveryZoneId: zoneId, deliveryAddress: 'House 14, Test Road', items: [{ dishId: dish.id, quantity: 2 }] }, t)
      assert.equal(created.status, 201, JSON.stringify(created.data))
      const paid = await api('POST', `/orders/${created.data.id}/complete`, { paymentMethod: 'card' }, t)
      assert.equal(paid.status, 200, JSON.stringify(paid.data))
      return tx.zatcaDocument.findFirstOrThrow({ where: { orderId: created.data.id, type: 'invoice' } })
    }
    const withCharge = await deliveredSale(deliveryZone.id)
    check('KSA delivery is a document charge with reconciled VAT, payable and QR', () => {
      assert.ok(withCharge.xml.includes('<cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>FC</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Delivery</cbc:AllowanceChargeReason><cbc:Amount currencyID="SAR">10.00</cbc:Amount>'))
      assert.ok(withCharge.xml.includes('<cbc:ChargeTotalAmount currencyID="SAR">10.00</cbc:ChargeTotalAmount>'))
      assert.equal(parseTlv(withCharge.qr)[4].toString(), '46.00'); assert.equal(parseTlv(withCharge.qr)[5].toString(), '6.00')
    })
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const chargeReported = await tx.zatcaDocument.findUniqueOrThrow({ where: { id: withCharge.id } })
    check('ZATCA accepts the invoice containing a delivery charge', () => assert.equal(chargeReported.status, 'reported', JSON.stringify(chargeReported.response)))
    await tx.deliveryZone.update({ where: { id: deliveryZone.id }, data: { fee: 99 } })
    r = await api('POST', `/orders/${withCharge.orderId}/refund`, { reason: 'Delivery returned' }, t)
    const chargeCredit = await tx.zatcaDocument.findFirstOrThrow({ where: { orderId: withCharge.orderId, type: 'credit' } })
    check('a delivery credit note reverses the billed charge after zone prices change', () => { assert.equal(r.status, 200); assert.equal(chargeCredit.totalAmount, 46); assert.ok(chargeCredit.xml.includes('<cbc:ChargeTotalAmount currencyID="SAR">10.00</cbc:ChargeTotalAmount>')) })
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const creditChargeReported = await tx.zatcaDocument.findUniqueOrThrow({ where: { id: chargeCredit.id } })
    check('ZATCA accepts the delivery credit note', () => assert.equal(creditChargeReported.status, 'reported', JSON.stringify(creditChargeReported.response)))
    const mixedZone = await tx.deliveryZone.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Configured exempt charge', fee: 10, minimumOrder: 0, etaMinutes: 30, feeVatRate: 0, feeTaxCategory: 'E', feeTaxReasonCode: 'VATEX-SA-29', feeTaxReason: 'Financial services mentioned in Article 29 of the VAT Regulations' } })
    const mixed = await deliveredSale(mixedZone.id)
    check('separately configured charge tax gets its own fiscal VAT breakdown', () => { assert.equal((mixed.xml.match(/<cac:TaxSubtotal>/g) || []).length, 2); assert.equal(mixed.totalAmount, 44.5); assert.equal(mixed.vatAmount, 4.5); assert.ok(mixed.xml.includes('<cbc:TaxExemptionReasonCode>VATEX-SA-29</cbc:TaxExemptionReasonCode>')) })
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const mixedReported = await tx.zatcaDocument.findUniqueOrThrow({ where: { id: mixed.id } })
    check('ZATCA accepts the configured mixed-tax delivery charge', () => assert.equal(mixedReported.status, 'reported', JSON.stringify(mixedReported.response)))

    // ── a COD delivery whose e-invoice fails to issue stays visible and retryable
    for (const key of ['can_take_call_center_orders', 'can_manage_delivery']) await tx.permission.upsert({ where: { key }, create: { key, module: key === 'can_manage_delivery' ? 'delivery' : 'call_center' }, update: {} })
    const rider = await tx.rider.create({ data: { organizationId: org.id, branchId: branch.id, name: 'KSA rider', phone: '+966500000001' } })
    const cod = await api('POST', '/call-center/orders', { requestId: crypto.randomUUID(), orderType: 'delivery', deliveryZoneId: deliveryZone.id, deliveryAddress: 'House 14, Test Road', deliveryPaymentMode: 'cod', customerName: 'Noura', customerPhone: '0500000002', items: [{ dishId: dish.id, quantity: 2 }] }, t)
    check('a KSA call-centre COD order is accepted', () => assert.equal(cod.status, 201, JSON.stringify(cod.data)))
    const codId = cod.data.order.id
    await api('POST', `/delivery/orders/${codId}/status`, { status: 'assigned', riderId: rider.id }, t)
    await tx.customerOrderItem.updateMany({ where: { orderId: codId }, data: { status: 'ready' } })
    // Historical already-dispatched COD fixture for invoice recovery tests.
    await tx.customerOrder.update({ where: { id: codId }, data: { deliveryPaymentMode: 'cod', deliveryStatus: 'picked_up', dispatchedAt: new Date() } })
    const goodToken = (await tx.zatcaDevice.findUniqueOrThrow({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } } })).productionToken
    await tx.zatcaDevice.update({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } }, data: { productionToken: 'not-a-certificate' } })
    r = await api('POST', `/delivery/orders/${codId}/status`, { status: 'delivered', cashCollected: cod.data.order.totalAmount }, t)
    const noInvoice = await tx.zatcaDocument.count({ where: { orderId: codId } })
    check('a failed e-invoice after COD delivery keeps the sale and tells the dispatcher', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.order.status, 'completed'); assert.equal(r.data.invoicePending, true); assert.equal(noInvoice, 0) })
    r = await api('GET', '/zatca/unissued', undefined, t)
    check('the paid order without an e-invoice is listed as not issued', () => { assert.equal(r.status, 200); assert.deepEqual(r.data.data.map((o) => [o.id, o.type]), [[codId, 'invoice']]) })
    r = await api('POST', `/zatca/orders/${codId}/issue`, { type: 'invoice' }, t)
    check('issuing while signing still fails reports the reason and creates nothing', () => { assert.equal(r.data.code, 'ZATCA_ISSUE_FAILED') })
    await tx.zatcaDevice.update({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } }, data: { productionToken: goodToken } })
    r = await api('POST', `/zatca/orders/${codId}/issue`, { type: 'invoice' }, t)
    const reissued = r.data
    const again = await api('POST', `/zatca/orders/${codId}/issue`, { type: 'invoice' }, t)
    const [codInvoices, codPayments, codCollections] = await Promise.all([
      tx.zatcaDocument.count({ where: { orderId: codId, type: 'invoice' } }),
      tx.tillPayment.count({ where: { orderId: codId, type: 'sale' } }),
      tx.riderCashCollection.count({ where: { orderId: codId } }),
    ])
    check('issuing again creates one invoice without another payment or cash collection', () => {
      assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(reissued.type, 'invoice'); assert.equal(again.data.id, reissued.id)
      assert.equal(codInvoices, 1); assert.equal(codPayments, 1); assert.equal(codCollections, 1)
      assert.equal(parseTlv(reissued.qr)[4].toString(), cod.data.order.totalAmount.toFixed(2))
    })
    r = await api('GET', '/zatca/unissued', undefined, t)
    check('an issued order leaves the not-issued list', () => assert.equal(r.data.data.length, 0))
    r = await api('POST', `/zatca/orders/${codId}/issue`, { type: 'credit' }, t)
    check('a credit note is only issued for a refunded order', () => assert.equal(r.data.code, 'INVALID_STATUS'))
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const reissuedReported = await tx.zatcaDocument.findUniqueOrThrow({ where: { id: reissued.id } })
    check('ZATCA accepts the re-issued COD delivery invoice', () => assert.equal(reissuedReported.status, 'reported', JSON.stringify(reissuedReported.response)))
    const checkTable = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'Split test', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
    r = await api('POST', '/pos/orders', { branchId: branch.id, tableId: checkTable.id, guestCount: 3, orderType: 'dine_in', items: [{ dishId: dish.id, quantity: 3 }] }, t)
    const splitOrderId = r.data.id
    r = await api('POST', `/orders/${splitOrderId}/checks`, { mode: 'equal', count: 3, discountAmount: 0.01, discountReason: 'Rounding discount' }, t)
    const checks = r.data.checks
    check('KSA split creates checks with a reconciled fiscal snapshot', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(checks.length, 3) })
    for (const c of checks) {
      r = await api('POST', `/orders/${splitOrderId}/checks/${c.id}/pay`, { payments: [{ method: 'card', amount: c.totalAmount }] }, t)
      check(`KSA check ${c.number} is paid with its own signed invoice`, () => { assert.equal(r.status, 200, JSON.stringify(r.data)); const signed = r.data.checks.find((x) => x.id === c.id).zatcaDocuments[0]; assert.ok(signed.invoiceNo.endsWith(`-C${c.number}`)); assert.equal(Number(parseTlv(signed.qr)[4].toString()), c.totalAmount); assert.equal(Number(parseTlv(signed.qr)[5].toString()), c.vatAmount) })
    }
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const checkDocs = await tx.zatcaDocument.findMany({ where: { orderId: splitOrderId, type: 'invoice' } })
    check('all paid checks are reported with no extra parent invoice', () => { assert.equal(checkDocs.length, 3); assert.ok(checkDocs.every((d) => d.checkId && d.status === 'reported'), JSON.stringify(checkDocs.map((d) => d.response))) })
    r = await api('POST', `/orders/${splitOrderId}/refund`, { reason: 'Table returned the meals' }, t)
    check('split refund succeeds before Daily Sales is finalized', () => assert.equal(r.status, 200, JSON.stringify(r.data)))
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const credits = await tx.zatcaDocument.findMany({ where: { orderId: splitOrderId, type: 'credit' } })
    check('each refunded check receives a reported credit against its own invoice', () => { assert.equal(credits.length, 3); for (const d of credits) { assert.equal(d.status, 'reported', JSON.stringify(d.response)); const original = checkDocs.find((o) => o.checkId === d.checkId); assert.equal(d.totalAmount, original.totalAmount); assert.ok(d.xml.includes(`<cbc:ID>${original.invoiceNo}</cbc:ID>`)) } })

    // ── Phase 6: a promotion is part of the invoice discount; a house account is a credit sale
    const ksaPromo = (await api('POST', '/promotions', { name: 'KSA 10%', type: 'percent', value: 10 }, t)).data
    const promoOrder = (await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 2 }] }, t)).data
    const promoPaid = await api('POST', `/orders/${promoOrder.id}/complete`, { paymentMethod: 'card' }, t)
    const promoDoc = await tx.zatcaDocument.findFirstOrThrow({ where: { orderId: promoOrder.id, type: 'invoice' } })
    check('a promotion is the invoice discount and the QR total is what was paid', () => {
      assert.equal(promoPaid.status, 200, JSON.stringify(promoPaid.data)); assert.equal(promoPaid.data.totalAmount, 31.05)
      assert.equal(parseTlv(promoDoc.qr)[4].toString(), '31.05'); assert.ok(promoDoc.xml.includes('<cbc:AllowanceTotalAmount currencyID="SAR">3.00</cbc:AllowanceTotalAmount>'))
    })
    await api('PUT', `/promotions/${ksaPromo.id}`, { name: ksaPromo.name, type: 'percent', value: 10, isActive: false }, t)
    const accountGuest = await tx.customer.create({ data: { organizationId: org.id, phone: '+966500000099', name: 'Account guest', houseAccountEnabled: true, creditLimit: 1000 } })
    const houseOrder = (await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, t)).data
    const housePaid = await api('POST', `/orders/${houseOrder.id}/complete`, { paymentMethod: 'house_account', customerId: accountGuest.id }, t)
    const houseDoc = await tx.zatcaDocument.findFirstOrThrow({ where: { orderId: houseOrder.id, type: 'invoice' } })
    check('a house account sale is invoiced as a credit sale', () => { assert.equal(housePaid.status, 200, JSON.stringify(housePaid.data)); assert.ok(houseDoc.xml.includes('<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>')) })
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const phase6Docs = await tx.zatcaDocument.findMany({ where: { id: { in: [promoDoc.id, houseDoc.id] } } })
    check('ZATCA accepts the promotion and house account invoices', () => { assert.equal(phase6Docs.length, 2); for (const d of phase6Docs) assert.equal(d.status, 'reported', JSON.stringify(d.response)) })

    // ── payments: checks paid by table QR through the (sandbox) integration
    // still get exactly one signed invoice each, and no parent invoice
    await api('PUT', '/commerce-settings', { loyaltyEarnPerUnit: 0, loyaltyPointValue: 0, promotionsStack: false, providerName: '', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '', paymentAdapter: 'simulator' }, t)
    const qrTable = await tx.diningTable.create({ data: { organizationId: org.id, branchId: branch.id, name: 'QR pay', orderToken: crypto.randomUUID(), reviewToken: crypto.randomUUID() } })
    const qrOrder = (await api('POST', '/pos/orders', { branchId: branch.id, tableId: qrTable.id, guestCount: 2, orderType: 'dine_in', items: [{ dishId: dish.id, quantity: 2 }] }, t)).data
    await tx.customerOrderItem.updateMany({ where: { orderId: qrOrder.id }, data: { status: 'served' } })
    r = await api('POST', `/public/checkout/tables/${qrTable.orderToken}/split`, { mode: 'equal', count: 2 })
    const qrChecks = r.data.checks
    check('KSA guests split the bill from the table', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(qrChecks.length, 2) })
    for (const c of qrChecks) {
      const started = (await api('POST', `/public/checkout/tables/${qrTable.orderToken}/pay`, { checkId: c.id })).data
      r = await api('POST', `/public/payments/${started.id}/simulate`, { t: started.accessToken, outcome: 'approve' })
      check(`KSA check ${c.number} paid by QR is settled`, () => assert.equal(r.data.status, 'succeeded', JSON.stringify(r.data)))
    }
    await new Promise((resolve) => setTimeout(resolve, live ? 4000 : 100))
    const qrDocs = await tx.zatcaDocument.findMany({ where: { orderId: qrOrder.id, type: 'invoice' } })
    const qrClosed = await tx.customerOrder.findUniqueOrThrow({ where: { id: qrOrder.id } })
    check('each check paid online has exactly one signed invoice, no parent invoice, reported', () => {
      assert.equal(qrClosed.status, 'completed'); assert.equal(qrDocs.length, 2); assert.deepEqual(qrDocs.map((d) => d.checkId).sort(), qrChecks.map((c) => c.id).sort())
      for (const d of qrDocs) { assert.equal(d.status, 'reported', JSON.stringify(d.response)); assert.equal(parseTlv(d.qr)[4].toString(), qrChecks.find((c) => c.id === d.checkId).totalAmount.toFixed(2)) }
    })
    await api('PUT', '/commerce-settings', { loyaltyEarnPerUnit: 0, loyaltyPointValue: 0, promotionsStack: false, providerName: '', paymentEnvironment: 'sandbox', merchantId: '', publicKey: '', paymentAdapter: 'none' }, t)
    if (!live) {
      r = await api('POST', '/zatca/devices', { branchId: branch.id, counterCode: 'counter-2', environment: 'sandbox', otp: '123345', ...address }, t)
      check('one branch registers a second independent ZATCA counter', () => { assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.device.counterCode, 'counter-2') })
      const mainBefore = await tx.zatcaDevice.findUniqueOrThrow({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'main' } } })
      const counterOrder = (await api('POST', '/pos/orders', { branchId: branch.id, orderType: 'takeaway', items: [{ dishId: dish.id, quantity: 1 }] }, t)).data
      r = await api('POST', `/orders/${counterOrder.id}/complete`, { paymentMethod: 'mada', counterCode: 'counter-2' }, t)
      const secondDoc = await tx.zatcaDocument.findFirstOrThrow({ where: { orderId: counterOrder.id, type: 'invoice' } })
      const secondDevice = await tx.zatcaDevice.findUniqueOrThrow({ where: { branchId_counterCode: { branchId: branch.id, counterCode: 'counter-2' } } })
      const mainAfter = await tx.zatcaDevice.findUniqueOrThrow({ where: { id: mainBefore.id } })
      check('counter invoice uses its own certificate and starts its own chain', () => {
        assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(secondDoc.deviceId, secondDevice.id); assert.equal(secondDoc.icv, 1)
        assert.equal(mainAfter.icv, mainBefore.icv); assert.equal(mainAfter.lastInvoiceHash, mainBefore.lastInvoiceHash)
        assert.notEqual(mainAfter.egsSerial, secondDevice.egsSerial); assert.ok(secondDoc.xml.includes('<cbc:PaymentMeansCode>48</cbc:PaymentMeansCode>'))
      })
      await tx.customerOrder.update({ where: { id: counterOrder.id }, data: { counterCode: 'main' } })
      r = await api('POST', `/orders/${counterOrder.id}/refund`, { reason: 'Counter ownership test' }, t)
      const credit = await tx.zatcaDocument.findFirstOrThrow({ where: { orderId: counterOrder.id, type: 'credit' } })
      check('refund follows the original counter certificate and chain', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(credit.deviceId, secondDevice.id); assert.equal(credit.icv, 2); assert.equal(credit.previousHash, secondDoc.hash) })
    }
    await tx.branch.update({ where: { id: branch.id }, data: { isActive: false } })
    await tx.branch.update({ where: { id: other.id }, data: { isActive: false } })
  } finally {
    Object.assign(apiModule.zatcaApi, realApi)
  }
}
