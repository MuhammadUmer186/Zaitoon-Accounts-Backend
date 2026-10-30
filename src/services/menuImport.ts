import ExcelJS from 'exceljs'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { AppError } from '../middleware/error'
import { HHMM, isValidTimezone } from '../utils/menu'

export const menuColumns = {
  Dishes: ['category', 'name', 'description', 'price', 'shifts', 'sortOrder', 'isActive', 'recipeMode', 'image'],
  Categories: ['name', 'description', 'sortOrder', 'isActive'],
  Shifts: ['name', 'startTime', 'endTime', 'sortOrder', 'isActive'],
  Recipes: ['category', 'dish', 'itemCode', 'quantity', 'wastePct', 'sortOrder'],
  Settings: ['timezone'],
} as const
// columns a workbook may leave out (older templates have no image column)
const optionalColumns: Record<string, readonly string[]> = { Dishes: ['image'] }
const key = (value: string) => value.trim().toLowerCase()
export const dishKey = (category: string, name: string) => JSON.stringify([key(category), key(name)])
const fail = (message: string): never => { throw new AppError(message, 400, 'INVALID_MENU_IMPORT') }
const text = (max: number) => z.string().trim().min(1).max(max)
const numeric = (min: number, max: number) => z.string().min(1).transform(Number).pipe(z.number().finite().min(min).max(max))
const sort = z.string().transform(v => v === '' ? 0 : Number(v)).pipe(z.number().int().min(-2147483648).max(2147483647))
const active = z.string().transform(v => v === '' ? 'true' : v.toLowerCase()).pipe(z.enum(['true', 'false', 'yes', 'no', '1', '0'])).transform(v => ['true', 'yes', '1'].includes(v))
const schemas = {
  Dishes: z.object({ category: text(80), name: text(120), description: z.string().max(500), price: numeric(0, 1e9), shifts: text(1000).transform(v => [...new Set(v.split('|').map(s => s.trim()))]).pipe(z.array(text(80)).min(1)), sortOrder: sort, isActive: active, recipeMode: z.string().transform(v => v.toLowerCase() || 'keep').pipe(z.enum(['keep', 'replace'])),
    // picture file name (in the .zip or chosen with the workbook); blank keeps the current picture
    image: z.string().max(200).optional().transform(v => v ?? '') }),
  Categories: z.object({ name: text(80), description: z.string().max(300), sortOrder: sort, isActive: active }),
  Shifts: z.object({ name: text(80), startTime: z.string().regex(HHMM), endTime: z.string().regex(HHMM), sortOrder: sort, isActive: active }),
  Recipes: z.object({ category: text(80), dish: text(120), itemCode: text(100), quantity: numeric(0.000000001, 100000), wastePct: z.string().transform(v => v || '0').pipe(numeric(0, 90)), sortOrder: sort }),
  Settings: z.object({ timezone: text(100).refine(isValidTimezone, 'Unknown timezone') }),
}
type Row<S extends keyof typeof schemas> = z.infer<(typeof schemas)[S]> & { row: number }
export type MenuImport = { [S in keyof typeof schemas]: Row<S>[] }

