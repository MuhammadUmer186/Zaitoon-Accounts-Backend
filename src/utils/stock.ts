import { PrismaClient } from '@prisma/client'
import { AppError } from '../middleware/error'

export interface StockInInput {
  organizationId: string
  branchId: string
  itemId: string
  quantity: number
  unitCost: number
  referenceType?: string
  referenceId?: string
  notes?: string
  createdBy: string
}

// Records a stock-in movement and updates BranchStock using weighted-average costing.
// Shared by the manual stock-in endpoint (inventory.ts) and Purchase Order receiving
// (purchaseOrders.ts) so both paths keep BranchStock/StockMovement consistent.
export async function applyStockIn(prisma: PrismaClient, input: StockInInput) {
  const totalValue = input.quantity * input.unitCost

  const movement = await prisma.stockMovement.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      itemId: input.itemId,
      movementType: 'stock_in',
      quantity: input.quantity,
      unitCost: input.unitCost,
      totalValue,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      notes: input.notes,
      createdBy: input.createdBy,
    },
  })

  const existingStock = await prisma.branchStock.findUnique({
    where: { branchId_itemId: { branchId: input.branchId, itemId: input.itemId } },
  })

  if (existingStock) {
    const newQty = existingStock.quantityOnHand + input.quantity
    const newTotalValue = existingStock.totalValue + totalValue
    const newAvgCost = newQty > 0 ? newTotalValue / newQty : input.unitCost

    await prisma.branchStock.update({
      where: { branchId_itemId: { branchId: input.branchId, itemId: input.itemId } },
      data: {
        quantityOnHand: newQty,
        averageCost: newAvgCost,
        totalValue: newTotalValue,
        lastUpdated: new Date(),
      },
    })
  } else {
    const item = await prisma.item.findUnique({ where: { id: input.itemId } })
    await prisma.branchStock.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        itemId: input.itemId,
        quantityOnHand: input.quantity,
        averageCost: input.unitCost,
        totalValue,
        reorderPoint: item?.reorderPoint ?? 0,
        lastUpdated: new Date(),
      },
    })
  }

  return movement
}

export interface StockOutInput {
  organizationId: string
  branchId: string
  itemId: string
  quantity: number
  referenceType?: string
  referenceId?: string
  notes?: string
  createdBy: string
}

// Records a stock-out movement and updates BranchStock, valuing the removed
// quantity at the item's current weighted-average cost. Used by the manual
// "Stock Out" endpoint (general usage/consumption/adjustment for any branch,
// applied immediately — no approval step, unlike wastage reports).
export async function applyStockOut(prisma: PrismaClient, input: StockOutInput) {
  const existingStock = await prisma.branchStock.findUnique({
    where: { branchId_itemId: { branchId: input.branchId, itemId: input.itemId } },
  })

  if (!existingStock || existingStock.quantityOnHand < input.quantity) {
    const available = existingStock?.quantityOnHand ?? 0
    throw new AppError(
      `Insufficient stock: only ${available} available, requested ${input.quantity}`,
      400,
      'INSUFFICIENT_STOCK'
    )
  }

  const unitCost = existingStock.averageCost
  const totalValue = input.quantity * unitCost

  const movement = await prisma.stockMovement.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      itemId: input.itemId,
      movementType: 'stock_out',
      quantity: -input.quantity,
      unitCost,
      totalValue,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      notes: input.notes,
      createdBy: input.createdBy,
    },
  })

  const newQty = existingStock.quantityOnHand - input.quantity
  const newTotalValue = Math.max(0, existingStock.totalValue - totalValue)

  await prisma.branchStock.update({
    where: { branchId_itemId: { branchId: input.branchId, itemId: input.itemId } },
    data: { quantityOnHand: newQty, totalValue: newTotalValue, lastUpdated: new Date() },
  })

  return { movement, unitCost, totalValue }
}
