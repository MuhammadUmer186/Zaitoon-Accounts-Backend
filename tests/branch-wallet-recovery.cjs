// Shared-wallet crash/restore correctness (fs_qa_* databases only). The PC runs
// as separate processes (helpers/pc-wallet.cjs); a "restore" is a byte copy of
// the PC database taken earlier, exactly what a backup restore produces.
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const exec=require('node:util').promisify(require('node:child_process').execFile),{createScratch}=require('./scratch-db.cjs');
const {PrismaClient}=require('@prisma/client');
let cloud,pc,db,server,admin,copies=[],checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
(async()=>{
 cloud=await createScratch();pc=await createScratch();Object.assign(process.env,{DATABASE_URL:cloud.url,NODE_ENV:'test'});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{exportBranch}=require('../dist/services/branchProvisioning'),{importBranch}=require('../dist/services/branchImport'),{signAccessToken}=require('../dist/utils/jwt');
 db=cloud.client();const adminUrl=new URL(process.env.DATABASE_URL);adminUrl.pathname='/postgres';admin=new PrismaClient({datasources:{db:{url:adminUrl.toString()}}});
 for(const key of ['can_use_pos','can_manage_orders','can_refund','can_manage_settings','can_manage_users','can_view_financial_reports'])await db.permission.upsert({where:{key},create:{key,module:'orders'},update:{}});
 const org=await db.organization.create({data:{name:'Wallet recovery QA',requireTillForCash:false}}),branch=await db.branch.create({data:{organizationId:org.id,code:'ZB-002',name:'Wallet branch'}});
 const owner=await db.user.create({data:{organizationId:org.id,email:'wallet-recovery@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'Owner'}}),role=await db.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});await db.userRole.create({data:{userId:owner.id,roleId:role.id}});
 for(const [key,accountClass,normalBalance]of[['CASH_ON_HAND','ASSET','DEBIT'],['CARD_CLEARING','ASSET','DEBIT'],['SALES_REVENUE','REVENUE','CREDIT'],['GIFT_CARD_LIABILITY','LIABILITY','CREDIT'],['LOYALTY_LIABILITY','LIABILITY','CREDIT'],['OUTPUT_VAT','LIABILITY','CREDIT'],['COST_OF_SALES','EXPENSE','DEBIT'],['INVENTORY','ASSET','DEBIT']]){const a=await db.account.create({data:{organizationId:org.id,code:key,name:key,accountClass,normalBalance}});await db.accountingMapping.create({data:{organizationId:org.id,key,accountId:a.id}})}
 await db.commerceSettings.create({data:{organizationId:org.id,loyaltyEarnPerUnit:1,loyaltyPointValue:1,updatedBy:owner.id}});
 const customer=await db.customer.create({data:{organizationId:org.id,name:'Shared customer',phone:'+923001112244',loyaltyPoints:100}});
 const category=await db.menuCategory.create({data:{organizationId:org.id,name:'Meals'}}),dish=await db.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Meal',price:25}});
 const orders=[];for(let i=0;i<6;i++)orders.push(await db.customerOrder.create({data:{organizationId:org.id,branchId:branch.id,orderNo:i+1,orderType:'takeaway',status:'open',customerId:customer.id,itemsTotal:25,subtotal:25,totalAmount:25,items:{create:{dishId:dish.id,dishName:dish.name,unitPrice:25,quantity:1,lineTotal:25,status:'accepted'}}}}));
 const card=await db.giftCard.create({data:{organizationId:org.id,code:'GC-REST-0001',balance:100,initialAmount:100,issuedBranchId:branch.id,createdBy:owner.id}});
 const token=crypto.randomBytes(32).toString('hex'),node=await db.branchSyncNode.create({data:{organizationId:org.id,branchId:branch.id,name:'PC',numberSeries:'P1',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),provisionedBy:owner.id}});
 {const local=pc.client();await importBranch(local,await exportBranch({user:{id:owner.id,organizationId:org.id,email:owner.email}},branch.id));await local.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:org.id,branchId:branch.id,numberSeries:'P1'}});await local.$disconnect()}
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const origin=`http://127.0.0.1:${server.address().port}`;
 const env={...process.env,FOODSYNC_DEPLOYMENT_MODE:'branch',BRANCH_CLOUD_URL:origin,BRANCH_SYNC_TOKEN:token,JWT_SECRET:crypto.randomBytes(32).toString('hex')};
 let pcUrl=pc.url;
 async function execute(action,order,lines=[{method:'gift_card',amount:25,giftCardCode:card.code}],extra={}){const out=await exec(process.execPath,[path.join(__dirname,'helpers/pc-wallet.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...env,DATABASE_URL:pcUrl,WALLET_TEST_INPUT:JSON.stringify({action,actorId:owner.id,organizationId:org.id,order:{id:order.id,organizationId:org.id,customerId:customer.id},lines,...extra})}});return JSON.parse(out.stdout.trim().split('\n').pop())}
 async function backup(){const name=`fs_qa_${process.pid}_${Date.now()}${copies.length}9`;await admin.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${pc.name}"`);copies.push(name);const u=new URL(pc.url);u.pathname='/'+name;return u.toString()}
 const balance=async()=>(await db.giftCard.findUnique({where:{id:card.id}})).balance;
 const adminToken=signAccessToken(owner.id,org.id,owner.email);
 async function adminApi(method,route,body){const r=await fetch(origin+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+adminToken},...(body!==undefined&&{body:JSON.stringify(body)})});return {status:r.status,data:await r.json().catch(()=>null)}}

 // --- same-head restore: the order exists in the backup, its payment does not.
 const restored=await backup();
 let r=await execute('complete',orders[0]);assert.equal(r.status,200,JSON.stringify(r));await execute('flush',orders[0]);
 const afterFirst=await balance();check('the original PC charges the gift card once and the cloud commits it',()=>assert.equal(afterFirst,75));
 const head=await db.branchSyncNode.findUnique({where:{id:node.id}});assert.equal(head.replicaRevision,-1n);// ERP head unchanged since the backup
 pcUrl=restored;
 r=await execute('complete',orders[0],undefined,{expectError:true});
 check('a PC restored to before a paid sale cannot charge the same order again (same ERP head)',()=>{assert.notEqual(r.status,200,JSON.stringify(r));assert.equal(r.body?.code??r.error,'WALLET_RESTORE_DETECTED')});
 const afterRetry=await balance();check('the customer was charged exactly once',()=>assert.equal(afterRetry,75));
 r=await execute('flush',orders[0]);
 check('the restored PC does not release or commit anything on the strength of receipts it lost',()=>assert.equal(r.result,false));
 assert.equal(await balance(),75);assert.equal((await db.branchWalletReservation.count({where:{state:'committed',reference:orders[0].id}})),1);
 r=await execute('spend',orders[1],undefined,{expectError:true});
 check('every shared spend from the restored PC stops until an operator reviews it',()=>assert.equal(r.error,'WALLET_RESTORE_DETECTED'));
 const flagged=await db.branchSyncNode.findUnique({where:{id:node.id}});
 check('the cloud records the restore with the position the PC reported',()=>{assert.ok(flagged.walletRestoreDetectedAt);assert.ok(flagged.walletSequenceReported!==null)});
 let list=await adminApi('GET',`/branch-sync/nodes/${node.id}/wallet-holds`);
 check('operators see the committed charge for the order the restored PC lost',()=>{assert.equal(list.status,200);assert.equal(list.data.restoreDetected,true);assert.ok(list.data.holds.some(h=>h.orderId===orders[0].id&&h.state==='committed'))});
 r=await adminApi('POST',`/branch-sync/nodes/${node.id}/wallet-recovery/accept`,{reason:'short'});
 check('accepting a restored PC needs a recorded reason',()=>assert.equal(r.status,400));
 r=await adminApi('POST',`/branch-sync/nodes/${node.id}/wallet-recovery/accept`,{reason:'PC restored from backup after disk failure; order 1 confirmed paid by gift card'});
 check('an operator accepts the restored PC position with an audited reason',()=>assert.equal(r.status,200));
 r=await execute('complete',orders[0],undefined,{expectError:true});
 check('even after acceptance the already-charged order is refused, not charged twice',()=>{assert.notEqual(r.status,200);assert.equal(r.body?.code,'WALLET_ALREADY_PAID')});
 assert.equal(await balance(),75);
 r=await execute('complete',orders[1]);await execute('flush',orders[1]);
 check('after acceptance the restored PC can take new shared payments',()=>assert.equal(r.status,200,JSON.stringify(r)));assert.equal(await balance(),50);

 // --- legitimate retries -----------------------------------------------------
 r=await execute('rollback',orders[2],undefined,{expectError:true});assert.equal(r.error,'EXPECTED_ROLLBACK');assert.equal(await balance(),25);
 r=await execute('complete',orders[2]);
 check('retrying a payment whose first local attempt rolled back succeeds without waiting for recovery',()=>assert.equal(r.status,200,JSON.stringify(r)));
 await execute('flush',orders[2]);
 const [rb,rc,rr]=[await balance(),await db.branchWalletReservation.count({where:{orderId:orders[2].id,reference:orders[2].id,state:'committed'}}),await db.branchWalletReservation.count({where:{orderId:orders[2].id,state:'released'}})];
 check('the rolled-back attempt is released, so the order is charged once',()=>{assert.equal(rb,25);assert.equal(rc,1);assert.equal(rr,1)});
 const pointsBefore=(await db.customer.findUnique({where:{id:customer.id}})).loyaltyPoints;
 const racing=await Promise.all([execute('spend',orders[3],[{method:'loyalty',amount:10}],{expectError:true}),execute('spend',orders[3],[{method:'loyalty',amount:10}],{expectError:true})]);
 await execute('flush',orders[3]);
 const racedPoints=(await db.customer.findUnique({where:{id:customer.id}})).loyaltyPoints;
 check('two concurrent payment attempts for one order debit once',()=>{assert.equal(racedPoints,pointsBefore-10);assert.equal(racing.filter(x=>x.ok).length,1)});
 r=await execute('spend',orders[3],[{method:'gift_card',amount:5,giftCardCode:card.code}],{expectError:true});
 check('a changed tender for an already-paid order is refused',()=>assert.equal(r.error,'WALLET_ALREADY_PAID'));
 r=await execute('refund',orders[3]);await execute('flush',orders[3]);
 const refundedPoints=(await db.customer.findUnique({where:{id:customer.id}})).loyaltyPoints;check('a refund still returns the original charge after the fence',()=>assert.equal(refundedPoints,pointsBefore));

 // --- holds left by a revoked/lost PC ------------------------------------------
 r=await execute('rollback',orders[4],undefined,{expectError:true});assert.equal(await balance(),0);
 await db.branchSyncNode.update({where:{id:node.id},data:{isActive:false}});
 list=await adminApi('GET',`/branch-sync/nodes/${node.id}/wallet-holds`);
 const open=list.data.holds.find(h=>h.state==='reserved');
 check('a hold left by a revoked PC stays withheld and visible',()=>{assert.ok(open);assert.equal(open.orderId,orders[4].id)});
 assert.equal(await balance(),0);
 await db.branchWalletReservation.update({where:{id:open.id},data:{createdAt:new Date(Date.now()-20*60000)}});
 const pcs=await adminApi('GET','/branch-sync/nodes');const listed=pcs.data.data.find(n=>n.id===node.id);
 check('a hold withheld for over 15 minutes raises an operator alert',()=>assert.ok(listed.alerts.some(a=>a.code==='WALLET_HOLDS_UNRESOLVED'),JSON.stringify(listed.alerts)));
 r=await adminApi('POST',`/branch-sync/nodes/${node.id}/wallet-holds/${open.id}/resolve`,{action:'release',reason:'too short'});
 check('resolving a hold needs a recorded reason',()=>assert.equal(r.status,400));
 r=await adminApi('POST',`/branch-sync/nodes/${node.id}/wallet-holds/${open.id}/resolve`,{action:'release',reason:'PC lost; till records show order 5 was never paid',evidenceConfirmed:true});
 const resolved=await db.branchWalletReservation.findUnique({where:{id:open.id}});
 check('an operator releases it with evidence; the money returns once and the decision is recorded',()=>{assert.equal(r.status,200);assert.equal(resolved.state,'released');assert.equal(resolved.resolvedBy,owner.id);assert.match(resolved.resolutionReason,/never paid/)});
 assert.equal(await balance(),25);
 r=await adminApi('POST',`/branch-sync/nodes/${node.id}/wallet-holds/${open.id}/resolve`,{action:'release',reason:'PC lost; till records show order 5 was never paid',evidenceConfirmed:true});
 check('a repeated resolution does not move money again',()=>assert.equal(r.status,409));assert.equal(await balance(),25);
 console.log(`${checks} wallet recovery checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await db?.$disconnect();await require('../dist/config').prisma.$disconnect();for(const name of copies)await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(()=>{});await admin?.$disconnect();await pc?.drop();await cloud?.drop()});