export async function parseMenuWorkbook(buffer: Buffer): Promise<MenuImport> {
  const workbook = new ExcelJS.Workbook()
  try { await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]) }
  catch { return fail('Could not read this workbook. Upload a valid .xlsx template.') }
  const errors: string[] = []
  for (const sheet of workbook.worksheets) {
    if (!Object.prototype.hasOwnProperty.call(menuColumns, sheet.name) && sheet.name !== 'Instructions') errors.push(`Unknown sheet "${sheet.name}". Use the menu template.`)
  }
  const result = {} as MenuImport
  let total = 0
  for (const name of Object.keys(menuColumns) as (keyof typeof menuColumns)[]) {
    const sheet = workbook.getWorksheet(name)
    const rows: Row<typeof name>[] = []
    if (!sheet && name === 'Dishes') errors.push('Dishes sheet is required.')
    if (sheet) {
      if (sheet.rowCount > 5001 || sheet.columnCount > 30) return fail(`${name}: maximum 5,000 rows and 30 columns.`)
      const headers: string[] = []
      sheet.getRow(1).eachCell((cell, col) => { headers[col - 1] = cell.text.trim() })
      const expected: readonly string[] = menuColumns[name]
      const optional = optionalColumns[name] ?? []
      if (expected.some(h => !optional.includes(h) && !headers.includes(h)) || headers.some(h => !expected.includes(h)) || new Set(headers).size !== headers.length) {
        errors.push(`${name}: keep the exact template headers: ${expected.join(', ')}.`)
      } else sheet.eachRow((row, n) => {
        if (n === 1) return
        if (++total > 5000) return fail('Maximum 5,000 populated rows per workbook.')
        const values: Record<string, string> = {}
        headers.forEach((header, i) => {
          const cell = row.getCell(i + 1)
          if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) errors.push(`${name} row ${n}, ${header}: use a value, not a formula or error.`)
          // Accept actual Excel time cells as well as text HH:mm.
          values[header] = cell.value instanceof Date && ['startTime', 'endTime'].includes(header)
            ? cell.value.toISOString().slice(11, 16) : cell.text.trim()
        })
        if (Object.values(values).every(v => !v)) return
        const parsed = schemas[name].safeParse(values)
        if (!parsed.success) errors.push(`${name} row ${n}: ${parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`)
        else rows.push({ ...parsed.data, row: n } as Row<typeof name>)
      })
    }
    Object.assign(result, { [name]: rows })
  }
  if (!result.Dishes.length) errors.push('Add at least one dish to the Dishes sheet.')
  if (result.Settings.length > 1) errors.push('Settings: only one timezone row is allowed.')
  if (errors.length) fail(errors.slice(0, 50).join('\n'))
  return result
}

