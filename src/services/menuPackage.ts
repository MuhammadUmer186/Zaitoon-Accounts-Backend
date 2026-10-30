import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { AppError } from '../middleware/error'
import { UPLOAD_ROOT } from '../middleware/upload'

// A menu import is either the .xlsx alone, the .xlsx with picture files
// chosen next to it, or one .zip holding the .xlsx and its pictures (any
// folders). Dishes name their picture by file name in the "image" column.

const fail = (message: string): never => { throw new AppError(message, 400, 'INVALID_MENU_IMPORT') }
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_WORKBOOK_BYTES = 5 * 1024 * 1024
const MAX_ZIP_ENTRIES = 1000
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i
export interface MenuPicture { name: string; buffer: Buffer; ext: '.jpg' | '.png' | '.webp' }
export interface MenuPackage { workbook: Buffer; pictures: Map<string, MenuPicture> }

// the file's real type from its first bytes, never from its name
export function pictureType(b: Buffer): MenuPicture['ext'] | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg'
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png'
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp'
  return null
}
export const pictureKey = (name: string) => path.posix.basename(name.replace(/\\/g, '/')).trim().toLowerCase()

function addPicture(pictures: Map<string, MenuPicture>, name: string, buffer: Buffer) {
  const key = pictureKey(name)
  if (buffer.length > MAX_IMAGE_BYTES) fail(`Picture "${key}" is larger than 5 MB. Resize it and try again.`)
  const ext = pictureType(buffer)
  if (!ext) fail(`"${key}" is not a JPG, PNG or WEBP picture.`)
  if (pictures.has(key)) fail(`Two pictures are named "${key}". Picture file names must be unique.`)
  pictures.set(key, { name: key, buffer, ext: ext! })
}

export async function readMenuPackage(main: { originalname: string; buffer: Buffer }, extra: { originalname: string; buffer: Buffer }[] = []): Promise<MenuPackage> {
  const pictures = new Map<string, MenuPicture>()
  const lower = main.originalname.toLowerCase()
  if (lower.endsWith('.xlsx')) {
    if (main.buffer.length > MAX_WORKBOOK_BYTES) fail('The workbook is larger than 5 MB.')
    for (const f of extra) addPicture(pictures, f.originalname, f.buffer)
    return { workbook: main.buffer, pictures }
  }
  if (!lower.endsWith('.zip')) return fail('Upload the .xlsx menu workbook, or a .zip with the workbook and pictures.')
  if (extra.length) fail('Put the pictures inside the .zip, or upload the .xlsx with the pictures instead.')
  let zip: JSZip
  try { zip = await JSZip.loadAsync(main.buffer) } catch { return fail('Could not open this .zip file.') }
  const entries = Object.values(zip.files).filter((f) => !f.dir && !f.name.startsWith('__MACOSX/') && !pictureKey(f.name).startsWith('.') && !pictureKey(f.name).startsWith('~$'))
  if (entries.length > MAX_ZIP_ENTRIES) fail(`The .zip holds more than ${MAX_ZIP_ENTRIES} files.`)
  // declared sizes first, so an oversized archive is refused before unpacking
  const declared = entries.reduce((n, f) => n + Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0), 0)
  if (declared > MAX_UNPACKED_BYTES) fail('The .zip unpacks to more than 300 MB.')
  const workbooks = entries.filter((f) => /\.xlsx$/i.test(f.name))
  if (workbooks.length !== 1) fail(workbooks.length ? 'The .zip holds more than one .xlsx workbook. Keep only the menu workbook.' : 'The .zip has no .xlsx menu workbook.')
  const workbook = await workbooks[0].async('nodebuffer')
  if (workbook.length > MAX_WORKBOOK_BYTES) fail('The workbook is larger than 5 MB.')
  let unpacked = workbook.length
  for (const f of entries) {
    if (!IMAGE_EXT.test(f.name)) continue
    const buffer = await f.async('nodebuffer')
    unpacked += buffer.length
    if (unpacked > MAX_UNPACKED_BYTES) fail('The .zip unpacks to more than 300 MB.')
    addPicture(pictures, f.name, buffer)
  }
  return { workbook, pictures }
}

// Each dish gets its own stored copy, so replacing one dish's picture later
// never removes another dish's file. Returns the stored paths by dish key.
export function storeMenuPictures(assign: { dishKey: string; picture: MenuPicture }[]) {
  const dir = path.join(UPLOAD_ROOT, 'menu')
  fs.mkdirSync(dir, { recursive: true })
  const stored = new Map<string, string>()
  try {
    for (const a of assign) {
      const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${a.picture.ext}`)
      fs.writeFileSync(file, a.picture.buffer)
      stored.set(a.dishKey, file)
    }
  } catch (e) {
    for (const f of stored.values()) fs.rmSync(f, { force: true })
    throw e
  }
  return stored
}
