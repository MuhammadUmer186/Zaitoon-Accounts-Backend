// Cloud <-> branch PC online-order queue and ERP checkpoint chain.
// Cloud runs in this process; the branch PC is a separate `node dist/index.js`
// with its OWN database and a DIFFERENT JWT secret. Only fs_qa_* databases.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net'),{spawn,execFileSync}=require('node:child_process');
const {createScratch}=require('./scratch-db.cjs');
const backend=path.resolve(__dirname,'..'),logDir=path.resolve(backend,'../outputs/qa-hardening-2026-10-26');fs.mkdirSync(logDir,{recursive:true});
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(label,fn,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await sleep(250)}throw new Error('Timed out waiting for '+label)}
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>resolve(port))})});
const controlPlane=['BranchRuntime','BranchOutbox','BranchSyncNode','BranchSyncEvent','BranchSyncProjection','BranchReplicaSession','BranchReplicaPart','BranchRemoteCommand'];
const scratch=[];let server,child,childLog,cloudDb,branchClient;

(async()=>{
 const cloud=await createScratch(),branchDb=await createScratch();scratch.push(cloud,branchDb);
 execFileSync(process.execPath,[path.join(backend,'prisma/sync-permissions.js')],{env:{...process.env,DATABASE_URL:cloud.url},stdio:'pipe',cwd:backend});
 process.env.DATABASE_URL=cloud.url;process.env.NODE_ENV='test';delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,appDb=require('../dist/config').prisma,{config}=require('../dist/config');
 const {signAccessToken}=require('../dist/utils/jwt'),{importBranch}=require('../dist/services/branchImport'),{purgeBranchControlPlane}=require('../dist/services/branchReplicaTransport');
 cloudDb=cloud.client();
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/api/v1';
 let ip=0;// The public limiter keys on client IP; tests present distinct customers.
 async function api(method,route,body,token,headers={}){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Forwarded-For':`198.51.100.${(ip++%250)+1}`,...(token?{Authorization:'Bearer '+token}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json().catch(()=>null)}}

 const org=await cloudDb.organization.create({data:{name:'Online relay test'}});
 const branch=await cloudDb.branch.create({data:{organizationId:org.id,name:'Relay branch',code:'R'}});
 const owner=await cloudDb.user.create({data:{organizationId:org.id,email:'relay-owner@example.invalid',passwordHash:'TEST-HASH-ONLY',firstName:'Relay',lastName:'Owner'}}),role=await cloudDb.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});
 await cloudDb.userRole.create({data:{userId:owner.id,roleId:role.id}});
 const category=await cloudDb.menuCategory.create({data:{organizationId:org.id,name:'Meals'}}),shift=await cloudDb.menuShift.create({data:{organizationId:org.id,name:'All day',startTime:'00:00',endTime:'00:00'}});
 const dish=await cloudDb.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Relay meal',price:25}});
 await cloudDb.dishShift.create({data:{dishId:dish.id,shiftId:shift.id}});
 const token=signAccessToken(owner.id,org.id,owner.email);
 const order=(requestId,extra={})=>({requestId,orderType:'takeaway',customerName:'Online Customer',customerPhone:'+923001112233',items:[{dishId:dish.id,quantity:2}],...extra});
 const placePath=`/public/online/branches/${branch.id}/orders`;

 // --- control plane and ownership boundary ------------------------------
 let r=await api('POST','/branch-sync/nodes',{branchId:branch.id,name:'Relay PC'},token);assert.equal(r.status,201);const node=r.data,pcToken=node.token;
 check('enrollment assigns the PC its own document-number series',()=>assert.equal(node.numberSeries,'P1'));
 const guarded=await cloudDb.$queryRawUnsafe(`SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname IN ('foodsync_branch_ownership','foodsync_replica_revision') AND c.relname = ANY($1::text[])`,controlPlane);
 check('control-plane tables carry no business ownership or revision triggers',()=>assert.deepEqual(guarded,[]));
 r=await api('POST',placePath,order(crypto.randomUUID()));
 check('a branch PC that has never connected is reported offline instead of queuing',()=>{assert.equal(r.status,503);assert.equal(r.data.code,'BRANCH_OFFLINE')});
 r=await api('POST','/branch-sync/commands/claim',{},pcToken);
 check('a command claim is the PC heartbeat',()=>assert.equal(r.status,200));
 const firstId=crypto.randomUUID();r=await api('POST',placePath,order(firstId));
 check('cloud queues an online order for a branch it does not own (202, no order, not accepted)',()=>{assert.equal(r.status,202);assert.equal(r.data.state,'queued');assert.equal(r.data.order,undefined);assert.match(r.data.message,/not yet accepted or paid/)});
 const firstCode=r.data.trackingCode;
 const cloudCompeting=await cloudDb.customerOrder.count({where:{branchId:branch.id}});check('the cloud did not create a competing order in the branch-owned ERP',()=>assert.equal(cloudCompeting,0));
 const dupes=await Promise.all(Array.from({length:8},()=>api('POST',placePath,order(firstId))));
 check('concurrent duplicate submits return one tracking code and one queued command',()=>{assert.ok(dupes.every(d=>d.status===202&&d.data.trackingCode===firstCode))});assert.equal(await cloudDb.branchRemoteCommand.count({where:{kind:'online-place'}}),1);
 r=await api('POST',placePath,order(firstId,{customerName:'Somebody Else'}));
 check('reusing a request ID with different details is refused',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'ONLINE_REQUEST_CONFLICT')});
 r=await api('GET',`/public/online/orders/${encodeURIComponent(firstCode)}`);
 check('tracking before branch receipt says queued and shows no order',()=>{assert.equal(r.status,200);assert.equal(r.data.state,'queued');assert.equal(r.data.pendingBranchReceipt,true);assert.equal(r.data.order,undefined)});
 r=await api('POST',`/public/online/orders/${encodeURIComponent(firstCode)}/pay`,{});
 check('payment cannot start before the PC has acknowledged the queued order',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'BRANCH_PAYMENT_NOT_READY')});
 r=await api('GET',`/branch-operations/provision/${branch.id}?nodeId=${node.id}`,undefined,token);
 const seed=r.data;
 check('branch seed contains no control-plane rows',()=>{assert.equal(r.status,200);for(const name of controlPlane)assert.equal(seed.tables[name],undefined,name)});
 branchClient=branchDb.client();
 const tampered=structuredClone(seed);tampered.tables.BranchRemoteCommand=[];
 await assert.rejects(()=>importBranch(branchClient,tampered),e=>e.code==='INVALID_BRANCH_PACKAGE');check('import refuses a package that carries control-plane tables',()=>{});
 await importBranch(branchClient,seed);
 await branchClient.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:org.id,branchId:branch.id,configurationSyncedAt:new Date()}});

 // --- branch PC as a separate process with a different secret ----------
 const branchSecret=crypto.randomBytes(32).toString('hex');
 check('cloud and branch use different JWT secrets',()=>assert.notEqual(branchSecret,config.jwtSecret));
 async function startBranch(url){
  const port=await freePort();childLog=fs.openSync(path.join(logDir,'branch-online-pc.log'),'a');
  child=spawn(process.execPath,[path.join(backend,'dist/index.js')],{cwd:backend,stdio:['ignore',childLog,childLog],env:{...process.env,DATABASE_URL:url,JWT_SECRET:branchSecret,JWT_REFRESH_SECRET:crypto.randomBytes(32).toString('hex'),PORT:String(port),BIND_HOST:'127.0.0.1',NODE_ENV:'test',FOODSYNC_DEPLOYMENT_MODE:'branch',BRANCH_CLOUD_URL:origin,BRANCH_SYNC_TOKEN:pcToken,BRANCH_COMMAND_INTERVAL_MS:'300',BRANCH_REPLICA_INTERVAL_MS:'1000',SUPER_ADMIN_EMAIL:'',SUPER_ADMIN_PASSWORD:''}});
  await until('branch PC start',async()=>{try{return (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status<500}catch{return false}},30000);
 }
 async function stopBranch(){if(!child)return;const c=child;child=null;await new Promise(r=>{c.once('exit',r);c.kill()});fs.closeSync(childLog)}
 await startBranch(branchDb.url);
 const placed=await until('relayed placement',async()=>{const t=await api('GET',`/public/online/orders/${encodeURIComponent(firstCode)}`);return t.data?.state==='placed'&&t.data});
 const localOrder=await branchClient.customerOrder.findFirst({where:{source:'online'}});
 check('the branch PC receives, commits and acknowledges the queued order',()=>{assert.ok(localOrder);assert.equal(placed.order.id,localOrder.id);assert.equal(placed.order.status,'pending');assert.equal(localOrder.totalAmount>0,true)});
 const cloudPublicId=(await cloudDb.branchRemoteCommand.findFirst({where:{kind:'online-place'}})).publicId;
 check('branch order IDs differ from cloud request IDs under different secrets; tracking still resolves',()=>assert.notEqual(cloudPublicId,localOrder.id));
 check('relayed tracking never offers payment from the cloud queue',()=>assert.equal(placed.order.paymentsAvailable,false));
 r=await api('POST',placePath,order(firstId));
 check('a retry after receipt returns the committed order (200) instead of a new one',()=>{assert.equal(r.status,200);assert.equal(r.data.state,'placed');assert.equal(r.data.order.id,localOrder.id)});
 assert.equal(await branchClient.customerOrder.count({where:{source:'online'}}),1);

 await branchClient.customerOrder.update({where:{id:localOrder.id},data:{status:'open',acceptedAt:new Date()}});// staff acceptance at the PC
 const accepted=await until('status refresh',async()=>{const t=await api('GET',`/public/online/orders/${encodeURIComponent(firstCode)}`);return t.data?.order?.status==='open'&&t.data});
 check('staff acceptance at the branch reaches cloud tracking',()=>assert.equal(accepted.order.status,'open'));
 for(let i=0;i<20;i++)await api('GET',`/public/online/orders/${encodeURIComponent(firstCode)}`);
 const statusRows=await cloudDb.branchRemoteCommand.count({where:{kind:'online-status'}});check('public polling keeps one status-refresh row per order',()=>assert.equal(statusRows,1));

 const badId=crypto.randomUUID();r=await api('POST',placePath,order(badId,{items:[{dishId:'missing-dish',quantity:1}]}));assert.equal(r.status,202);
 const rejected=await until('rejection',async()=>{const t=await api('GET',`/public/online/orders/${encodeURIComponent(r.data.trackingCode)}`);return t.data?.state==='rejected'&&t.data});
 check('a definite branch refusal is reported as rejected, never placed',()=>{assert.equal(rejected.failed,true);assert.equal(rejected.order,undefined);assert.match(rejected.message,/no longer available/)});

 // --- crash after local commit, before acknowledgment -------------------
 await stopBranch();
 const crashId=crypto.randomUUID();r=await api('POST',placePath,order(crashId));assert.equal(r.status,202);const crashCode=r.data.trackingCode;
 r=await api('POST','/branch-sync/commands/claim',{},pcToken);const crashCommand=r.data.commands.find(c=>c.kind==='online-place');assert.ok(crashCommand);
 // The PC commits locally, then dies before telling the cloud.
 execFileSync(process.execPath,['-e',`require('dotenv').config();const {executeBranchCommand}=require('./dist/services/branchOnline');executeBranchCommand(JSON.parse(process.env.CMD),process.env.BRANCH_ID).then(o=>{if(!o||o.status>=400)process.exit(2);process.exit(0)})`],{cwd:backend,env:{...process.env,DATABASE_URL:branchDb.url,JWT_SECRET:branchSecret,FOODSYNC_DEPLOYMENT_MODE:'branch',CMD:JSON.stringify(crashCommand),BRANCH_ID:branch.id},stdio:'pipe'});
 r=await api('GET',`/public/online/orders/${encodeURIComponent(crashCode)}`);
 check('while the result is unreported the customer sees received, not accepted or failed',()=>{assert.equal(r.data.state,'received');assert.equal(r.data.failed,false);assert.equal(r.data.order,undefined)});
 r=await api('POST','/branch-sync/commands/claim',{},pcToken);
 check('an active lease is not handed out twice',()=>assert.equal(r.data.commands.filter(c=>c.id===crashCommand.id).length,0));
 await cloudDb.branchRemoteCommand.update({where:{id:crashCommand.id},data:{leaseUntil:new Date(Date.now()-1000)}});
 await startBranch(branchDb.url);
 const recovered=await until('replay after crash',async()=>{const t=await api('GET',`/public/online/orders/${encodeURIComponent(crashCode)}`);return t.data?.state==='placed'&&t.data});
 const crashOrders=await branchClient.customerOrder.findMany({where:{id:recovered.order.id}});
 check('replay after a crash finds the committed order: exactly one order, then acknowledged',()=>{assert.equal(crashOrders.length,1);assert.equal(recovered.order.id,crashOrders[0].id)});
 r=await api('POST',`/branch-sync/commands/${crashCommand.id}/complete`,{claimToken:crashCommand.claimToken,status:201,result:{order:{id:'forged'}}},pcToken);
 check('an expired claim token cannot overwrite the acknowledged result',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'COMMAND_CLAIM_INVALID')});

 // --- expiry, unknown outcome, offline, revocation ----------------------
 await stopBranch();
 const expireId=crypto.randomUUID();r=await api('POST',placePath,order(expireId));assert.equal(r.status,202);const expireCode=r.data.trackingCode;
 await cloudDb.branchRemoteCommand.updateMany({where:{key:`online:${expireId}`},data:{expiresAt:new Date(Date.now()-1000)}});
 r=await api('POST','/branch-sync/commands/claim',{},pcToken);
 check('an unclaimed request past its deadline is not delivered late',()=>assert.equal(r.data.commands.filter(c=>c.kind==='online-place').length,0));
 r=await api('GET',`/public/online/orders/${encodeURIComponent(expireCode)}`);
 check('expired requests tell the customer nothing was created or charged',()=>{assert.equal(r.data.state,'expired');assert.equal(r.data.failed,true);assert.match(r.data.message,/No order was created/)});
 const unknownId=crypto.randomUUID();r=await api('POST',placePath,order(unknownId));const unknownCode=r.data.trackingCode;
 r=await api('POST','/branch-sync/commands/claim',{},pcToken);const unknownCmd=r.data.commands.find(c=>c.kind==='online-place');
 await cloudDb.branchRemoteCommand.update({where:{id:unknownCmd.id},data:{leaseUntil:new Date(Date.now()-1000),createdAt:new Date(Date.now()-25*3600000)}});
 await api('POST','/branch-sync/commands/claim',{},pcToken);
 r=await api('GET',`/public/online/orders/${encodeURIComponent(unknownCode)}`);
 check('a claimed request with no answer becomes unknown, never failed',()=>{assert.equal(r.data.state,'unknown');assert.equal(r.data.failed,false);assert.match(r.data.message,/call the restaurant/)});
 r=await api('POST',`/branch-sync/commands/${unknownCmd.id}/complete`,{claimToken:unknownCmd.claimToken,status:409,result:{message:'Kitchen closed',code:'NO_ACTIVE_SHIFT'}},pcToken);
 const lateAck=r;r=await api('GET',`/public/online/orders/${encodeURIComponent(unknownCode)}`);
 check('a late but authentic branch answer still resolves an unknown request',()=>{assert.equal(lateAck.status,200);assert.equal(r.data.state,'rejected')});
 r=await api('POST',`/branch-sync/commands/${unknownCmd.id}/complete`,{claimToken:unknownCmd.claimToken,status:201,result:{order:{id:'changed'}}},pcToken);
 check('an acknowledged answer cannot be changed by replay',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'COMMAND_REPLAY_CONFLICT')});
 await cloudDb.branchSyncNode.update({where:{id:node.id},data:{lastSeenAt:new Date(Date.now()-120000)}});
 r=await api('POST',placePath,order(crypto.randomUUID()));
 check('a silent PC makes new online orders fail fast as offline',()=>{assert.equal(r.status,503);assert.equal(r.data.code,'BRANCH_OFFLINE')});
 r=await api('GET',`/public/online/orders/${encodeURIComponent(firstCode)}`);
 check('tracking while the PC is offline keeps the last confirmed order and says it is offline',()=>{assert.equal(r.data.state,'placed');assert.equal(r.data.branchOffline,true);assert.equal(r.data.order.status,'open')});

 // --- ERP checkpoint chain: restore from an older backup ----------------
 await startBranch(branchDb.url);
 const head1=await until('first ERP checkpoint',async()=>{const n=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});return n.replicaRevision>=0&&n.replicaDigest&&n});
 check('the branch publishes a full ERP checkpoint across different secrets',()=>assert.ok(head1.replicaDigest));
 const cloudOrders=await until('replicated orders',async()=>{const n=await cloudDb.customerOrder.count({where:{branchId:branch.id,id:localOrder.id}});return n>=1&&n});
 check('relayed orders reach the central ERP through the checkpoint, not through the queue',()=>assert.equal(cloudOrders,1));
 // Backup = copy of the branch database while the PC is stopped.
 await stopBranch();await branchClient.$disconnect();
 const admin=require('../node_modules/@prisma/client');const adminUrl=new URL(process.env.DATABASE_URL);adminUrl.pathname='/postgres';const adminDb=new admin.PrismaClient({datasources:{db:{url:adminUrl.toString()}}});
 const backupName=`fs_qa_${process.pid}_${Date.now()}9`;await adminDb.$executeRawUnsafe(`CREATE DATABASE "${backupName}" TEMPLATE "${branchDb.name}"`);
 const backupUrl=new URL(branchDb.url);backupUrl.pathname='/'+backupName;
 scratch.push({drop:async()=>{await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${backupName}" WITH (FORCE)`);await adminDb.$disconnect()}});
 branchClient=branchDb.client();
 await cloudDb.branchSyncNode.update({where:{id:node.id},data:{lastSeenAt:new Date()}});
 await startBranch(branchDb.url);
 const saleBase={organizationId:org.id,branchId:branch.id,saleDate:new Date(),createdBy:owner.id,subtotal:40,totalAmount:40};
 await branchClient.dailySale.create({data:{...saleBase,saleNo:'AFTER-BACKUP',netAmount:40}});
 const head2=await until('checkpoint after backup',async()=>{const n=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});return n.replicaRevision>head1.replicaRevision&&await cloudDb.dailySale.count({where:{saleNo:'AFTER-BACKUP'}})&&n});
 check('newer cloud history includes a sale made after the backup',()=>assert.ok(head2));
 await stopBranch();
 const headBefore=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});
 const restored=new (require('../node_modules/@prisma/client').PrismaClient)({datasources:{db:{url:backupUrl.toString()}}});
 for(let i=0;i<5;i++)await restored.dailySale.create({data:{...saleBase,saleNo:`RESTORED-${i}`,netAmount:1}});// counter now passes the cloud head
 const restoredRuntime=await restored.branchRuntime.findUnique({where:{id:'local'}});
 check('the restored PC revision counter has caught up with the cloud head',()=>assert.ok(restoredRuntime.dataRevision>headBefore.replicaRevision));
 await startBranch(backupUrl.toString());
 const broken=await until('chain refusal',async()=>{const rt=await restored.branchRuntime.findUnique({where:{id:'local'}});return rt.replicaChainError&&rt});
 await sleep(2500);
 const headAfter=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});
 check('a PC restored from an older backup stops instead of overwriting newer cloud history',()=>{assert.ok(broken.replicaChainError);assert.equal(headAfter.replicaRevision,headBefore.replicaRevision);assert.equal(headAfter.replicaDigest,headBefore.replicaDigest)});
 const kept=await cloudDb.dailySale.count({where:{saleNo:'AFTER-BACKUP'}}),leaked=await cloudDb.dailySale.count({where:{saleNo:{startsWith:'RESTORED-'}}});
 check('the post-backup sale stays in the central ERP and restored-PC sales do not replace it',()=>{assert.equal(kept,1);assert.equal(leaked,0)});
 await stopBranch();await restored.$disconnect();
 const {replicaEntities,replicaDigest}=require('../dist/services/branchReplica');
 const forged={kind:'full',schema:seed.schema,revision:String(Number(headBefore.replicaRevision)+50),baseRevision:String(head1.replicaRevision),baseDigest:head1.replicaDigest,parts:[...replicaEntities,'Customer'].map(entity=>({entity,part:0,rows:0,digest:replicaDigest([])}))};
 r=await api('POST','/branch-sync/replica/begin',forged,pcToken);
 check('a checkpoint built on a superseded base is refused by the cloud',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'REPLICA_CHAIN_BROKEN')});
 // Lost acknowledgment: the cloud committed head2 but the PC never recorded it.
 const original=await branchClient.branchRuntime.findUnique({where:{id:'local'}});
 await branchClient.branchRuntime.update({where:{id:'local'},data:{lastReplicaRevision:head1.replicaRevision,lastReplicaDigest:head1.replicaDigest,pendingReplicaRevision:headBefore.replicaRevision,pendingReplicaDigest:headBefore.replicaDigest}});
 assert.equal(original.lastReplicaRevision,headBefore.replicaRevision);
 await branchClient.dailySale.create({data:{...saleBase,saleNo:'AFTER-LOST-ACK',netAmount:3}});
 await startBranch(branchDb.url);
 await until('progress after lost acknowledgment',async()=>await cloudDb.dailySale.count({where:{saleNo:'AFTER-LOST-ACK'}}));
 const healed=await branchClient.branchRuntime.findUnique({where:{id:'local'}});
 check('a lost acknowledgment is recovered from the recorded pending checkpoint',()=>{assert.equal(healed.replicaChainError,null);assert.equal(healed.pendingReplicaRevision,null)});
 await stopBranch();

 // --- revocation and housekeeping ---------------------------------------
 // An in-flight checkpoint commit holds the branch-owner lock; revocation must wait for it.
 let releaseCommit,commitHolding;const holding=new Promise(r=>{commitHolding=r}),hold=new Promise(r=>{releaseCommit=r});
 const inflight=cloudDb.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`branch-owner:${branch.id}`}))`;commitHolding();await hold},{timeout:60000});
 await holding;let revokedAt=0;const revoking=api('DELETE',`/branch-sync/nodes/${node.id}`,undefined,token).then(x=>{revokedAt=Date.now();return x});
 await sleep(1500);const stillActive=(await cloudDb.branchSyncNode.findUnique({where:{id:node.id}})).isActive;const releasedAt=Date.now();releaseCommit();await inflight;r=await revoking;
 check('revocation waits for an in-flight checkpoint commit instead of racing it',()=>{assert.equal(stillActive,true);assert.equal(r.status,200);assert.ok(revokedAt>=releasedAt)});
 r=await api('POST','/branch-sync/commands/claim',{},pcToken);
 check('revoked PC credentials cannot claim commands',()=>assert.equal(r.status,401));
 r=await api('POST',placePath,order(crypto.randomUUID()));
 check('a revoked but still-owning PC never falls back to cloud order placement',()=>{assert.equal(r.status,503);assert.equal(r.data.code,'BRANCH_OFFLINE')});
 r=await api('GET','/branch-operations/status',undefined,token);
 check('cloud status marks central reports incomplete for a revoked branch PC',()=>{assert.equal(r.data.cloudReportsIncomplete,true);assert.equal(r.data.branches[0].current,false)});
 await cloudDb.branchReplicaSession.create({data:{nodeId:node.id,revision:999999n,schema:seed.schema,manifest:[],digest:'0'.repeat(64),expiresAt:new Date(Date.now()-1000)}});
 const purged=await purgeBranchControlPlane(new Date(Date.now()+2*86400000));
 const headRow=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}}),headReceipts=await cloudDb.branchReplicaSession.count({where:{nodeId:node.id,revision:headRow.replicaRevision}});
 r=await api('GET',`/public/online/orders/${encodeURIComponent(firstCode)}`);
 check('housekeeping removes stale uploads and old status rows but keeps chain heads and placement receipts',()=>{assert.ok(purged.staleSessions>=1);assert.ok(purged.statusCommands>=1);assert.equal(headReceipts,1);assert.equal(r.data.state,'placed')});
 console.log(`${checks} branch online/chain checks passed.`);
 await appDb.$disconnect();
})().catch(error=>{console.error(error.stack||error.message);process.exitCode=1}).finally(async()=>{
 if(child)child.kill();if(server)await new Promise(r=>server.close(r));
 await cloudDb?.$disconnect();await branchClient?.$disconnect();
 for(const s of scratch.reverse())await s.drop().catch(e=>console.error('cleanup',e.message));
});
