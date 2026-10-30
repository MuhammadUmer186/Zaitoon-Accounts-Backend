// Checkpoint build past PostgreSQL's 32,767 bind-parameter limit (fs_qa_* only).
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createScratch}=require('./scratch-db.cjs');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
let branch;
(async()=>{
 branch=await createScratch();process.env.DATABASE_URL=branch.url;
 const {buildBranchReplica}=require('../dist/services/branchReplica');
 const db=branch.client(),org=await db.organization.create({data:{name:'Scale'}}),b=await db.branch.create({data:{organizationId:org.id,name:'Scale',code:'S'}});
 const owner=await db.user.create({data:{organizationId:org.id,email:'scale@example.invalid',passwordHash:'x',firstName:'S',lastName:'O'}});
 await db.branchRuntime.create({data:{id:'local',nodeId:crypto.randomUUID(),organizationId:org.id,branchId:b.id}});
 const total=33000;
 for(let done=0;done<total;done+=5000)await db.dailySale.createMany({data:Array.from({length:Math.min(5000,total-done)},(_,i)=>({organizationId:org.id,branchId:b.id,saleNo:`S-${done+i}`,saleDate:new Date(),createdBy:owner.id,subtotal:1,totalAmount:1,netAmount:1}))});
 const last=await db.dailySale.findFirst({where:{saleNo:'S-32999'}});
 await db.deliveryBreakdown.create({data:{dailySaleId:last.id,platform:'test',amount:1,netAmount:1}});
 const started=Date.now(),snapshot=await buildBranchReplica(db);
 check(`a checkpoint with ${total} parent rows builds (children selected by relation, not an id list)`,()=>{assert.equal(snapshot.tables.DailySale.length,total);assert.deepEqual(snapshot.tables.DeliveryBreakdown.map(r=>r.dailySaleId),[last.id])});
 console.log(`build took ${Date.now()-started} ms`);
 await db.$disconnect();await require('../dist/config').prisma.$disconnect();
 console.log(`${checks} replica scale checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{await branch?.drop().catch(()=>{})});