// pictures: stored picture path per dish key (see menuPackage); the old
// picture paths of those dishes are returned for removal after commit
export async function applyMenuImport(tx: Prisma.TransactionClient, organizationId: string, data: MenuImport, pictures: Map<string, string> = new Map(), replaced: string[] = []) {
  // Serializes repeated/concurrent imports, including retries after a lost response.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext('menu-import'))`
  const categories = await tx.menuCategory.findMany({ where: { organizationId } })
  const shifts = await tx.menuShift.findMany({ where: { organizationId } })
  const dishes = await tx.dish.findMany({ where: { organizationId }, include: { category: true } })
  const items = await tx.item.findMany({ where: { organizationId, isActive: true } })
  const unique = <T>(rows: T[], identity: (r: T) => string, label: string) => {
    const map = new Map<string, T>()
    for (const row of rows) { const id = identity(row); if (map.has(id)) fail(`${label}: duplicate or ambiguous name/code ${id}. Resolve duplicates before importing.`); map.set(id, row) }
    return map
  }
  const categoryMap = unique(categories, c => key(c.name), 'Existing categories')
  const shiftMap = unique(shifts, s => key(s.name), 'Existing shifts')
  const dishMap = unique(dishes, d => dishKey(d.category.name, d.name), 'Existing dishes')
  const itemMap = unique(items, i => key(i.code), 'Inventory items')
  unique(data.Categories, c => key(c.name), 'Categories sheet')
  unique(data.Shifts, s => key(s.name), 'Shifts sheet')
  const incoming = unique(data.Dishes, d => dishKey(d.category, d.name), 'Dishes sheet')
  unique(data.Recipes, r => JSON.stringify([dishKey(r.category, r.dish), key(r.itemCode)]), 'Recipes sheet')
  const availableShifts = new Set([...shiftMap.keys(), ...data.Shifts.map(s => key(s.name))])
  const errors: string[] = []
  for (const d of data.Dishes) for (const s of d.shifts) if (!availableShifts.has(key(s))) errors.push(`Dishes row ${d.row}: shift "${s}" does not exist. Add it to Shifts.`)
  const recipeGroups = new Map<string, Row<'Recipes'>[]>()
  for (const r of data.Recipes) {
    const id = dishKey(r.category, r.dish)
    if (incoming.get(id)?.recipeMode !== 'replace') errors.push(`Recipes row ${r.row}: include this dish in Dishes with recipeMode Replace.`)
    if (!itemMap.has(key(r.itemCode))) errors.push(`Recipes row ${r.row}: active inventory item code "${r.itemCode}" not found in this organization.`)
    const lines = recipeGroups.get(id) || []; lines.push(r); recipeGroups.set(id, lines)
    if (lines.length > 60) errors.push(`Recipes row ${r.row}: maximum 60 ingredients per dish.`)
  }
  if (errors.length) fail(errors.slice(0, 50).join('\n'))
  let created = 0, updated = 0, recipes = 0
  for (const { row, ...c } of data.Categories) {
    const existing = categoryMap.get(key(c.name))
    const record = existing ? await tx.menuCategory.update({ where: { id: existing.id }, data: c }) : await tx.menuCategory.create({ data: { ...c, organizationId } })
    categoryMap.set(key(c.name), record)
  }
  for (const { row, ...s } of data.Shifts) {
    const existing = shiftMap.get(key(s.name))
    const record = existing ? await tx.menuShift.update({ where: { id: existing.id }, data: s }) : await tx.menuShift.create({ data: { ...s, organizationId } })
    shiftMap.set(key(s.name), record)
  }
  for (const { row, category, shifts: names, recipeMode, ...d } of data.Dishes) {
    let c = categoryMap.get(key(category))
    if (!c) { c = await tx.menuCategory.create({ data: { organizationId, name: category } }); categoryMap.set(key(category), c) }
    const id = dishKey(category, d.name)
    const existing = dishMap.get(id)
    const { image: _image, ...fields } = d
    const imagePath = pictures.get(id)
    if (imagePath && existing?.imagePath) replaced.push(existing.imagePath)
    const dish = existing ? await tx.dish.update({ where: { id: existing.id }, data: { ...fields, categoryId: c.id, ...(imagePath && { imagePath }) } }) : await tx.dish.create({ data: { ...fields, organizationId, categoryId: c.id, ...(imagePath && { imagePath }) } })
    existing ? updated++ : created++
    await tx.dishShift.deleteMany({ where: { dishId: dish.id } })
    await tx.dishShift.createMany({ data: [...new Set(names.map(n => shiftMap.get(key(n))!.id))].map(shiftId => ({ dishId: dish.id, shiftId })) })
    if (recipeMode === 'replace') {
      await tx.dishIngredient.deleteMany({ where: { dishId: dish.id } })
      const lines = recipeGroups.get(id) || []
      if (lines.length) await tx.dishIngredient.createMany({ data: lines.map(r => ({ dishId: dish.id, itemId: itemMap.get(key(r.itemCode))!.id, quantity: r.quantity, wastePct: r.wastePct, sortOrder: r.sortOrder })) })
      recipes++
    }
  }
  if (data.Settings[0]) await tx.organization.update({ where: { id: organizationId }, data: { timezone: data.Settings[0].timezone } })
  return { created, updated, recipes, categories: data.Categories.length, shifts: data.Shifts.length, pictures: pictures.size }
}

