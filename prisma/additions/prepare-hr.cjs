// Generate only the new HR objects. Useful when the local database also has
// unrelated schema additions that must not be removed by a broad db push.
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const sql = cp.execFileSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', path.join(root, 'prisma/schema.prisma'), '--script'], { encoding: 'utf8', cwd: root })
const statements = sql.split(';').filter(s => /"Hr[A-Za-z]+"/.test(s))
if (statements.some(s => /DROP\s|ALTER TABLE "(?!Hr)/i.test(s))) throw new Error('Unexpected non-additive HR statement')
fs.writeFileSync(path.join(__dirname, 'hr.sql'), '-- Additive HR schema; no existing tables or columns are removed.\nBEGIN;\n' + statements.map(s => s.trim() + ';').join('\n\n') + '\nCOMMIT;\n')
console.log(`${statements.length} additive HR statements prepared`)
