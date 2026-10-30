// Audit reproductions only: no application fixes, production data or external
// providers. Creates/drops its own scratch DB and synthetic upload files.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const {createScratch}=require('./scratch-db.cjs');
const output=path.resolve(__dirname,'../../outputs/qa-audit-current-2026-10-27');let scratch,db,server,uploadDir;const files=[],evidence=[];
function record(id,actual,confirmed){evidence.push({id,confirmed,actual});console.log((confirmed?'CONFIRMED ':'NOT REPRODUCED ')+id+' '+JSON.stringify(actual));fs.mkdir(output,{recursive:true}).then(()=>fs.writeFile(path.join(output,'targeted-evidence.json'),JSON.stringify(evidence,null,2)));}
(async()=>{
 scratch=await createScratch();Object.assign(process.env,{DATABASE_URL:scratch.url,NODE_ENV:'test'});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{signAccessToken}=require('../dist/utils/jwt'),{signSimulatorEvent}=require('../dist/services/payments/adapters'),{createIntent,intentByToken}=require('../dist/services/payments');
 db=scratch.client();
 const org=await db.organization.create({data:{name:'QA audit synthetic',requireTillForCash:false}}),a=await db.branch.create({data:{organizationId:org.id,code:'QA-A',name:'Allowed'}}),b=await db.branch.create({data:{organizationId:org.id,code:'QA-B',name:'Restricted'}}),foreignOrg=await db.organization.create({data:{name:'Foreign QA'}});
 const owner=await db.user.create({data:{organizationId:org.id,email:'audit-owner@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'Owner'}}),staff=await db.user.create({data:{organizationId:org.id,email:'audit-store@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'Scoped'}});
 const role=await db.role.create({data:{organizationId:org.id,name:'store_keeper',displayName:'Store Keeper'}});await db.userRole.create({data:{userId:staff.id,roleId:role.id}});await db.userBranchAccess.create({data:{userId:staff.id,organizationId:org.id,branchId:a.id}});
 for(const key of ['can_create_purchase_order','can_approve_purchase_order']){const p=await db.permission.create({data:{key,module:'purchase_orders'}});await db.rolePermission.create({data:{roleId:role.id,permissionId:p.id}})}
 const ownerRole=await db.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});await db.userRole.create({data:{userId:owner.id,roleId:ownerRole.id}});
 const token=signAccessToken(staff.id,org.id,staff.email),ownerToken=signAccessToken(owner.id,org.id,owner.email);
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});const base=`http://127.0.0.1:${server.address().port}/api/v1`;
 async function api(method,route,body,auth=token){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(auth&&{Authorization:'Bearer '+auth})},...(body!==undefined&&{body:JSON.stringify(body)})});return {status:r.status,data:await r.json().catch(()=>null)}}
 const po=await db.purchaseOrder.create({data:{organizationId:org.id,branchId:b.id,poNo:'QA-RESTRICTED',orderDate:new Date(),createdBy:owner.id,status:'submitted',items:{create:{description:'Private PO line',quantity:1}}}});
 const me=await api('GET','/auth/me');assert.equal(me.status,200);assert.deepEqual(me.data.permissionMatrix.branchIds,[a.id]);
 const list=await api('GET','/purchase-orders'),get=await api('GET',`/purchase-orders/${po.id}`),approve=await api('POST',`/purchase-orders/${po.id}/approve`,{});
 const created=await api('POST','/purchase-orders',{branchId:b.id,orderDate:'2026-10-27',items:[{description:'Unauthorized branch order',quantity:1}]});
 record('QA-PO-ACL',{branchRestrictionVerified:true,listStatus:list.status,restrictedListed:list.data.data.some(r=>r.id===po.id),getStatus:get.status,approveStatus:approve.status,approvedState:(await db.purchaseOrder.findUnique({where:{id:po.id}})).status,createOtherBranchStatus:created.status},get.status===200&&approve.status===200&&created.status===201);
 const foreignItem=await db.item.create({data:{organizationId:foreignOrg.id,code:'FOREIGN-PRIVATE',name:'Foreign private inventory item'}});
 const crossItem=await api('POST','/purchase-orders',{branchId:a.id,orderDate:'2026-10-27',items:[{itemId:foreignItem.id,description:'Cross-tenant reference probe',quantity:1}]});
 record('QA-PO-TENANT-ITEM',{status:crossItem.status,foreignItemIncluded:crossItem.data.items?.[0]?.item?.name===foreignItem.name},crossItem.status===201&&crossItem.data.items?.[0]?.item?.name===foreignItem.name);
 const draft=await db.purchaseOrder.create({data:{organizationId:org.id,branchId:a.id,poNo:'QA-ROLLBACK',orderDate:new Date(),createdBy:staff.id,items:{create:{description:'Original safe line',quantity:7}}}});
 const edit=await api('PUT',`/purchase-orders/${draft.id}`,{items:[{itemId:'qa-does-not-exist',description:'Invalid replacement',quantity:1}]});
 const lines=await db.purchaseOrderItem.findMany({where:{purchaseOrderId:draft.id}});
 record('QA-PO-ROLLBACK',{status:edit.status,errorCode:edit.data.code,linesAfterFailure:lines.map(l=>({description:l.description,quantity:l.quantity}))},edit.status>=400&&lines.length===0);
 const category=await db.menuCategory.create({data:{organizationId:org.id,name:'Audit meals'}}),dish=await db.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Meal',price:25}});
 await db.commerceSettings.create({data:{organizationId:org.id,paymentAdapter:'simulator',paymentEnvironment:'sandbox',merchantId:'QA-merchant',updatedBy:owner.id}});
 const order=await db.customerOrder.create({data:{organizationId:org.id,branchId:a.id,orderNo:1,orderType:'takeaway',status:'open',acceptedAt:new Date(),subtotal:25,itemsTotal:25,totalAmount:25,items:{create:{dishId:dish.id,dishName:dish.name,quantity:1,unitPrice:25,lineTotal:25,status:'accepted'}}}});
 const payment=await createIntent({organizationId:org.id,branchId:a.id,orderId:order.id,channel:'qr'}),again=await createIntent({organizationId:org.id,branchId:a.id,orderId:order.id,channel:'qr'});
 let firstLinkWorks=true;try{await intentByToken(payment.intent.id,payment.accessToken)}catch{firstLinkWorks=false}const secondLinkWorks=!!await intentByToken(again.intent.id,again.accessToken);
 record('QA-PAY-LINK',{sameIntent:payment.intent.id===again.intent.id,firstLinkWorks,secondLinkWorks},payment.intent.id===again.intent.id&&!firstLinkWorks&&secondLinkWorks);
 async function callback(payload){const raw=JSON.stringify({eventId:crypto.randomUUID(),organizationId:org.id,providerRef:payment.intent.providerRef,amount:25,currency:payment.intent.currency,merchantId:'QA-merchant',...payload});const r=await fetch(base+'/payments/callbacks/simulator',{method:'POST',headers:{'Content-Type':'application/json',...signSimulatorEvent(org.id,raw)},body:raw});return {status:r.status,data:await r.json()}}
 // Missing amount converts to NaN inside the adapter and bypasses the amount
 // comparison. No live merchant/provider is used.
 const missing=await callback({type:'payment.succeeded',amount:undefined});const after=await db.customerOrder.findUnique({where:{id:order.id}});
 record('QA-PAY-AMOUNT',{http:missing.status,outcome:missing.data.outcome,orderState:after.status,settled:(await db.paymentIntent.findUnique({where:{id:payment.intent.id}})).status},missing.status===200&&after.status==='completed');
 const refund=await callback({type:'refund.succeeded',amount:999,currency:'WRONG',merchantId:'not-our-merchant'});const refundRow=await db.paymentIntent.findUnique({where:{id:payment.intent.id}});
 record('QA-REFUND-VALIDATION',{http:refund.status,outcome:refund.data.outcome,originalAmount:refundRow.amount,refundedAmount:refundRow.refundedAmount,refundStatus:refundRow.refundStatus},refund.status===200&&refundRow.refundedAmount===999&&refundRow.refundStatus==='refunded');
 const {UPLOAD_ROOT}=require('../dist/middleware/upload');uploadDir=path.join(UPLOAD_ROOT,org.id);
 const form=new FormData();form.set('branchId',a.id);form.set('file',new Blob(['<!doctype html><html><body>QA non-PDF contents</body></html>'],{type:'application/pdf'}),'qa-masquerade.html');
 const upload=await fetch(base+'/documents/upload',{method:'POST',headers:{Authorization:'Bearer '+token},body:form}),uploaded=await upload.json();
 let served={};if(uploaded.id){const stored=await db.document.findUnique({where:{id:uploaded.id}});files.push(stored.filePath);const result=await fetch(base+`/documents/${uploaded.id}/file`,{headers:{Authorization:'Bearer '+token}});served={status:result.status,type:result.headers.get('content-type'),body:await result.text()}}
 record('QA-UPLOAD-TYPE',{status:upload.status,declared:uploaded.fileType,served},upload.status===201&&String(served.type).includes('text/html'));
 const noRole=await db.user.create({data:{organizationId:org.id,email:'no-role@example.invalid',passwordHash:'TEST-HASH',firstName:'No',lastName:'Role'}}),emptyToken=signAccessToken(noRole.id,org.id,noRole.email);
 const emptyPerms=await api('GET','/auth/me',undefined,emptyToken),unprivileged=await api('DELETE',`/documents/${uploaded.id}`,undefined,emptyToken);
 record('QA-DOC-PERMISSION',{permissions:emptyPerms.data.permissionMatrix.permissions,deleteStatus:unprivileged.status,rowRemaining:await db.document.count({where:{id:uploaded.id}})},emptyPerms.data.permissionMatrix.permissions.length===0&&unprivileged.status===200);
 const denied=await api('GET',`/orgs/${foreignOrg.id}`);record('CONTROL-TENANT',{status:denied.status},false);
 // Invalid second stage leaves replacement PO lines even if header FK fails.
 const partial=await db.purchaseOrder.create({data:{organizationId:org.id,branchId:a.id,poNo:'QA-PARTIAL',orderDate:new Date(),createdBy:staff.id,items:{create:{description:'Before failed edit',quantity:2}}}});
 const header=await api('PUT',`/purchase-orders/${partial.id}`,{branchId:'qa-invalid-branch',items:[{description:'Persisted despite header failure',quantity:9}]});const saved=await db.purchaseOrder.findUnique({where:{id:partial.id},include:{items:true}});
 record('QA-PO-PARTIAL',{status:header.status,headerBranchUnchanged:saved.branchId===a.id,lineDescriptions:saved.items.map(i=>i.description)},header.status>=400&&saved.items[0]?.description==='Persisted despite header failure');
 console.log('Audit reproductions complete: '+evidence.filter(e=>e.confirmed).length+' confirmed observations.');
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{
 if(server)await new Promise(r=>server.close(r));for(const file of files)await fs.unlink(file).catch(()=>{});if(uploadDir)await fs.rmdir(uploadDir).catch(()=>{});
 await db?.$disconnect();await require('../dist/config').prisma.$disconnect();await scratch?.drop();await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'targeted-evidence.json'),JSON.stringify({scratchRemoved:true,evidence},null,2));
});
