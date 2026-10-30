import { Request, Response, NextFunction } from 'express'
import { assertBranchAccess, getBranchScope } from '../utils/branchScope'
import { reportReadScope } from '../utils/reportReadScope'
import { AppError } from './error'

export async function withReportingScope(req: Request, _res: Response, next: NextFunction) {
  const requested = req.query.branchId
  if (requested !== undefined && typeof requested !== 'string') throw new AppError('Invalid branch filter', 400, 'VALIDATION_ERROR')
  if (requested) await assertBranchAccess(req, requested)
  const scope = await getBranchScope(req)
  reportReadScope.run({ organizationId: req.user.organizationId, branchIds: requested ? [requested] : scope.restricted ? scope.branchIds : undefined }, next)
}
