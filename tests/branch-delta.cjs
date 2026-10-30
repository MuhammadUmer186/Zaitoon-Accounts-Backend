// Incremental ERP checkpoints, conflict reporting and per-PC numbering.
// Cloud and branch are separate fs_qa_* databases.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {createScratch}=require('./scratch-db.cjs');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
const scratch=[];
(async()=>{
 const cloud=await createScratch(),branch=await createScratch();scratch.push(cloud,branch);
 process.env.DATABASE_URL=cloud.url;delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const {buildBranchDelta,replicaDigest}=require('../dist/services/branchReplica');
 const {beginReplica,receiveReplicaPart,commitReplica,replicaHead}=require('../dist/services/branchReplicaTransport');
 const {nextNumber}=require('../dist/utils/numbering'),{nextOrderNo}=require('../dist/utils/menu'),{assertCodeSeries}=require('../dist/utils/branchNumbering');
 const cloudDb=cloud.client(),local=branch.client();
 const ids={org:crypto.randomUUID(),branch:crypto.randomUUID(),other:crypto.randomUUID(),owner:crypto.randomUUID(),item:crypto.randomUUID(),category:crypto.randomUUID(),dish:crypto.randomUUID()};
 // Identical masters in both databases, as provisioning leaves them.
 for(const db of [cloudDb,local]){
  await db.organization.create({data:{id:ids.org,name:'Delta org'}});
  await db.branch.create({data:{id:ids.branch,organizationId:ids.org,name:'PC branch',code:'D'}});
  await db.branch.create({data:{id:ids.other,organizationId:ids.org,name:'Cloud branch',code:'C'}});
  await db.user.create({data:{id:ids.owner,organizationId:ids.org,email:'delta@example.invalid',passwordHash:'x',firstName:'D',lastName:'O'}});
  await db.item.create({data:{id:ids.item,organizationId:ids.org,code:'FLOUR',name:'Flour'}});
  await db.menuCategory.create({data:{id:ids.category,organizationId:ids.org,name:'Mains'}});
  await db.dish.create({data:{id:ids.dish,organizationId:ids.org,categoryId:ids.category,name:'Meal',price:10}});
 }
 // Provisioned history: present in both databases, never in the change log.
 const history=20000,sale=(saleNo,extra={})=>({organizationId:ids.org,branchId:ids.branch,saleNo,saleDate:new Date(),createdBy:ids.owner,subtotal:10,totalAmount:10,netAmount:10,...extra});
 const historyRows=Array.from({length:history},(_,i)=>({id:crypto.randomUUID(),...sale(`H-${i}`)}));
 for(let i=0;i<history;i+=5000){await cloudDb.dailySale.createMany({data:historyRows.slice(i,i+5000)});await local.dailySale.createMany({data:historyRows.slice(i,i+5000)})}
 const token=crypto.randomBytes(32).toString('hex');
 const node=await cloudDb.branchSyncNode.create({data:{organizationId:ids.org,branchId:ids.branch,name:'Delta PC',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),numberSeries:'P7'}});
 await local.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:ids.org,branchId:ids.branch,numberSeries:'P7'}});

 let acked=-1n;
 async function publish(){
  const head=await replicaHead(token);const delta=await buildBranchDelta(local,acked);
  if(!delta)return {fallback:true};
  const tables={...delta.tables,...(delta.deleted.length?{__deleted:delta.deleted}:{})};
  const parts=Object.entries(tables).flatMap(([entity,rows])=>{const r=[];for(let i=0;i<rows.length;i+=200)r.push({entity,part:r.length,rows:rows.slice(i,i+200)});return r});
  const manifest={kind:'delta',schema:delta.schema,revision:delta.revision,baseRevision:head.revision,baseDigest:head.digest,parts:parts.map(p=>({entity:p.entity,part:p.part,rows:p.rows.length,digest:replicaDigest(p.rows)}))};
  const t0=Date.now(),session=await beginReplica(token,manifest);for(const p of parts)await receiveReplicaPart(token,session.id,p);
  const bytes=parts.reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0);
  try{const done=await commitReplica(token,session.id);acked=BigInt(done.revision);await local.branchChangeLog.deleteMany({where:{revision:{lte:acked}}});return {ms:Date.now()-t0,bytes,rows:parts.reduce((n,p)=>n+p.rows.length,0),delta}}
  catch(error){return {error,session}}
 }

 const first=await local.dailySale.create({data:sale('NEW-1')}),second=await local.dailySale.create({data:sale('NEW-2',{netAmount:20})});
 let r=await publish();
 check('the first checkpoint after enrollment is incremental: only new rows travel, not the provisioned history',()=>{assert.equal(r.rows,2);assert.ok(r.bytes<10000)});
 assert.equal(await cloudDb.dailySale.count({where:{branchId:ids.branch}}),history+2);

 await local.dailySale.update({where:{id:second.id},data:{netAmount:25}});await local.dailySale.delete({where:{id:first.id}});
 const changes=[];for(let i=0;i<50;i++)changes.push(local.dailySale.create({data:sale(`BATCH-${i}`)}));await Promise.all(changes);
 r=await publish();
 const updated=await cloudDb.dailySale.findUnique({where:{id:second.id}}),gone=await cloudDb.dailySale.findUnique({where:{id:first.id}});
 check(`an update, a deletion and 50 new sales on top of ${history} rows apply in ${r.ms} ms`,()=>{assert.equal(updated.netAmount,25);assert.equal(gone,null);assert.equal(r.rows,52);assert.ok(r.ms<15000,`took ${r.ms} ms`)});
 const [cloudSum,localSum]=await Promise.all([cloudDb.dailySale.aggregate({where:{branchId:ids.branch},_sum:{netAmount:true},_count:true}),local.dailySale.aggregate({where:{branchId:ids.branch},_sum:{netAmount:true},_count:true})]);
 check('central totals match the branch after incremental checkpoints',()=>assert.deepEqual(cloudSum,localSum));

 // Delete and re-create under the same natural key (unique branch + item).
 const stock=await local.branchStock.create({data:{organizationId:ids.org,branchId:ids.branch,itemId:ids.item,quantityOnHand:3}});await publish();
 await local.branchStock.delete({where:{id:stock.id}});const replacement=await local.branchStock.create({data:{organizationId:ids.org,branchId:ids.branch,itemId:ids.item,quantityOnHand:9}});
 r=await publish();
 const cloudStock=await cloudDb.branchStock.findMany({where:{branchId:ids.branch}});
 check('a row deleted and re-created under the same unique key applies (deletions run first)',()=>{assert.equal(r.error,undefined,r.error&&r.error.message);assert.deepEqual(cloudStock.map(s=>[s.id,s.quantityOnHand]),[[replacement.id,9]])});

 // Move an order line to another order, then delete the emptied order.
 const order=n=>({organizationId:ids.org,branchId:ids.branch,orderNo:n,orderType:'takeaway'});
 const a=await local.customerOrder.create({data:order(5001)}),b=await local.customerOrder.create({data:order(5002)});
 const line=await local.customerOrderItem.create({data:{orderId:a.id,dishId:ids.dish,dishName:'Meal',unitPrice:10,quantity:1,lineTotal:10}});await publish();
 await local.customerOrderItem.update({where:{id:line.id},data:{orderId:b.id}});await local.customerOrder.delete({where:{id:a.id}});
 r=await publish();
 const movedLine=await cloudDb.customerOrderItem.findUnique({where:{id:line.id}});
 check('a line moved between orders and the emptied order deleted apply in one checkpoint',()=>{assert.equal(r.error,undefined,r.error&&r.error.message);assert.equal(movedLine.orderId,b.id)});
 assert.equal(await cloudDb.customerOrder.count({where:{id:a.id}}),0);

 // A unique clash with the cloud is reported, not retried silently.
 await cloudDb.dailySale.create({data:{...sale('CLASH-1'),branchId:ids.other}});
 await local.dailySale.create({data:sale('CLASH-1')});
 r=await publish();
 const flagged=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});
 check('a unique clash is refused as REPLICA_CONFLICT and named on the node',()=>{assert.equal(r.error?.code,'REPLICA_CONFLICT');assert.match(flagged.replicaError,/DailySale/);assert.match(flagged.replicaError,/saleNo/)});
 const status=await cloudDb.dailySale.count({where:{saleNo:'CLASH-1'}});
 check('nothing from the refused checkpoint was applied',()=>assert.equal(status,1));
 await cloudDb.dailySale.deleteMany({where:{saleNo:'CLASH-1',branchId:ids.other}});
 const retried=await commitReplica(token,r.session.id);acked=BigInt(retried.revision);await local.branchChangeLog.deleteMany({where:{revision:{lte:acked}}});
 const cleared=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});
 check('after the duplicate is resolved the same checkpoint commits and the error clears',()=>{assert.equal(cleared.replicaError,null);assert.equal(cleared.replicaRevision,acked)});

 // A gap in the change log can never produce a silently partial delta.
 await local.dailySale.create({data:sale('GAP-1')});await local.dailySale.create({data:sale('GAP-2')});
 const newest=await local.branchChangeLog.findFirst({orderBy:{revision:'desc'}});await local.branchChangeLog.delete({where:{revision:newest.revision}});
 const gapDelta=await buildBranchDelta(local,acked);
 check('a change log that cannot prove full coverage forces a full checkpoint',()=>assert.equal(gapDelta,null));

 // Numbering: each PC numbers in its own series; order numbers are per branch.
 process.env.FOODSYNC_DEPLOYMENT_MODE='branch';
 const pcSale=await nextNumber(local,'dailySale','saleNo','SL',ids.org);
 await assert.rejects(()=>assertCodeSeries(local,ids.org,'E005'),e=>e.code==='CODE_SERIES_REQUIRED');await assertCodeSeries(local,ids.org,'P7-E005');
 delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 await cloudDb.dailySale.create({data:{...sale(`SL-${new Date().getFullYear()}-P7-0005`),branchId:ids.other}});
 const cloudSale=await nextNumber(cloudDb,'dailySale','saleNo','SL',ids.org);
 check('a PC issues document numbers in its own series and the cloud ignores that series',()=>{assert.equal(pcSale,`SL-${new Date().getFullYear()}-P7-0001`);assert.equal(cloudSale,`SL-${new Date().getFullYear()}-0001`)});
 await assert.rejects(()=>assertCodeSeries(cloudDb,ids.org,'P7-E006'),e=>e.code==='CODE_SERIES_RESERVED');await assertCodeSeries(cloudDb,ids.org,'E006');
 check('typed codes: the PC must use its series and the cloud may not',()=>{});
 await cloudDb.customerOrder.create({data:{organizationId:ids.org,branchId:ids.other,orderNo:7000,orderType:'takeaway'}});
 const pcOrderNo=await nextOrderNo(local,ids.org,ids.branch),otherOrderNo=await nextOrderNo(cloudDb,ids.org,ids.other);
 check('order numbers are per branch, so a PC and the cloud cannot collide',()=>{assert.equal(pcOrderNo,5003);assert.equal(otherOrderNo,7001)});
 const idx=await cloudDb.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE tablename='CustomerOrder' AND indexname LIKE 'CustomerOrder_organizationId_%orderNo_key'`);
 check('the database enforces per-branch order numbers',()=>assert.deepEqual(idx.map(i=>i.indexname),['CustomerOrder_organizationId_branchId_orderNo_key']));

 const out=path.resolve(__dirname,'../../outputs/qa-hardening-2026-10-26/delta-profile.json');
 fs.writeFileSync(out,JSON.stringify({measuredAt:new Date().toISOString(),historyRows:history,note:'52 changed rows on top of provisioned history; local machine',checks},null,2));
 console.log(`${checks} incremental checkpoint checks passed.`);
 await cloudDb.$disconnect();await local.$disconnect();await require('../dist/config').prisma.$disconnect();
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{for(const s of scratch)await s.drop().catch(()=>{})});
