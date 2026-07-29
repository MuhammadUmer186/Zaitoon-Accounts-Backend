import fs from 'fs'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { upload } from '../middleware/upload'
import { nextNumber } from '../utils/numbering'
import { AppError } from '../middleware/error'
import { postJournalEntry, resolveMappedAccount, mappingKeyForPaymentMethod } from '../utils/ledger'
import { applyStockIn } from '../utils/stock'
import { toHijriDate } from '../utils/hijriDate'

const router = Router()

router.use(authenticate)

const purchaseItemSchema = z.object({
  itemId: z.string().optional(),
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitCost: z.coerce.number().min(0),
})

const createPurchaseSchema = z
  .object({
    branchId: z.string(),
    supplierId: z.string().optional(),
    vendorName: z.string().optional(),
    vendorCity: z.string().optional(),
    vendorVatNumber: z.string().optional(),
    supplyDate: z.string(),
    paymentDate: z.string(),
    paymentType: z.enum(['cash', 'bank_transfer']),
    vatPercent: z.coerce.number().min(0).max(100),
    amountPaid: z.coerce.number().min(0).optional(),
    items: z.string(), // JSON-stringified purchaseItemSchema[]
  })
  .refine((b) => b.supplierId || b.vendorName, {
    message: 'Either supplierId or vendorName is required',
    path: ['vendorName'],
  })

