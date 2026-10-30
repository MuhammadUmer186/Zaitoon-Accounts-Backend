// Stock helper and wastage-approval concurrency/rollback regressions (fs_qa_* only).
const assert=require('node:assert/strict'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createScratch}=require('./scratch-db.cjs');
let scratch,server,db,checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
const round=n=>Math.round(n*1e6)/1e6;
(async()=>{
 scratch=await createScratch();
 execFileSync(process.execPath,[path.resolve(__dirname,'../prisma/sync-permissions.js')],{env:{...process.env,DATABASE_URL:scratch.url},stdio:'pipe'});
 Object.assign(process.env,{DATABASE_URL:scratch.url,NODE_ENV:'test'});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{prisma}=require('../dist/config'),{applyStockIn,applyStockOut}=require('../dist/utils/stock'),{signAccessToken}=require('../dist/utils/jwt');
 db=scratch.client();
 const org=await db.organization.create({data:{name:'Stock QA'}}),branch=await db.branch.create({data:{organizationId:org.id,name:'Stock branch',code:'SB'}});
 const user=await db.user.create({data:{organizationId:org.id,email:'stock@example.invalid',passwordHash:'x',firstName:'S',lastName:'Q'}}),role=await db.role.create({data:{organizationId:org.id,name:'super_admin',displayName:'SA'}});await db.userRole.create({data:{userId:user.id,roleId:role.id}});
 const accounts={};for(const [key,accountClass,normalBalance]of[['INVENTORY','ASSET','DEBIT'],['WASTAGE_EXPENSE','EXPENSE','DEBIT']]){const a=await db.account.create({data:{organizationId:org.id,code:key,name:key,accountClass,normalBalance}});accounts[key]=await db.accountingMapping.create({data:{organizationId:org.id,key,accountId:a.id}})}
 const item=await db.item.create({data:{organizationId:org.id,code:'FLOUR',name:'Flour'}}),fresh=await db.item.create({data:{organizationId:org.id,code:'NEW',name:'New item'}}),scarce=await db.item.create({data:{organizationId:org.id,code:'SCARCE',name:'Scarce'}});
 await db.branchStock.createMany({data:[{organizationId:org.id,branchId:branch.id,itemId:item.id,quantityOnHand:100,averageCost:2,totalValue:200},{organizationId:org.id,branchId:branch.id,itemId:scarce.id,quantityOnHand:5,averageCost:3,totalValue:15}]});
 const base={organizationId:org.id,branchId:branch.id,createdBy:user.id};
 const stockIn=(itemId,quantity,unitCost)=>prisma.$transaction(tx=>applyStockIn(tx,{...base,itemId,quantity,unitCost}));
 const stockOut=(itemId,quantity)=>prisma.$transaction(tx=>applyStockOut(tx,{...base,itemId,quantity}));
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const base_url=`http://127.0.0.1:${server.address().port}/api/v1`,token=signAccessToken(user.id,org.id,user.email);
 const api=async(method,route,body)=>{const r=await fetch(base_url+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},...(body!==undefined&&{body:JSON.stringify(body)})});return {status:r.status,data:await r.json().catch(()=>null)}};
 const wastage=async quantity=>{const r=await api('POST','/inventory/wastage',{branchId:branch.id,reportDate:new Date().toISOString(),items:[{itemId:item.id,quantity,unitCost:2,totalValue:quantity*2,reason:'spoiled'}]});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.id??r.data.data?.id};

 // Mixed concurrent writers on one item: purchases, sales/transfers out and wastage.
 const reports=await Promise.all([wastage(3),wastage(2)]);
 const results=await Promise.allSettled([
  ...Array.from({length:15},()=>stockIn(item.id,2,5)),
  ...Array.from({length:20},()=>stockOut(item.id,1)),
  ...reports.map(id=>api('POST',`/inventory/wastage/${id}/approve`)),
 ]);
 const failed=results.filter(r=>r.status==='rejected'||r.value?.status>=300);
 const row=await db.branchStock.findUnique({where:{branchId_itemId:{branchId:branch.id,itemId:item.id}}});
 // stock-out movements store a positive quantity: count them by type.
 const byType=Object.fromEntries((await db.stockMovement.groupBy({by:['movementType'],where:{branchId:branch.id,itemId:item.id},_sum:{quantity:true},_count:{_all:true}})).map(g=>[g.movementType,g]));
 check('55 concurrent purchases, sales and wastage approvals all apply exactly once',()=>{assert.equal(failed.length,0,JSON.stringify(failed.map(f=>f.reason?.message??f.value?.data)));assert.equal(byType.stock_in._count._all,15);assert.equal(byType.stock_out._count._all,20);assert.equal(byType.wastage._count._all,2)});
 check('final quantity equals opening + purchases - sales - wastage (no lost update)',()=>assert.equal(row.quantityOnHand,100+30-20-5));
 check('stock value stays consistent with quantity and average cost',()=>assert.equal(round(row.totalValue),round(row.quantityOnHand*row.averageCost)));
 const approvedAgain=await api('POST',`/inventory/wastage/${reports[0]}/approve`);
 const again=await db.stockMovement.count({where:{referenceType:'wastage_report',referenceId:reports[0]}});
 check('approving a wastage report again changes nothing',()=>{assert.equal(approvedAgain.status,400);assert.equal(again,1)});

 // Missing stock row: concurrent first receipts create one row.
 const created=await Promise.allSettled(Array.from({length:10},()=>stockIn(fresh.id,1,4)));
 const freshRows=await db.branchStock.findMany({where:{branchId:branch.id,itemId:fresh.id}});
 check('concurrent first receipts of an item create one stock row with every unit',()=>{assert.ok(created.every(c=>c.status==='fulfilled'),JSON.stringify(created.filter(c=>c.status==='rejected').map(c=>c.reason.message)));assert.equal(freshRows.length,1);assert.equal(freshRows[0].quantityOnHand,10);assert.equal(freshRows[0].totalValue,40)});

 // Overselling under concurrency is refused, never negative.
 const outs=await Promise.allSettled(Array.from({length:10},()=>stockOut(scarce.id,1)));
 const scarceRow=await db.branchStock.findUnique({where:{branchId_itemId:{branchId:branch.id,itemId:scarce.id}}});
 check('ten concurrent sales of five units: five succeed, five are refused, stock reaches zero',()=>{assert.equal(outs.filter(o=>o.status==='fulfilled').length,5);assert.ok(outs.filter(o=>o.status==='rejected').every(o=>o.reason.code==='INSUFFICIENT_STOCK'));assert.equal(scarceRow.quantityOnHand,0)});

 // Concurrent approvals of the same report post once.
 const twice=await wastage(4);const racing=await Promise.all(Array.from({length:4},()=>api('POST',`/inventory/wastage/${twice}/approve`)));
 const twiceMoves=await db.stockMovement.count({where:{referenceType:'wastage_report',referenceId:twice}}),twiceJournals=await db.journalEntry.count({where:{referenceType:'wastage_report',referenceId:twice}});
 check('four simultaneous approvals of one wastage report post it once',()=>{assert.equal(racing.filter(r=>r.status===200).length,1,JSON.stringify(racing.map(r=>r.status)));assert.equal(twiceMoves,1);assert.equal(twiceJournals,1)});

 // Failure after the stock movement, before the journal: everything rolls back.
 const before=await db.branchStock.findUnique({where:{branchId_itemId:{branchId:branch.id,itemId:item.id}}});
 const doomed=await wastage(6);
 await db.accountingMapping.delete({where:{id:accounts.WASTAGE_EXPENSE.id}});
 const broken=await api('POST',`/inventory/wastage/${doomed}/approve`);
 const [afterStock,doomedMoves,doomedReport,doomedJournals]=await Promise.all([db.branchStock.findUnique({where:{branchId_itemId:{branchId:branch.id,itemId:item.id}}}),db.stockMovement.count({where:{referenceId:doomed}}),db.wastageReport.findUnique({where:{id:doomed}}),db.journalEntry.count({where:{referenceId:doomed}})]);
 check('a journal failure after stock was reduced rolls back stock, movement and approval together',()=>{assert.ok(broken.status>=400);assert.equal(afterStock.quantityOnHand,before.quantityOnHand);assert.equal(afterStock.totalValue,before.totalValue);assert.equal(doomedMoves,0);assert.equal(doomedReport.status,'draft');assert.equal(doomedJournals,0)});
 console.log(`${checks} stock concurrency checks passed.`);
 await prisma.$disconnect();
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await db?.$disconnect();await scratch?.drop()});
