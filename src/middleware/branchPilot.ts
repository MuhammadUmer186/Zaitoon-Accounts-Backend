import { Request, Response, NextFunction } from 'express'
import { AppError } from './error'

// These operations need a shared authority across branches. The pilot must
// not spend a copied cloud balance or redeem one voucher in two databases.
export function branchPilotPolicy(req: Request, _res: Response, next: NextFunction) {
  if (process.env.FOODSYNC_DEPLOYMENT_MODE !== 'branch' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const url = req.path.replace(/\/$/, '')
  const centrallyManaged = /^\/(?:users|acl|menu|accounts|bank-accounts|tax-rates|accounting-settings|orgs)(?:\/|$)/.test(url)
    || /^\/inventory\/(?:items|categories)(?:\/|$)/.test(url)
    || /^\/auth\/me(?:\/password)?$/.test(url)
  if (centrallyManaged) throw new AppError('Manage menus, staff access and organization settings in the cloud. This PC downloads verified updates automatically.', 409, 'CENTRALLY_MANAGED_CONFIGURATION')
  // Gift-card sales and house-account payments run through the central wallet
  // (routes/giftCards.ts, routes/customers.ts); other gift-card changes stay central.
  const blocked = (/^\/gift-cards(?:\/|$)/.test(url) && url !== '/gift-cards')
    || /^\/branches(?:\/|$)/.test(url)
    || url === '/commerce-settings'
  if (blocked) throw new AppError('This operation requires central reconciliation and is unavailable in the branch pilot.', 503, 'BRANCH_PILOT_LIMITATION')
  next()
}
