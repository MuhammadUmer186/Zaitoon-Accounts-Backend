const assert = require('node:assert/strict')
const ExcelJS = require('exceljs')
const path = require('node:path')
const { createMenuTemplate, parseMenuWorkbook, applyMenuImport } = require('../dist/services/menuImport')

module.exports = async function testMenuImport({ tx, db, base, token, deniedToken, org, org2, item, check }) {
  const staticTemplate = new ExcelJS.Workbook()
  await staticTemplate.xlsx.readFile(path.join(__dirname, '../../docs/templates/FoodSync-Menu-Import.xlsx'))
  staticTemplate.getWorksheet('Dishes').getRow(2).values = ['Main', 'Template test', '', 250, 'Lunch', 0, true, 'Keep']
  const parsedTemplate = await parseMenuWorkbook(Buffer.from(await staticTemplate.xlsx.writeBuffer()))
  check('downloadable reference workbook parses correctly', () => { assert.equal(parsedTemplate.Dishes[0].price, 250); assert.equal(parsedTemplate.Dishes.length, 1) })
  const stockBefore = await tx.branchStock.findMany({ where: { organizationId: org.id } })
  const journalCountBefore = await tx.journalEntry.count({ where: { organizationId: org.id } })
  const request = async (workbook, auth = token, raw) => {
    const form = new FormData()
    form.append('file', new Blob([raw || await workbook.xlsx.writeBuffer()]), 'menu.xlsx')
    const res = await fetch(base + '/menu/import', { method: 'POST', headers: auth ? { Authorization: `Bearer ${auth}` } : {}, body: form })
    return { status: res.status, data: await res.json() }
  }
  const template = await fetch(base + '/menu/import/template', { headers: { Authorization: `Bearer ${token}` } })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.from(await template.arrayBuffer()))
  check('menu template is a real Excel workbook with all sheets', () => { assert.equal(template.status, 200); assert.deepEqual(wb.worksheets.map(s => s.name), ['Dishes', 'Categories', 'Shifts', 'Recipes', 'Settings', 'Instructions']); assert.equal(wb.getWorksheet('Dishes').getCell('H2').dataValidation.type, 'list') })
  let r = await request(wb, '')
  check('anonymous menu import denied', () => assert.equal(r.status, 401))
  r = await request(wb, deniedToken)
  check('menu import requires menu permission', () => assert.equal(r.status, 403))
  r = await request(wb)
  check('blank template does not create sample dishes', () => { assert.equal(r.status, 400); assert.match(r.data.message, /at least one dish/) })
  wb.getWorksheet('Categories').addRow(['Imported food', 'Full menu', 7, false])
  wb.getWorksheet('Shifts').addRow(['Late night', '22:00', '03:00', 4, true])
  // Validation cells extend the sheet; specify the actual row explicitly.
  wb.getWorksheet('Dishes').getRow(2).values = ['Imported food', 'Rice plate', 'Fresh rice', 650.50, 'Late night', 3, true, 'Replace']
  wb.getWorksheet('Recipes').addRow(['Imported food', 'Rice plate', item.code, 0.25, 10, 2])
  wb.getWorksheet('Settings').addRow(['Asia/Karachi'])
  r = await request(wb)
  check('one upload imports complete menu', () => { assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.created, 1); assert.equal(r.data.recipes, 1) })
  let dish = await tx.dish.findFirst({ where: { organizationId: org.id, name: 'Rice plate' }, include: { category: true, shifts: { include: { shift: true } }, ingredients: true } })
  check('all dish/category/shift/recipe fields imported', () => {
    assert.equal(dish.price, 650.5); assert.equal(dish.description, 'Fresh rice'); assert.equal(dish.sortOrder, 3)
    assert.equal(dish.category.description, 'Full menu'); assert.equal(dish.category.isActive, false)
    assert.equal(dish.shifts[0].shift.endTime, '03:00'); assert.equal(dish.ingredients[0].quantity, 0.25); assert.equal(dish.ingredients[0].wastePct, 10)
  })
  check('menu import is organization scoped', () => assert.equal(dish.organizationId, org.id))
  await tx.dish.update({ where: { id: dish.id }, data: { imagePath: 'existing-photo.png' } })
  r = await request(wb)
  check('repeat import updates without duplicating dishes', () => { assert.equal(r.data.created, 0); assert.equal(r.data.updated, 1) })
  const withPicture = await tx.dish.findUnique({ where: { id: dish.id } })
  check('existing pictures preserved', () => assert.equal(withPicture.imagePath, 'existing-photo.png'))
  const invalid = createMenuTemplate()
  invalid.getWorksheet('Dishes').getRow(2).values = ['New category', 'Should roll back', '', 20, 'Late night', 0, true, 'Keep']
  invalid.getWorksheet('Dishes').getRow(3).values = ['New category', 'Invalid price', '', -1, 'Late night', 0, true, 'Keep']
  r = await request(invalid)
  check('bad row rejects entire workbook with row reference', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Dishes row 3/); })
  assert.equal(await tx.menuCategory.count({ where: { organizationId: org.id, name: 'New category' } }), 0)
  invalid.getWorksheet('Dishes').getRow(3).values = ['New category', 'Should roll back', '', 20, 'Late night', 0, true, 'Keep']
  r = await request(invalid)
  check('duplicate dish rows rejected', () => { assert.equal(r.status, 400); assert.match(r.data.message, /duplicate/) })
  invalid.getWorksheet('Dishes').getRow(3).values = ['New category', 'Other dish', '', 20, 'Unknown shift', 0, true, 'Keep']
  r = await request(invalid)
  check('unknown shift rejects workbook without partial category', () => { assert.equal(r.status, 400); assert.match(r.data.message, /row 3.*shift/) })
  assert.equal(await tx.menuCategory.count({ where: { organizationId: org.id, name: 'New category' } }), 0)
  await tx.item.create({ data: { organizationId: org2.id, code: 'FOREIGN-INGREDIENT', name: 'Foreign' } })
  wb.getWorksheet('Recipes').getRow(2).getCell(3).value = 'FOREIGN-INGREDIENT'
  r = await request(wb)
  check('foreign inventory code cannot enter recipe', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Recipes row 2/) })
  wb.getWorksheet('Recipes').getRow(2).getCell(3).value = item.code
  wb.getWorksheet('Recipes').getCell('D2').value = 0
  r = await request(wb)
  check('zero recipe quantity rejected', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Recipes row 2/) })
  wb.getWorksheet('Recipes').getCell('D2').value = 0.25
  wb.getWorksheet('Recipes').getCell('E2').value = 91
  r = await request(wb)
  check('recipe waste over 90 percent rejected', () => assert.equal(r.status, 400))
  wb.getWorksheet('Recipes').getCell('E2').value = 10
  wb.getWorksheet('Settings').getCell('A2').value = 'Invalid/Zone'
  r = await request(wb)
  check('invalid timezone rejected', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Settings row 2/) })
  wb.getWorksheet('Settings').getCell('A2').value = 'Asia/Karachi'
  wb.getWorksheet('Dishes').getCell('G2').value = 'maybe'
  r = await request(wb)
  check('invalid availability rejected', () => { assert.equal(r.status, 400); assert.match(r.data.message, /isActive/) })
  wb.getWorksheet('Dishes').getCell('G2').value = true
  wb.getWorksheet('Dishes').getCell('D2').value = { formula: '1+2', result: 3 }
  r = await request(wb)
  check('formulas rejected rather than silently importing cached values', () => { assert.equal(r.status, 400); assert.match(r.data.message, /formula/) })
  wb.getWorksheet('Dishes').getCell('D2').value = 700
  wb.getWorksheet('Dishes').getCell('H2').value = 'Keep'
  wb.getWorksheet('Recipes').getRow(2).values = []
  r = await request(wb)
  check('Keep preserves existing recipe while updating price', () => assert.equal(r.status, 200))
  assert.equal(await tx.dishIngredient.count({ where: { dishId: dish.id } }), 1)
  wb.getWorksheet('Dishes').getCell('H2').value = 'Replace'
  r = await request(wb)
  check('explicit Replace with no rows clears recipe', () => assert.equal(r.status, 200))
  assert.equal(await tx.dishIngredient.count({ where: { dishId: dish.id } }), 0)
  r = await request(wb, token, Buffer.from('not an xlsx'))
  check('corrupt workbook returns useful validation error', () => { assert.equal(r.status, 400); assert.match(r.data.message, /valid .xlsx/) })
  // A database failure after menu writes must also roll back the import.
  wb.getWorksheet('Dishes').getCell('D2').value = 999
  const data = await parseMenuWorkbook(Buffer.from(await wb.xlsx.writeBuffer()))
  await assert.rejects(() => db.$transaction(async client => { await applyMenuImport(client, org.id, data); throw new Error('Simulated audit failure') }), /Simulated audit failure/)
  const after = await tx.dish.findUnique({ where: { id: dish.id } })
  check('transaction failure rolls back menu writes', () => assert.equal(after.price, 700))
  const audits = await tx.auditLog.count({ where: { organizationId: org.id, action: 'menu_imported' } })
  check('successful menu imports write an audit record', () => assert.ok(audits))
  const stockAfter = await tx.branchStock.findMany({ where: { organizationId: org.id } })
  const journalCountAfter = await tx.journalEntry.count({ where: { organizationId: org.id } })
  check('menu import leaves stock balances and financial postings unchanged', () => { assert.deepEqual(stockAfter, stockBefore); assert.equal(journalCountAfter, journalCountBefore) })

  // ── pictures: a .zip package, or the workbook with picture files
  const JSZip = require('jszip')
  const fs = require('node:fs')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const jpg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')
  const send = async (parts, auth = token) => {
    const form = new FormData()
    for (const [field, buf, name] of parts) form.append(field, new Blob([buf]), name)
    const res = await fetch(base + '/menu/import', { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: form })
    return { status: res.status, data: await res.json() }
  }
  const pictureBook = (rows) => { const w = createMenuTemplate(); rows.forEach((v, i) => { w.getWorksheet('Dishes').getRow(i + 2).values = v }); return w }
  const pictured = pictureBook([
    ['Pictured', 'Karahi with photo', 'Zip picture', 1650, 'Late night', 1, true, 'Keep', 'photos/Karahi.PNG'],
    ['Pictured', 'Tea with photo', '', 150, 'Late night', 2, true, 'Keep', 'tea.jpg'],
    ['Pictured', 'Soup no photo', '', 450, 'Late night', 3, true, 'Keep', ''],
  ])
  const zip = new JSZip()
  zip.file('menu/My menu.xlsx', Buffer.from(await pictured.xlsx.writeBuffer()))
  zip.file('menu/photos/karahi.png', png); zip.file('menu/drinks/TEA.JPG', jpg); zip.file('menu/extra.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')); zip.file('__MACOSX/menu/._tea.jpg', 'junk')
  r = await send([['file', await zip.generateAsync({ type: 'nodebuffer' }), 'menu-package.zip']])
  const karahi = await tx.dish.findFirst({ where: { organizationId: org.id, name: 'Karahi with photo' } })
  const tea = await tx.dish.findFirst({ where: { organizationId: org.id, name: 'Tea with photo' } })
  const soup = await tx.dish.findFirst({ where: { organizationId: org.id, name: 'Soup no photo' } })
  check('a .zip package imports dishes with their pictures, matched by file name ignoring case and folders', () => {
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.created, 3); assert.equal(r.data.pictures, 2); assert.deepEqual(r.data.unusedPictures, ['extra.webp'])
    assert.ok(karahi.imagePath.endsWith('.png') && fs.existsSync(karahi.imagePath)); assert.ok(tea.imagePath.endsWith('.jpg') && fs.existsSync(tea.imagePath)); assert.equal(soup.imagePath, null)
    assert.deepEqual(fs.readFileSync(karahi.imagePath), png)
  })
  const served = await fetch(`${base}/public/dishes/${karahi.id}/image`)
  check('an imported picture is served on the menu', () => { assert.equal(served.status, 200); assert.match(served.headers.get('content-type') || '', /image\/png/) })
  const oldKarahi = karahi.imagePath
  const second = pictureBook([['Pictured', 'Karahi with photo', 'Workbook + files', 1700, 'Late night', 1, true, 'Keep', 'karahi-new.jpg'], ['Pictured', 'Tea with photo', '', 160, 'Late night', 2, true, 'Keep', '']])
  r = await send([['file', Buffer.from(await second.xlsx.writeBuffer()), 'menu.xlsx'], ['images', jpg, 'karahi-new.jpg']])
  const karahi2 = await tx.dish.findUnique({ where: { id: karahi.id } }), tea2 = await tx.dish.findUnique({ where: { id: tea.id } })
  check('the workbook with chosen pictures replaces a picture; a blank image keeps the current one', () => {
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.updated, 2); assert.equal(r.data.pictures, 1)
    assert.notEqual(karahi2.imagePath, oldKarahi); assert.ok(fs.existsSync(karahi2.imagePath)); assert.equal(tea2.imagePath, tea.imagePath); assert.equal(karahi2.price, 1700)
  })
  for (let i = 0; i < 20 && fs.existsSync(oldKarahi); i++) await new Promise((res) => setTimeout(res, 50))
  check('the replaced picture file is deleted', () => assert.equal(fs.existsSync(oldKarahi), false))
  r = await send([['file', Buffer.from(await pictureBook([['Pictured', 'Missing photo', '', 10, 'Late night', 0, true, 'Keep', 'nowhere.jpg']]).xlsx.writeBuffer()), 'menu.xlsx']])
  const missingCount = await tx.dish.count({ where: { organizationId: org.id, name: 'Missing photo' } })
  check('a picture named in Dishes but not uploaded stops the import with its row', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Dishes row 2: picture "nowhere.jpg" was not uploaded/); assert.equal(missingCount, 0) })
  r = await send([['file', Buffer.from(await pictureBook([['Pictured', 'Fake photo', '', 10, 'Late night', 0, true, 'Keep', 'fake.jpg']]).xlsx.writeBuffer()), 'menu.xlsx'], ['images', Buffer.from('<?php echo 1; ?>'), 'fake.jpg']])
  check('a file that is not really a picture is refused whatever its name', () => { assert.equal(r.status, 400); assert.match(r.data.message, /not a JPG, PNG or WEBP/) })
  r = await send([['file', Buffer.from(await second.xlsx.writeBuffer()), 'menu.xlsx'], ['images', Buffer.concat([jpg, Buffer.alloc(5 * 1024 * 1024)]), 'karahi-new.jpg']])
  check('a picture over 5 MB is refused', () => { assert.equal(r.status, 400); assert.match(r.data.message, /larger than 5 MB/) })
  const twoBooks = new JSZip(); twoBooks.file('a.xlsx', Buffer.from(await second.xlsx.writeBuffer())); twoBooks.file('b.xlsx', Buffer.from(await second.xlsx.writeBuffer()))
  r = await send([['file', await twoBooks.generateAsync({ type: 'nodebuffer' }), 'menu.zip']])
  check('a .zip with two workbooks is refused', () => { assert.equal(r.status, 400); assert.match(r.data.message, /more than one .xlsx/) })
  const dupes = new JSZip(); dupes.file('menu.xlsx', Buffer.from(await second.xlsx.writeBuffer())); dupes.file('a/karahi-new.jpg', jpg); dupes.file('b/karahi-new.jpg', jpg)
  r = await send([['file', await dupes.generateAsync({ type: 'nodebuffer' }), 'menu.zip']])
  check('two pictures with the same file name are refused', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Two pictures are named "karahi-new.jpg"/) })
  r = await send([['file', Buffer.from('not a zip'), 'menu.zip']])
  check('a corrupt .zip returns a clear error', () => { assert.equal(r.status, 400); assert.match(r.data.message, /Could not open this .zip/) })
  const menuDir = path.join(__dirname, '..', 'uploads', 'menu')
  const filesBefore = fs.readdirSync(menuDir).length
  r = await send([['file', Buffer.from(await pictureBook([['Pictured', 'Rollback photo', '', 10, 'No such shift', 0, true, 'Keep', 'karahi-new.jpg']]).xlsx.writeBuffer()), 'menu.xlsx'], ['images', jpg, 'karahi-new.jpg']])
  for (let i = 0; i < 20 && fs.readdirSync(menuDir).length !== filesBefore; i++) await new Promise((res) => setTimeout(res, 50))
  const filesAfter = fs.readdirSync(menuDir).length
  check('a failed import leaves no picture files behind', () => { assert.equal(r.status, 400); assert.equal(filesAfter, filesBefore) })
  r = await send([['file', await zip.generateAsync({ type: 'nodebuffer' }), 'menu-package.zip']], deniedToken)
  check('picture imports need the menu permission', () => assert.equal(r.status, 403))
  const tplRes = await fetch(base + '/menu/import/template', { headers: { Authorization: `Bearer ${token}` } })
  const tpl = new ExcelJS.Workbook(); await tpl.xlsx.load(Buffer.from(await tplRes.arrayBuffer()))
  check('the template has the image column and picture instructions', () => { assert.equal(tpl.getWorksheet('Dishes').getRow(1).getCell(9).text, 'image'); assert.ok(tpl.getWorksheet('Instructions').getColumn(1).values.includes('Pictures')) })
  // remove the picture files this test wrote (the database rows roll back)
  for (const d of await tx.dish.findMany({ where: { organizationId: org.id, category: { name: 'Pictured' } } })) if (d.imagePath) fs.rmSync(d.imagePath, { force: true })
}
