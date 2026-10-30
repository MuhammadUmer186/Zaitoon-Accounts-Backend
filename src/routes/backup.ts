import zlib from 'zlib'
import { Router, Request, Response } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../config'
import { authenticate } from '../middleware/auth'
import { requirePermission } from '../middleware/authorize'
import { logAudit } from '../utils/audit'

// Super Admin "download full backup": every table as JSON, gzip-compressed,
// so an off-server copy can be kept at any time. This complements (doesn't
// replace) scheduled database backups configured in Dokploy, which are the
// restore path. Uploaded files (bill images/PDFs) live on disk, not in the
// database, and are not included.

const router = Router()
router.use(authenticate)

// Login sessions are useless in a backup and would leak live tokens
const SKIP_MODELS = new Set(['RefreshToken'])

router.get('/download', requirePermission('can_manage_settings'), async (req: Request, res: Response) => {
  const models = Prisma.dmmf.datamodel.models.map((m) => m.name).filter((n) => !SKIP_MODELS.has(n))
  const tables: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  for (const name of models) {
    const delegate = (prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>)[name.charAt(0).toLowerCase() + name.slice(1)]
    if (!delegate?.findMany) continue
    const rows = await delegate.findMany()
    tables[name] = rows
    counts[name] = rows.length
  }

  const payload = {
    format: 'zaitoon-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    createdBy: req.user.email,
    note: 'Full data export. Uploaded files are not included. Restore from Dokploy database backups.',
    counts,
    tables,
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload)))

  await logAudit(prisma, {
    req, action: 'backup.downloaded', module: 'settings', resourceType: 'backup',
    newData: { tables: models.length, rows: Object.values(counts).reduce((s, n) => s + n, 0), bytes: gz.length },
  })

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  res.setHeader('Content-Type', 'application/gzip')
  res.setHeader('Content-Disposition', `attachment; filename="zaitoon-backup-${stamp}.json.gz"`)
  res.send(gz)
})

export default router
