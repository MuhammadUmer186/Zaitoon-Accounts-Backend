// Shared-value workflows on a branch PC (online-only policy): gift-card sales,
// house-account payments and refunds of sales paid in the cloud before the PC
// took over. Cloud in this process; PC steps as separate processes. fs_qa_* only.
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const exec=require('node:util').promisify(require('node:child_process').execFile),{createScratch}=require('./scratch-db.cjs');
let cloud,pc,db,local,server,checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
(async()=>{
 cloud=await createScratch();pc=await createScratch();Object.assign(process.env,{DATABASE_URL:cloud.url,NODE_ENV:'test'});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{exportBranch}=require('../dist/services/branchProvisioning'),{importBranch}=require('../dist/services/branchImport');
 db=cloud.client();
 for(const key of ['can_use_pos','can_manage_orders','can_refund','can_manage_customers'])await db.permission.upsert({where:{key},create:{key,module:'orders'},update:{}});
 const org=await db.organization.create({data:{name:'Shared value QA',requireTillForCash:false}}),branch=await db.branch.create({data:{organizationId:org.id,code:'ZB-002',name:'Branch'}});
 const owner=await db.user.create({data:{organizationId:org.id,email:'shared-value@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'Owner'}}),role=await db.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});await db.userRole.create({data:{userId:owner.id,roleId:role.id}});
 for(const [key,accountClass,normalBalance]of[['CASH_ON_HAND','ASSET','DEBIT'],['CARD_CLEARING','ASSET','DEBIT'],['SALES_REVENUE','REVENUE','CREDIT'],['GIFT_CARD_LIABILITY','LIABILITY','CREDIT'],['LOYALTY_LIABILITY','LIABILITY','CREDIT'],['ACCOUNTS_RECEIVABLE','ASSET','DEBIT'],['OUTPUT_VAT','LIABILITY','CREDIT'],['COST_OF_SALES','EXPENSE','DEBIT'],['INVENTORY','ASSET','DEBIT']]){const a=await db.account.create({data:{organizationId:org.id,code:key,name:key,accountClass,normalBalance}});await db.accountingMapping.create({data:{organizationId:org.id,key,accountId:a.id}})}
 await db.commerceSettings.create({data:{organizationId:org.id,loyaltyEarnPerUnit:1,loyaltyPointValue:1,updatedBy:owner.id}});
 const customer=await db.customer.create({data:{organizationId:org.id,name:'Account customer',phone:'+923001112255',loyaltyPoints:50,houseAccountEnabled:true,creditLimit:500,houseBalance:60}});
 const category=await db.menuCategory.create({data:{organizationId:org.id,name:'Meals'}}),dish=await db.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Meal',price:25}});
 // A sale paid in the cloud before cutover: gift card debit and earned points, as checkout records them.
 const oldCard=await db.giftCard.create({data:{organizationId:org.id,code:'GC-OLDC-0001',balance:75,initialAmount:100,issuedBranchId:branch.id,createdBy:owner.id}});
 const cloudSale=await db.customerOrder.create({data:{organizationId:org.id,branchId:branch.id,orderNo:1,orderType:'takeaway',status:'completed',closedAt:new Date(),customerId:customer.id,itemsTotal:25,subtotal:25,totalAmount:25,paymentMethod:'gift_card',payments:[{method:'gift_card',amount:25}],items:{create:{dishId:dish.id,dishName:dish.name,unitPrice:25,quantity:1,lineTotal:25,status:'served'}}}});
 await db.giftCardTransaction.create({data:{organizationId:org.id,giftCardId:oldCard.id,type:'redeem',amount:-25,balanceAfter:75,orderId:cloudSale.id,referenceKey:`debit:${cloudSale.id}:0`,userId:owner.id}});
 await db.loyaltyTransaction.create({data:{organizationId:org.id,customerId:customer.id,type:'earn',points:25,value:25,balanceAfter:50,orderId:cloudSale.id,referenceKey:`earn:${cloudSale.id}`,userId:owner.id}});
 const openOrder=await db.customerOrder.create({data:{organizationId:org.id,branchId:branch.id,orderNo:2,orderType:'takeaway',status:'open',customerId:customer.id,itemsTotal:25,subtotal:25,totalAmount:25,items:{create:{dishId:dish.id,dishName:dish.name,unitPrice:25,quantity:1,lineTotal:25,status:'accepted'}}}});
 const token=crypto.randomBytes(32).toString('hex'),node=await db.branchSyncNode.create({data:{organizationId:org.id,branchId:branch.id,name:'PC',numberSeries:'P1',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),provisionedBy:owner.id}});
 local=pc.client();await importBranch(local,await exportBranch({user:{id:owner.id,organizationId:org.id,email:owner.email}},branch.id));await local.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:org.id,branchId:branch.id,numberSeries:'P1'}});
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const origin=`http://127.0.0.1:${server.address().port}`;
 const env={...process.env,DATABASE_URL:pc.url,FOODSYNC_DEPLOYMENT_MODE:'branch',BRANCH_CLOUD_URL:origin,BRANCH_SYNC_TOKEN:token,JWT_SECRET:crypto.randomBytes(32).toString('hex')};
 async function pcRun(action,extra={},order=openOrder){const out=await exec(process.execPath,[path.join(__dirname,'helpers/pc-wallet.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...env,WALLET_TEST_INPUT:JSON.stringify({action,actorId:owner.id,organizationId:org.id,order:{id:order.id,organizationId:org.id,customerId:customer.id},lines:[{method:'cash',amount:1}],...extra})}});return JSON.parse(out.stdout.trim().split('\n').pop())}
 const http=(method,route,body)=>pcRun('http',{method,route,body,expectError:true});
 const flush=()=>pcRun('flush');

 // --- gift card sold at the branch ------------------------------------------
 const saleId=crypto.randomUUID();
 let r=await http('POST','/gift-cards',{requestId:saleId,branchId:branch.id,method:'cash',amount:40,customerId:customer.id});
 const code=r.body?.code,pendingCard=code&&await db.giftCard.findFirst({where:{organizationId:org.id,code}});
 check('a gift card sold at the branch is created centrally but not spendable before confirmation',()=>{assert.equal(r.status,201,JSON.stringify(r));assert.match(code,/^GC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);assert.equal(pendingCard.status,'pending');assert.equal(pendingCard.balance,40)});
 const localReceipt=await local.customerReceipt.findFirst({where:{requestId:saleId}}),journal=localReceipt&&await local.journalEntry.findUnique({where:{id:localReceipt.journalEntryId}});
 check('the branch records the cash and the gift-card liability journal locally',()=>{assert.equal(localReceipt.type,'gift_card_sale');assert.equal(localReceipt.amount,40);assert.ok(journal)});
 r=await http('POST','/gift-cards',{requestId:saleId,branchId:branch.id,method:'cash',amount:40,customerId:customer.id});
 check('retrying the same sale returns the same card without a second card',()=>{assert.equal(r.status,200);assert.equal(r.body.code,code)});
 assert.equal(await db.giftCard.count({where:{organizationId:org.id,issuedBranchId:branch.id,status:{in:['pending','active']},code:{not:'GC-OLDC-0001'}}}),1);
 await flush();
 const active=await db.giftCard.findFirst({where:{code}}),issueTx=await db.giftCardTransaction.count({where:{giftCardId:active.id,type:'issue'}});
 check('once confirmed the card is active with one issue record',()=>{assert.equal(active.status,'active');assert.equal(issueTx,1)});
 r=await pcRun('spend',{lines:[{method:'gift_card',amount:15,giftCardCode:code}],expectError:true});await flush();
 const spentCard=await db.giftCard.findFirst({where:{code}});
 check('the new card can then be spent at the branch',()=>{assert.equal(r.ok,true,JSON.stringify(r));assert.equal(spentCard.balance,25)});
 await local.organization.update({where:{id:org.id},data:{requireTillForCash:true}});
 r=await http('POST','/gift-cards',{requestId:crypto.randomUUID(),branchId:branch.id,method:'cash',amount:30});
 const orphan=await db.giftCard.findFirst({where:{organizationId:org.id,status:'pending'}});
 check('a sale that fails locally after the cloud reserved its card leaves the card unusable',()=>{assert.equal(r.body?.code,'TILL_REQUIRED');assert.ok(orphan)});
 await flush();
 const voided=await db.giftCard.findUnique({where:{id:orphan.id}});
 check('recovery voids the card of a sale the branch never recorded',()=>assert.equal(voided.status,'void'));
 await local.organization.update({where:{id:org.id},data:{requireTillForCash:false}});

 // --- house-account payment at the branch -------------------------------------
 r=await http('POST',`/customers/${customer.id}/payments`,{requestId:crypto.randomUUID(),branchId:branch.id,amount:100,method:'cash'});
 check('the central balance refuses an overpayment before any money is taken',()=>{assert.equal(r.status,409);assert.equal(r.body.code,'OVERPAYMENT')});
 assert.equal(await local.customerReceipt.count({where:{type:'house_account_payment'}}),0);
 const payId=crypto.randomUUID();r=await http('POST',`/customers/${customer.id}/payments`,{requestId:payId,branchId:branch.id,amount:50,method:'cash'});
 const unconfirmed=(await db.customer.findUnique({where:{id:customer.id}})).houseBalance;
 check('the branch takes the payment; the central balance falls only on confirmation',()=>{assert.equal(r.status,201,JSON.stringify(r));assert.equal(unconfirmed,60)});
 await flush();
 r=await http('POST',`/customers/${customer.id}/payments`,{requestId:payId,branchId:branch.id,amount:50,method:'cash'});await flush();
 const settled=await db.customer.findUnique({where:{id:customer.id}}),payments=await db.houseAccountTransaction.count({where:{customerId:customer.id,type:'payment'}});
 check('after confirmation the balance falls once, even when the request is retried',()=>{assert.equal(r.status,200);assert.equal(settled.houseBalance,10);assert.equal(payments,1)});

 // --- refund of a sale paid in the cloud before the PC took over ---------------
 r=await pcRun('refund',{},cloudSale);
 check('refunding a cloud-era sale on the PC records a confirmed refund request',()=>assert.equal(r.ok,true,JSON.stringify(r)));
 const beforeConfirm=(await db.giftCard.findUnique({where:{id:oldCard.id}})).balance;
 await flush();await flush();
 const [card,cust]=await Promise.all([db.giftCard.findUnique({where:{id:oldCard.id}}),db.customer.findUnique({where:{id:customer.id}})]);
 check('the original gift-card debit and earned points are reversed once, after confirmation',()=>{assert.equal(beforeConfirm,75);assert.equal(card.balance,100);assert.equal(cust.loyaltyPoints,25)});
 r=await pcRun('refund',{},cloudSale);await flush();
 const [card2,cust2]=await Promise.all([db.giftCard.findUnique({where:{id:oldCard.id}}),db.customer.findUnique({where:{id:customer.id}})]);
 check('refunding it again moves nothing',()=>{assert.equal(card2.balance,100);assert.equal(cust2.loyaltyPoints,25)});
 const saved=env.BRANCH_CLOUD_URL;env.BRANCH_CLOUD_URL='http://127.0.0.1:1';
 r=await http('POST','/gift-cards',{requestId:crypto.randomUUID(),branchId:branch.id,method:'cash',amount:20});
 env.BRANCH_CLOUD_URL=saved;
 check('without the cloud no gift card is sold and no money is taken',()=>{assert.equal(r.status,503);assert.equal(r.body.code,'SHARED_WALLET_OFFLINE')});
 console.log(`${checks} shared-value workflow checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await db?.$disconnect();await local?.$disconnect();await require('../dist/config').prisma.$disconnect();await pc?.drop();await cloud?.drop()});
