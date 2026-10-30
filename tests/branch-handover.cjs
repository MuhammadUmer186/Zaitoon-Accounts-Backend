// Ownership handover and disaster release with a real branch PC process.
// Cloud in this process; PCs as `node dist/index.js` on their own fs_qa_* databases.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net'),{spawn,execFileSync}=require('node:child_process');
const {createScratch}=require('./scratch-db.cjs');
const backend=path.resolve(__dirname,'..'),logDir=path.resolve(backend,'../outputs/qa-hardening-2026-10-26');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(label,fn,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(250)}throw new Error('Timed out waiting for '+label)}
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>r(port))})});
const scratch=[],children=[];let server,cloudDb;
(async()=>{
 const cloud=await createScratch(),pcA=await createScratch(),pcB=await createScratch();scratch.push(cloud,pcA,pcB);
 execFileSync(process.execPath,[path.join(backend,'prisma/sync-permissions.js')],{env:{...process.env,DATABASE_URL:cloud.url},stdio:'pipe',cwd:backend});
 process.env.DATABASE_URL=cloud.url;process.env.NODE_ENV='test';delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{signAccessToken}=require('../dist/utils/jwt'),{importBranch}=require('../dist/services/branchImport');
 cloudDb=cloud.client();
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/api/v1';
 let ip=0;async function api(method,route,body,token){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Forwarded-For':`203.0.113.${(ip++%250)+1}`,...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json().catch(()=>null)}}
 const org=await cloudDb.organization.create({data:{name:'Handover org'}}),branch=await cloudDb.branch.create({data:{organizationId:org.id,name:'Handover branch',code:'H'}});
 const owner=await cloudDb.user.create({data:{organizationId:org.id,email:'handover-owner@example.invalid',passwordHash:'TEST-HASH-ONLY',firstName:'H',lastName:'O'}}),role=await cloudDb.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});
 await cloudDb.userRole.create({data:{userId:owner.id,roleId:role.id}});
 const category=await cloudDb.menuCategory.create({data:{organizationId:org.id,name:'Meals'}}),shift=await cloudDb.menuShift.create({data:{organizationId:org.id,name:'All day',startTime:'00:00',endTime:'00:00'}});
 const dish=await cloudDb.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Meal',price:12}});await cloudDb.dishShift.create({data:{dishId:dish.id,shiftId:shift.id}});
 const token=signAccessToken(owner.id,org.id,owner.email);
 async function enrollAndProvision(scratchDb,name){
  const r=await api('POST','/branch-sync/nodes',{branchId:branch.id,name},token);assert.equal(r.status,201,JSON.stringify(r.data));
  const seed=await api('GET',`/branch-operations/provision/${branch.id}?nodeId=${r.data.id}`,undefined,token);assert.equal(seed.status,200);
  const db=scratchDb.client();await importBranch(db,seed.data);
  await db.branchRuntime.create({data:{id:'local',nodeId:r.data.id,organizationId:org.id,branchId:branch.id,numberSeries:r.data.numberSeries,configurationSyncedAt:new Date()}});
  return {node:r.data,db};
 }
 async function startPc(url,pcToken){
  const port=await freePort(),log=fs.openSync(path.join(logDir,'branch-handover-pc.log'),'a');
  const child=spawn(process.execPath,[path.join(backend,'dist/index.js')],{cwd:backend,stdio:['ignore',log,log],env:{...process.env,DATABASE_URL:url,JWT_SECRET:crypto.randomBytes(32).toString('hex'),JWT_REFRESH_SECRET:crypto.randomBytes(32).toString('hex'),PORT:String(port),BIND_HOST:'127.0.0.1',NODE_ENV:'test',FOODSYNC_DEPLOYMENT_MODE:'branch',BRANCH_CLOUD_URL:origin,BRANCH_SYNC_TOKEN:pcToken,BRANCH_COMMAND_INTERVAL_MS:'300',BRANCH_REPLICA_INTERVAL_MS:'1000',BRANCH_HEALTH_INTERVAL_MS:'60000',SUPER_ADMIN_EMAIL:'',SUPER_ADMIN_PASSWORD:''}});
  children.push(child);await until('PC start',async()=>{try{return (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status<500}catch{return false}},30000);return child;
 }
 const sale=(saleNo,extra={})=>({organizationId:org.id,branchId:branch.id,saleNo,saleDate:new Date(),createdBy:owner.id,subtotal:5,totalAmount:5,netAmount:5,...extra});

 // --- planned handover ----------------------------------------------------
 const a=await enrollAndProvision(pcA,'PC A');
 check('the first PC receives series P1',()=>assert.equal(a.node.numberSeries,'P1'));
 await startPc(pcA.url,a.node.token);
 const open=await a.db.customerOrder.create({data:{organizationId:org.id,branchId:branch.id,orderNo:1001,orderType:'takeaway',status:'open'}});
 await until('open order in the cloud',()=>cloudDb.customerOrder.count({where:{id:open.id}}));
 let r=await api('POST',`/branch-sync/nodes/${a.node.id}/handover`,undefined,token);
 check('an administrator requests a handover',()=>assert.equal(r.status,202));
 r=await api('POST',`/public/online/branches/${branch.id}/orders`,{requestId:crypto.randomUUID(),orderType:'takeaway',customerName:'Late Customer',customerPhone:'+923001234567',items:[{dishId:dish.id,quantity:1}]});
 check('new online orders are refused while the branch is being handed over',()=>{assert.equal(r.status,503);assert.equal(r.data.code,'BRANCH_HANDOVER')});
 const waiting=await until('handover blocked',async()=>{const rt=await a.db.branchRuntime.findUnique({where:{id:'local'}});return rt.handoverState&&rt});
 const stillOwner=(await cloudDb.branchSyncNode.findUnique({where:{id:a.node.id}})).ownsWrites;
 check('an open order blocks the handover; the PC keeps trading and says why',()=>{assert.match(waiting.handoverState,/1 open order/);assert.equal(waiting.writesFrozen,null);assert.equal(stillOwner,true)});
 const lastSale=await a.db.dailySale.create({data:sale('LAST-ON-PC')});
 await a.db.customerOrder.update({where:{id:open.id},data:{status:'completed',closedAt:new Date()}});
 const released=await until('handover completion',async()=>{const n=await cloudDb.branchSyncNode.findUnique({where:{id:a.node.id}});return !n.ownsWrites&&n});
 const pcState=await until('PC frozen',async()=>{const rt=await a.db.branchRuntime.findUnique({where:{id:'local'}});return rt.writesFrozen==='released'&&rt});
 check('after the order closes the PC freezes, sends its final checkpoint and the cloud releases ownership',()=>{assert.equal(released.isActive,false);assert.ok(released.releasedAt);assert.equal(pcState.dataRevision,pcState.lastReplicaRevision)});
 const [cloudSale,cloudOrder]=await Promise.all([cloudDb.dailySale.findUnique({where:{id:lastSale.id}}),cloudDb.customerOrder.findUnique({where:{id:open.id}})]);
 check('the last sale and the closed order made on the PC are in the cloud',()=>{assert.ok(cloudSale);assert.equal(cloudOrder.status,'completed')});
 await assert.rejects(()=>a.db.dailySale.create({data:sale('AFTER-HANDOVER')}),e=>e.message.includes('FOODSYNC_BRANCH_FROZEN'));
 check('the handed-over PC refuses every new business write in its database',()=>{});
 const cloudWrite=await cloudDb.dailySale.create({data:sale('CLOUD-AFTER-HANDOVER')});
 check('the cloud can write to the branch again',()=>assert.ok(cloudWrite.id));
 for(const c of children.splice(0))await new Promise(res=>{c.once('exit',res);c.kill()});

 // --- replacement PC, then disaster release ---------------------------------
 const b=await enrollAndProvision(pcB,'PC B');
 check('a replacement PC can enroll and receives a new series',()=>assert.equal(b.node.numberSeries,'P2'));
 r=await api('POST',`/branch-sync/nodes/${b.node.id}/release`,{acknowledgeUnsyncedDataLoss:true,reason:'PC stolen from branch'},token);
 check('an active PC cannot be force-released',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'RELEASE_REQUIRES_REVOCATION')});
 await api('DELETE',`/branch-sync/nodes/${b.node.id}`,undefined,token);
 r=await api('POST',`/branch-sync/nodes/${b.node.id}/release`,{reason:'PC stolen from branch'},token);
 check('a disaster release requires an explicit data-loss acknowledgment',()=>assert.equal(r.status,400));
 r=await api('POST',`/branch-sync/nodes/${b.node.id}/release`,{acknowledgeUnsyncedDataLoss:true,reason:'PC stolen from branch'},token);
 const record=await cloudDb.branchSyncNode.findUnique({where:{id:b.node.id}});
 check('the release is recorded with who and why',()=>{assert.equal(r.status,200);assert.equal(record.ownsWrites,false);assert.equal(record.releasedBy,owner.id);assert.equal(record.releaseReason,'PC stolen from branch')});
 r=await api('GET','/branch-sync/nodes',undefined,token);
 const listed=r.data.data.find(n=>n.id===b.node.id),first=r.data.data.find(n=>n.id===a.node.id);
 check('the admin panel lists each PC with series, release record and alerts',()=>{assert.equal(listed.numberSeries,'P2');assert.equal(listed.releaseReason,'PC stolen from branch');assert.ok(Array.isArray(listed.alerts));assert.ok(first.releasedAt);assert.equal(JSON.stringify(r.data).includes(b.node.token),false)});
 r=await api('POST','/branch-sync/commands/claim',{},b.node.token);
 check('a released PC is told so explicitly (410), not merely unauthorized',()=>{assert.equal(r.status,410);assert.equal(r.data.code,'BRANCH_RELEASED')});
 await startPc(pcB.url,b.node.token);
 await until('zombie PC freezes',async()=>(await b.db.branchRuntime.findUnique({where:{id:'local'}})).writesFrozen==='released');
 await assert.rejects(()=>b.db.dailySale.create({data:sale('ZOMBIE')}),e=>e.message.includes('FOODSYNC_BRANCH_FROZEN'));
 check('a released PC that comes back online freezes itself instead of becoming a second writer',()=>{});
 console.log(`${checks} branch handover checks passed.`);
 await a.db.$disconnect();await b.db.$disconnect();
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{
 for(const c of children)c.kill();if(server)await new Promise(r=>server.close(r));await cloudDb?.$disconnect();await require('../dist/config').prisma.$disconnect().catch(()=>{});
 await sleep(500);for(const s of scratch)await s.drop().catch(e=>console.error('cleanup',e.message));
});
