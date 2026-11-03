// Isolated QA runner. No application database writes; creates/drops only its own scratch DB.
const path = require('node:path'), fs = require('node:fs'), { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), backend = path.join(root, 'backend');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env') });
const { PrismaClient } = require(path.join(backend, 'node_modules/@prisma/client'));
const label = process.env.QA_RUN_LABEL || 'qa-hardening-2026-10-26';
if (!/^[a-z0-9-]{1,80}$/.test(label)) throw new Error('QA_RUN_LABEL must be a simple output-folder label');
const outputDir = path.join(root,'outputs',label); fs.mkdirSync(outputDir,{recursive:true});
const results = [], start = new Date();
const syncOnly = process.argv.includes('--sync-only');
const name = `fs_qa_${process.pid}_${Date.now()}`;
const original = new URL(process.env.DATABASE_URL), adminUrl = new URL(original), scratch = new URL(original);
adminUrl.pathname = '/postgres'; scratch.pathname = '/' + name;
if (!/^fs_qa_[0-9]+_[0-9]+$/.test(name) || scratch.pathname === original.pathname) throw new Error('Unsafe QA target');
const env = { ...process.env, DATABASE_URL: scratch.toString(), LOGIN_RATE_LIMIT: '30', ZATCA_SANDBOX: '', UI_TEST_HOLD: '', TEST_HR_ONLY: '', TEST_PAYMENT_FIRST: '', TEST_BRANCH_MENU_ONLY: process.argv.includes('--branch-menu-only') ? '1' : '', UI_TEST_PORT: '0' };
async function run(label, file, args = [], timeout = 240000) {
  if ((process.argv.includes('--ordering-only') || process.argv.includes('--branch-menu-only')) && path.dirname(file) === path.join(backend, 'tests') && label !== 'existing-ordering-finance') return;
  if (process.argv.includes('--branch-runtime-only') && path.dirname(file) === path.join(backend, 'tests') && label !== 'branch-runtime') return;
  const log = path.join(outputDir, label + '.log'), fd = fs.openSync(log, 'w'), t = Date.now();
  console.log('RUN', label);
  const outcome = await new Promise(resolve => {
    const child = spawn(process.execPath, [file, ...args], { cwd: backend, env, stdio: ['ignore', fd, fd] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout);
    child.on('error', e => { clearTimeout(timer); resolve({ exitCode: -1, error: e.message }) });
    child.on('exit', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut }) });
  });
  fs.closeSync(fd);
  const output = fs.readFileSync(log, 'utf8');
  const result = { label, ...outcome, durationMs: Date.now() - t, passLines: (output.match(/^PASS /gm) || []).length, failLines: (output.match(/^FAIL /gm) || []).length, log: path.basename(log) };
  results.push(result); console.log('RESULT', JSON.stringify(result));
  fs.writeFileSync(path.join(outputDir, (process.argv.includes('--probes-only') ? 'probe-run-results.json' : 'run-results.json')), JSON.stringify({ started: start, scratchDatabase: name, results }, null, 2));
  return result;
}
(async () => {
  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  let created = false;
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`); created = true;
    console.log('Created isolated QA database:', name);
    const cli = path.join(backend, 'node_modules/prisma/build/index.js');
    if ((await run('schema', cli, ['db','push','--skip-generate','--schema',path.join(backend,'prisma/schema.prisma')])).exitCode) throw new Error('Scratch schema setup failed');
    await run('post-push', cli, ['db','execute','--file',path.join(backend,'prisma/post-push.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('rate-limit-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261026-auth-rate-limit.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-runtime-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261026-branch-runtime.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-menu-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261102-branch-menu.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-ownership-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261026-branch-ownership.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-replica-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261026-branch-replica.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-sync-safety-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261027-branch-sync-safety.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-media-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261027-branch-media.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-payments-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261027-branch-payments.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-wallets-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261027-branch-wallets.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('branch-transfers-addition', cli, ['db','execute','--file',path.join(backend,'prisma/additions/20261027-branch-transfers.sql'),'--schema',path.join(backend,'prisma/schema.prisma')]);
    await run('permission-seed', path.join(backend,'prisma/sync-permissions.js'));
    if (!process.argv.includes('--probes-only') && !process.argv.includes('--branch-only') && !syncOnly) {
    await run('existing-ordering-finance', path.join(backend,'tests/ordering-finance.cjs'));
    await run('existing-hr', path.join(backend,'tests/hr-runner.cjs'));
    await run('existing-free-dish', path.join(backend,'tests/free-dish.cjs'));
    await run('existing-concurrency', path.join(backend,'tests/concurrency-checks.cjs'), [], 240000);
    }
    if (!process.argv.includes('--branch-only') && !syncOnly) await run('security-hardening', path.join(backend,'tests/security-hardening.cjs'), [], 180000);
    if (!process.argv.includes('--branch-only') && !syncOnly) await run('production-hardening', path.join(backend,'tests/production-hardening.cjs'), [], 240000);
    if (!process.argv.includes('--branch-only') && !syncOnly) await run('kitchen-printing', path.join(backend,'tests/kitchen-printing.cjs'), [], 240000);
    if (!process.argv.includes('--branch-only') && !syncOnly) await run('cloud-kitchen-printing', path.join(backend,'tests/cloud-kitchen-printing.cjs'), [], 240000);
    if (!process.argv.includes('--probes-only')) await run('branch-runtime', path.join(backend,'tests/branch-runtime.cjs'), [], 180000);
    // Creates its own cloud and branch scratch databases (two JWT secrets, two processes).
    if (!process.argv.includes('--probes-only')) await run('branch-online', path.join(backend,'tests/branch-online.cjs'), [], 420000);
    if (!syncOnly) {
    if (!process.argv.includes('--probes-only')) await run('schema-guard', path.join(backend,'tests/schema-guard.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('replica-scale', path.join(backend,'tests/replica-scale.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-delta', path.join(backend,'tests/branch-delta.cjs'), [], 600000);
    if (!process.argv.includes('--probes-only')) await run('branch-health', path.join(backend,'tests/branch-health.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-handover', path.join(backend,'tests/branch-handover.cjs'), [], 420000);
    if (!process.argv.includes('--probes-only')) await run('branch-media', path.join(backend,'tests/branch-media.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-zatca', path.join(backend,'tests/branch-zatca.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-payments', path.join(backend,'tests/branch-payments.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-wallets', path.join(backend,'tests/branch-wallets.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-wallet-recovery', path.join(backend,'tests/branch-wallet-recovery.cjs'), [], 420000);
    if (!process.argv.includes('--probes-only')) await run('branch-shared-value', path.join(backend,'tests/branch-shared-value.cjs'), [], 420000);
    if (!process.argv.includes('--probes-only')) await run('stock-concurrency', path.join(backend,'tests/stock-concurrency.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-free-dish', path.join(backend,'tests/branch-free-dish.cjs'), [], 300000);
    if (!process.argv.includes('--probes-only')) await run('branch-transfers', path.join(backend,'tests/branch-transfers.cjs'), [], 300000);
    }
    if (results.some(r=>r.exitCode!==0)) process.exitCode = 1;
  } finally {
    if (created) { await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); console.log('Scratch QA database removed:', name) }
    await admin.$disconnect();
    fs.writeFileSync(path.join(outputDir,(process.argv.includes('--probes-only') ? 'probe-run-results.json' : 'run-results.json')), JSON.stringify({ started: start, finished: new Date(), scratchDatabase: name, scratchRemoved: created, results }, null, 2));
  }
})().catch(e => { console.error(e.message); process.exitCode = 1 });
