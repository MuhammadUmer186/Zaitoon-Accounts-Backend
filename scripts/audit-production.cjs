// CI gate: `npm audit --omit=dev` must report nothing except the advisories
// listed here, each with the reason it cannot affect FoodSync. Any other
// advisory, at any severity, fails the build.
const { execSync } = require('node:child_process')

const WAIVED = {
  // minimatch < 11.0.1 (ReDoS via crafted glob patterns), reached only through
  // exceljs -> archiver -> glob/readdir-glob. exceljs zips in-memory buffers and
  // never passes user input as a glob pattern. No patched 3.x/5.x release
  // exists, and minimatch 11 breaks glob@7's API. Revisit when exceljs updates.
  'GHSA-g3hv-75wg-m249': 'minimatch via exceljs/archiver; no user-controlled patterns',
}

let report
try {
  report = execSync('npm audit --omit=dev --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
} catch (error) {
  report = error.stdout // npm audit exits non-zero whenever it finds anything
}
const { vulnerabilities = {} } = JSON.parse(report)
const advisories = new Map()
for (const [name, v] of Object.entries(vulnerabilities)) {
  for (const via of v.via) if (typeof via === 'object') advisories.set(via.url, { name, severity: via.severity, title: via.title })
}
const blocking = [...advisories].filter(([url]) => !Object.keys(WAIVED).some(id => url.endsWith(id)))
for (const [url, a] of advisories) console.log(`${blocking.some(([u]) => u === url) ? 'BLOCKING' : 'waived  '} ${a.severity} ${a.name}: ${a.title} ${url}`)
if (blocking.length) { console.error(`${blocking.length} unwaived production advisories`); process.exitCode = 1 }
else console.log(`No unwaived production advisories (${advisories.size} waived)`)