// POST /purchasing — one-shot vendor purchase entry: creates/uses a Supplier,
// posts the Bill approval journal entry, optionally records payment (full or
// partial), attaches the reference bill / payment slip, and updates branch
// stock for any catalog-linked line — all in a single transaction. This is
// the "Purchasing" module's only endpoint; listing/detail reuse the existing
// /suppliers/bills* routes filtered by source=purchasing.
router.post(
  '/',
  requirePermission('can_create_purchasing_entry'),
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'paymentSlip', maxCount: 1 }]),
  async (req: Request, res: Response) => {
    const body = createPurchaseSchema.parse(req.body)
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    const billFile = files?.file?.[0]
    const paymentSlipFile = files?.paymentSlip?.[0]

    let itemInputs: z.infer<typeof purchaseItemSchema>[]
    try {
      itemInputs = z.array(purchaseItemSchema).parse(JSON.parse(body.items))
    } catch {
      throw new AppError('Invalid items payload', 400, 'VALIDATION_ERROR')
    }
    if (itemInputs.length === 0) throw new AppError('At least one purchased product is required', 400, 'VALIDATION_ERROR')

    const subtotal = itemInputs.reduce((sum, i) => sum + i.quantity * i.unitCost, 0)
    const vatAmount = Math.round(subtotal * (body.vatPercent / 100) * 100) / 100
    const totalAmount = subtotal + vatAmount
    // Not paid unless the user explicitly enters an amount — a purchase
    // shouldn't silently post as fully paid just because Amount Paid was left blank.
    const paidAmount = body.amountPaid ?? 0
    if (paidAmount > totalAmount + 0.01) throw new AppError('Amount paid cannot exceed total payment', 400, 'VALIDATION_ERROR')
    if (body.paymentType === 'bank_transfer' && paidAmount > 0 && !paymentSlipFile) {
      throw new AppError('A transfer slip attachment is required for online transfer payments', 400, 'VALIDATION_ERROR')
    }

    const cleanupFiles = () => {
      for (const f of [billFile, paymentSlipFile]) {
        if (f) { try { fs.unlinkSync(f.path) } catch { /* best-effort cleanup */ } }
      }
    }

    try {
      const bill = await prisma.$transaction(async (tx) => {
        const branch = await tx.branch.findFirst({
          where: { id: body.branchId, organizationId: req.user.organizationId },
        })
        if (!branch) throw new AppError('Branch not found', 404, 'NOT_FOUND')

        let supplier
        if (body.supplierId) {
          supplier = await tx.supplier.findFirst({
            where: { id: body.supplierId, organizationId: req.user.organizationId },
          })
          if (!supplier) throw new AppError('Supplier not found', 404, 'NOT_FOUND')
        } else {
          supplier = await tx.supplier.create({
            data: {
              organizationId: req.user.organizationId,
              name: body.vendorName!,
              vatNumber: body.vendorVatNumber,
              city: body.vendorCity,
            },
          })
        }

        const billNo = await nextNumber(tx as unknown as typeof prisma, 'bill', 'billNo', 'BILL', req.user.organizationId)
        const supplyDate = new Date(body.supplyDate)
        const balanceDue = totalAmount - paidAmount
        const status = balanceDue <= 0.01 ? 'paid' : paidAmount > 0 ? 'partial' : 'approved'

        const createdBill = await tx.bill.create({
          data: {
            organizationId: req.user.organizationId,
            branchId: body.branchId,
            supplierId: supplier.id,
            billNo,
            billDate: supplyDate,
            dueDate: new Date(body.paymentDate),
            subtotal,
            vatAmount,
            totalAmount,
            paidAmount,
            balanceDue,
            status,
            source: 'purchasing',
            hijriDate: toHijriDate(supplyDate),
            createdBy: req.user.id,
            items: {
              create: itemInputs.map((i) => ({
                description: i.description,
                quantity: i.quantity,
                unitPrice: i.unitCost,
                vatRate: body.vatPercent,
                vatAmount: Math.round(i.quantity * i.unitCost * (body.vatPercent / 100) * 100) / 100,
                totalAmount: Math.round(i.quantity * i.unitCost * (1 + body.vatPercent / 100) * 100) / 100,
                itemId: i.itemId,
              })),
            },
          },
        })

        const [inventoryAccount, inputVat, payable] = await Promise.all([
          resolveMappedAccount(tx as unknown as typeof prisma, req.user.organizationId, 'INVENTORY'),
          vatAmount > 0 ? resolveMappedAccount(tx as unknown as typeof prisma, req.user.organizationId, 'INPUT_VAT') : null,
          resolveMappedAccount(tx as unknown as typeof prisma, req.user.organizationId, 'ACCOUNTS_PAYABLE'),
        ])

        const billJe = await postJournalEntry(tx as unknown as typeof prisma, {
          organizationId: req.user.organizationId,
          branchId: body.branchId,
          entryDate: supplyDate,
          referenceType: 'bill',
          referenceId: createdBill.id,
          sourceType: 'BILL',
          sourceKey: `BILL:${createdBill.id}:APPROVAL`,
          description: `Purchase ${billNo} — ${supplier.name}`,
          createdBy: req.user.id,
          lines: [
            { accountId: inventoryAccount.id, description: 'Purchased goods', debitAmount: subtotal },
            ...(inputVat ? [{ accountId: inputVat.id, description: 'Input VAT', debitAmount: vatAmount }] : []),
            { accountId: payable.id, description: 'Payable to vendor', creditAmount: totalAmount },
          ],
        })
        await tx.bill.update({ where: { id: createdBill.id }, data: { journalEntryId: billJe?.id } })

        let createdPayment: { id: string } | null = null
        if (paidAmount > 0) {
          createdPayment = await tx.payment.create({
            data: {
              organizationId: req.user.organizationId,
              branchId: body.branchId,
              billId: createdBill.id,
              paymentDate: new Date(body.paymentDate),
              amount: paidAmount,
              paymentMethod: body.paymentType,
              createdBy: req.user.id,
            },
          })

          const paidFrom = await resolveMappedAccount(
            tx as unknown as typeof prisma,
            req.user.organizationId,
            mappingKeyForPaymentMethod(body.paymentType)
          )

          const paymentJe = await postJournalEntry(tx as unknown as typeof prisma, {
            organizationId: req.user.organizationId,
            branchId: body.branchId,
            entryDate: new Date(body.paymentDate),
            referenceType: 'payment',
            referenceId: createdPayment.id,
            sourceType: 'BILL_PAYMENT',
            sourceKey: `BILL_PAYMENT:${createdPayment.id}:POST`,
            description: `Payment for Purchase ${billNo}`,
            createdBy: req.user.id,
            lines: [
              { accountId: payable.id, description: 'Payable settled', debitAmount: paidAmount },
              { accountId: paidFrom.id, description: 'Payment made', creditAmount: paidAmount },
            ],
          })
          await tx.payment.update({ where: { id: createdPayment.id }, data: { journalEntryId: paymentJe?.id } })
        }

        if (billFile) {
          const document = await tx.document.create({
            data: {
              organizationId: req.user.organizationId,
              branchId: body.branchId,
              originalFilename: billFile.originalname,
              storedFilename: billFile.filename,
              filePath: billFile.path,
              fileType: billFile.mimetype,
              fileSize: billFile.size,
              documentType: 'bill',
              linkedType: 'bill',
              linkedId: createdBill.id,
              uploadedBy: req.user.id,
            },
          })
          await tx.bill.update({ where: { id: createdBill.id }, data: { documentId: document.id } })
        }

        if (paymentSlipFile && createdPayment) {
          const document = await tx.document.create({
            data: {
              organizationId: req.user.organizationId,
              branchId: body.branchId,
              originalFilename: paymentSlipFile.originalname,
              storedFilename: paymentSlipFile.filename,
              filePath: paymentSlipFile.path,
              fileType: paymentSlipFile.mimetype,
              fileSize: paymentSlipFile.size,
              documentType: 'payment_slip',
              linkedType: 'payment',
              linkedId: createdPayment.id,
              uploadedBy: req.user.id,
            },
          })
          await tx.payment.update({ where: { id: createdPayment.id }, data: { documentId: document.id } })
        }

        for (const item of itemInputs) {
          if (!item.itemId) continue // free-text lines aren't linked to a stock item
          await applyStockIn(tx as unknown as typeof prisma, {
            organizationId: req.user.organizationId,
            branchId: body.branchId,
            itemId: item.itemId,
            quantity: item.quantity,
            unitCost: item.unitCost,
            referenceType: 'purchase',
            referenceId: createdBill.id,
            notes: `Purchased via Purchasing — ${billNo}`,
            createdBy: req.user.id,
          })
        }

        return tx.bill.findUniqueOrThrow({
          where: { id: createdBill.id },
          include: { items: true, payments: true, supplier: true, branch: true },
        })
      })

      res.status(201).json(bill)
    } catch (err) {
      cleanupFiles()
      throw err
    }
  }
)

export default router
