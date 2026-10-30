// Measures full-checkpoint cost at increasing history sizes. Not a pass/fail
// test: it records timings to outputs/ for the release assessment.
// Usage: node tests/profile-replica.cjs [rows...]   (fs_qa_* databases only)
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createScratch}=require('./scratch-db.cjs');
const sizes=process.argv.slice(2).map(Number).filter(Boolean);if(!sizes.length)sizes.push(5000,20000,45000);
const scratch=[];
(async()=>{
 const cloud=await createScratch(),branch=await createScratch();scratch.push(cloud,branch);
 process.env.DATABASE_URL=cloud.url;
 const {buildBranchReplica,replicaDigest}=require('../dist/services/branchReplica');
 const {beginReplica,receiveReplicaPart,commitReplica}=require('../dist/services/branchReplicaTransport');
 const cloudDb=cloud.client(),local=branch.client();
 const ids={org:crypto.randomUUID(),branch:crypto.randomUUID(),owner:crypto.randomUUID()};
 for(const db of [cloudDb,local]){
  await db.organization.create({data:{id:ids.org,name:'Profile org'}});
  await db.branch.create({data:{id:ids.branch,organizationId:ids.org,name:'Profile branch',code:'P'}});
  await db.user.create({data:{id:ids.owner,organizationId:ids.org,email:'profile@example.invalid',passwordHash:'x',firstName:'P',lastName:'O'}});
 }
 const token=crypto.randomBytes(32).toString('hex');
 const node=await cloudDb.branchSyncNode.create({data:{organizationId:ids.org,branchId:ids.branch,name:'Profile PC',tokenHash:crypto.createHash('sha256').update(token).digest('hex')}});
 await local.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:ids.org,branchId:ids.branch}});
 const results=[];let inserted=0,base={baseRevision:'-1',baseDigest:null};
 async function checkpoint(label){
  const t0=Date.now(),snap=await buildBranchReplica(local),t1=Date.now();
  const parts=Object.entries(snap.tables).flatMap(([entity,rows])=>{const r=[];for(let i=0;i<Math.max(rows.length,1);i+=200)r.push({entity,part:r.length,rows:rows.slice(i,i+200)});return r});
  const bytes=parts.reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0);
  const manifest={kind:'full',schema:snap.schema,revision:snap.revision,...base,parts:parts.map(p=>({entity:p.entity,part:p.part,rows:p.rows.length,digest:replicaDigest(p.rows)}))};
  const session=await beginReplica(token,manifest);for(const p of parts)await receiveReplicaPart(token,session.id,p);const t2=Date.now();
  const done=await commitReplica(token,session.id),t3=Date.now();
  base={baseRevision:done.revision,baseDigest:done.digest};
  const row={label,rows:inserted,parts:parts.length,payloadMB:+(bytes/1048576).toFixed(1),buildMs:t1-t0,uploadMs:t2-t1,commitMs:t3-t2,totalMs:t3-t0};
  results.push(row);console.log(JSON.stringify(row));
 }
 for(const size of sizes){
  while(inserted<size){const n=Math.min(5000,size-inserted);await local.dailySale.createMany({data:Array.from({length:n},(_,i)=>({organizationId:ids.org,branchId:ids.branch,saleNo:`P-${inserted+i}`,saleDate:new Date(),createdBy:ids.owner,subtotal:10,totalAmount:10,netAmount:10}))});inserted+=n}
  await checkpoint(`full checkpoint at ${size} sales`);
  await local.dailySale.updateMany({where:{saleNo:'P-0'},data:{netAmount:11}});
  await checkpoint(`one changed row at ${size} sales`);
 }
 const file=path.resolve(__dirname,'../../outputs/qa-hardening-2026-10-26/replica-profile.json');
 fs.writeFileSync(file,JSON.stringify({measuredAt:new Date().toISOString(),postgres:'local server (see report)',node:process.version,note:'DailySale rows only; other tables empty. Cloud and branch on the same machine (no network latency).',results},null,2));
 await cloudDb.$disconnect();await local.$disconnect();await require('../dist/config').prisma.$disconnect();
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{for(const s of scratch)await s.drop().catch(()=>{})});
