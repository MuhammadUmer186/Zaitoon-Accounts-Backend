// Upgrade schema guard against real fs_qa_* databases. No other database is touched.
const assert=require('node:assert/strict'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createScratch}=require('./scratch-db.cjs');
const guard=path.resolve(__dirname,'../../deploy/windows/schema-guard.cjs'),{classify}=require(guard);
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
function run(url,...args){try{const out=execFileSync(process.execPath,[guard,'--url-env','GUARD_DB',...args],{env:{...process.env,GUARD_DB:url},stdio:['ignore','pipe','pipe']}).toString();return {code:0,out}}catch(e){return {code:e.status,out:String(e.stdout||''),err:String(e.stderr||'')}}}
const scratch=[];
(async()=>{
 check('classifier accepts additive statements',()=>{const p=classify('CREATE TABLE "A" ("id" TEXT NOT NULL);\nALTER TABLE "B" ADD COLUMN "type" TEXT;\nCREATE INDEX "B_type_idx" ON "B"("type");\nALTER TABLE "C" ADD COLUMN "n" INTEGER NOT NULL DEFAULT 0;');assert.equal(p.refused.length,0);assert.equal(p.additive.length,4)});
 check('classifier refuses drops, renames, type changes and new NOT NULL on existing columns',()=>{const p=classify('ALTER TABLE "A" DROP COLUMN "x";\nDROP TABLE "B";\nALTER TABLE "C" ALTER COLUMN "y" SET DATA TYPE INTEGER;\nALTER TABLE "D" RENAME COLUMN "a" TO "b";\nALTER TABLE "E" ALTER COLUMN "z" SET NOT NULL;\nDROP INDEX "I";\nALTER TABLE "F" DROP CONSTRAINT "F_fk";');assert.equal(p.additive.length,0);assert.equal(p.refused.length,7)});
 check('a mixed ALTER TABLE is judged action by action',()=>{const p=classify('ALTER TABLE "A" ADD COLUMN "n" TEXT,\nDROP COLUMN "old";');assert.equal(p.additive.length,1);assert.equal(p.refused.length,1)});

 const current=await createScratch();scratch.push(current);
 let r=run(current.url);
 check('a database at the shipped schema (with all additive SQL) needs no change',()=>{assert.equal(r.code,0,r.out+r.err);assert.deepEqual(JSON.parse(r.out).refused,[])});

 const older=await createScratch();scratch.push(older);const olderDb=older.client();
 // Simulate a PC on the previous release: columns added by this release are absent.
 await olderDb.$executeRawUnsafe('ALTER TABLE "BranchRemoteCommand" DROP COLUMN "attempts", DROP COLUMN "claimedAt"');
 await olderDb.$executeRawUnsafe('DROP INDEX "BranchRemoteCommand_status_createdAt_idx"');
 await olderDb.$executeRawUnsafe('ALTER TABLE "BranchRuntime" DROP COLUMN "pendingReplicaDigest"');
 const org=await olderDb.organization.create({data:{name:'Upgrade keeps data'}});
 r=run(older.url);
 check('an older database reports additive changes without applying them',()=>{assert.equal(r.code,2,r.out+r.err);assert.ok(JSON.parse(r.out).additive>=3)});
 r=run(older.url,'--apply');
 const cols=await olderDb.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='BranchRemoteCommand' AND column_name IN ('attempts','claimedAt') ORDER BY 1`);
 check('additive upgrade applies in one transaction and keeps existing rows',async()=>{});assert.equal(r.code,0,r.out+r.err);assert.deepEqual(cols.map(c=>c.column_name),['attempts','claimedAt']);assert.equal(await olderDb.organization.count({where:{id:org.id}}),1);
 r=run(older.url);check('after upgrade the guard reports no remaining difference',()=>assert.equal(r.code,0,r.out+r.err));
 await olderDb.$disconnect();

 const drift=await createScratch();scratch.push(drift);const driftDb=drift.client();
 await driftDb.$executeRawUnsafe('ALTER TABLE "Organization" ADD COLUMN "legacyNote" TEXT');
 const kept=await driftDb.organization.create({data:{name:'Drift org'}});await driftDb.$executeRawUnsafe(`UPDATE "Organization" SET "legacyNote"='must survive' WHERE "id"='${kept.id}'`);
 await driftDb.$executeRawUnsafe('ALTER TABLE "BranchRemoteCommand" DROP COLUMN "attempts"');
 r=run(drift.url,'--apply');
 const note=await driftDb.$queryRawUnsafe(`SELECT "legacyNote" FROM "Organization" WHERE "id"='${kept.id}'`);
 const attempts=await driftDb.$queryRawUnsafe(`SELECT 1 FROM information_schema.columns WHERE table_name='BranchRemoteCommand' AND column_name='attempts'`);
 check('drift that db push would drop is refused and nothing is applied, not even the safe part',()=>{assert.equal(r.code,3,r.out+r.err);assert.ok(JSON.parse(r.out).refused.some(s=>/DROP COLUMN "legacyNote"/.test(s)));assert.equal(note[0].legacyNote,'must survive');assert.equal(attempts.length,0)});
 check('guard output never contains the database URL',()=>assert.ok(!r.out.includes(drift.url)&&!r.out.includes('postgresql://')));
 await driftDb.$disconnect();
 console.log(`${checks} schema guard checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{for(const s of scratch)await s.drop().catch(()=>{})});
