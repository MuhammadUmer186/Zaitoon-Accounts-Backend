import { PrismaClient } from '@prisma/client'
import { unwrapOnPc } from '../utils/fiscalTransfer'
import { seal } from './zatca/crypto'

type FiscalDevice = { id: string; privateKey: string; complianceSecret: string | null; productionSecret: string }

// Installer step on the branch PC: re-seal the ZATCA devices received from the
// cloud under this PC's own key (ZATCA_ENCRYPTION_KEY). Every imported device
// must receive its secrets, or the installation stops.
export async function installFiscalDevices(db: PrismaClient, pkg: { tables?: Record<string, { id: unknown }[]>; fiscalDevices?: FiscalDevice[] }, privateKeyPem: string) {
  const imported = new Set((pkg.tables?.ZatcaDevice ?? []).map(d => String(d.id)))
  const received = pkg.fiscalDevices ?? []
  if (received.length !== imported.size || received.some(d => !imported.has(d.id))) throw new Error('Fiscal device secrets do not match the imported devices')
  if (!process.env.ZATCA_ENCRYPTION_KEY) throw new Error('ZATCA_ENCRYPTION_KEY is required to store fiscal device secrets')
  await db.$transaction(async tx => {
    for (const device of received) {
      await tx.zatcaDevice.update({ where: { id: device.id }, data: {
        privateKeySealed: seal(unwrapOnPc(device.privateKey, privateKeyPem)),
        complianceSecretSealed: device.complianceSecret ? seal(unwrapOnPc(device.complianceSecret, privateKeyPem)) : null,
        productionSecretSealed: seal(unwrapOnPc(device.productionSecret, privateKeyPem)),
      } })
    }
  })
  return received.length
}