export function createMenuTemplate() {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'FoodSync'
  for (const [name, columns] of Object.entries(menuColumns)) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
    ws.columns = columns.map(header => ({ header, key: header, width: ['description', 'shifts'].includes(header) ? 42 : 22 }))
    ws.getRow(1).height = 30
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF096B56' } }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }
    for (const column of ['startTime', 'endTime', 'itemCode']) if ((columns as readonly string[]).includes(column)) ws.getColumn(column).numFmt = '@'
    if ((columns as readonly string[]).includes('price')) ws.getColumn('price').numFmt = '#,##0.00'
    for (let n = 2; n <= 501; n++) {
      if ((columns as readonly string[]).includes('isActive')) ws.getCell(n, columns.indexOf('isActive' as never) + 1).dataValidation = { type: 'list', allowBlank: true, formulae: ['"TRUE,FALSE"'], showErrorMessage: true, error: 'Choose TRUE or FALSE.' }
      if (name === 'Dishes') ws.getCell(n, 8).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Keep,Replace"'], showErrorMessage: true, error: 'Choose Keep or Replace.' }
    }
  }
  const instructions = wb.addWorksheet('Instructions')
  instructions.columns = [{ width: 27 }, { width: 110 }]
  const guidance = [
    ['FoodSync menu import', 'Fill Dishes, then upload this .xlsx (or a .zip with it and the pictures) in Menu > Import Excel. Other sheets are optional. Maximum 5 MB workbook and 5,000 data rows.'],
    ['Required dish fields', 'category, name, price (VAT-inclusive), shifts. Separate shift names with |, for example Lunch|Dinner. Existing shifts can be referenced, or define them in Shifts.'],
    ['Defaults', 'Blank description clears it; blank sortOrder means 0; blank isActive means TRUE. Blank image keeps the dish’s current picture.'],
    ['Pictures', 'Optional: put the picture file name in image, e.g. chicken-karahi.jpg. Upload a .zip with this workbook and the pictures (any folder), or choose the workbook and the pictures together. JPG, PNG or WEBP, up to 5 MB each; names match ignoring case and folders.'],
    ['Matching / updates', 'Category names and shift names match ignoring case. Dishes match by category + dish name. Matches update; unmatched dishes are created. Changing a name creates a new dish. Other dishes are not deleted.'],
    ['Categories', 'Optional: name, description, sortOrder, isActive. A category named in Dishes is automatically created if missing.'],
    ['Shifts', 'Optional: name, startTime, endTime, sortOrder, isActive. Use 24-hour HH:mm, e.g. 12:00 and 17:00. Equal times mean all day; an earlier end time runs overnight.'],
    ['Recipes', 'Optional: one ingredient per row. Use existing active inventory itemCode; quantity is per portion in that item’s stock unit. wastePct is 0–90 (enter 10 for 10%). sortOrder controls ingredient order. No stock or financial postings are created.'],
    ['Recipe replacement', 'In Dishes, recipeMode Keep (or blank) preserves the recipe. Replace replaces the entire recipe with rows from Recipes; Replace with no recipe rows clears it. Recipe rows require a matching dish with Replace.'],
    ['Settings', 'Optional single row with an IANA timezone, e.g. Asia/Karachi. Shift times use this organization timezone. Blank sheet preserves it.'],
    ['Example dish (not imported)', 'Dishes: Main Course | Chicken Rice | Served with salad | 650 | Lunch|Dinner | 1 | TRUE | Keep | chicken-rice.jpg'],
    ['Example recipe (not imported)', 'Recipes: Main Course | Chicken Rice | RICE-001 | 0.15 | 5 | 1. Set that dish to Replace and use your actual inventory code.'],
    ['Validation', 'Keep sheet names and column headers unchanged. Use values, not formulas. Duplicate dishes/ingredients, unknown inventory codes or invalid values stop the whole import. Fix the indicated sheet/row and retry.'],
    ['One import', 'Choose the completed file and click Import menu. Every sheet is saved together or nothing is saved. This affects the organization menu across all branches.'],
  ]
  for (const values of guidance) { const row = instructions.addRow(values); row.height = 48; row.alignment = { vertical: 'middle', wrapText: true }; row.getCell(1).font = { bold: true } }
  instructions.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF096B56' } }
  instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  return wb
}
