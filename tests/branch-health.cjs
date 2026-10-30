// Branch alerts: evaluation rules, cloud reporting and webhook delivery (fs_qa_* only).
const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
const {createScratch}=require('./scratch-db.cjs');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
let cloud,server,hook;
(async()=>{
 cloud=await createScratch();process.env.DATABASE_URL=cloud.url;process.env.NODE_ENV='test';delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const {evaluateBranchAlerts,cloudBranchAlerts,notifyBranchAlerts}=require('../dist/services/branchHealth');
 const now=Date.parse('2026-10-27T12:00:00Z'),ago=m=>new Date(now-m*60000);
 const runtime={lastSyncedAt:ago(1),lastReplicaAt:ago(1),dataRevision:10n,lastReplicaRevision:10n,replicaChainError:null,replicaError:null,configurationSyncedAt:ago(5),configurationError:null};
 const backup={lastSuccessAt:ago(10).toISOString(),healthy:true,offsiteHealthy:true,archive:{healthy:true},capacity:{backupLow:false,systemLow:false},certificateExpiresAt:new Date(now+90*86400000).toISOString()};
 const codes=input=>evaluateBranchAlerts({runtime,outboxPending:0,backup,cloudConfigured:true,now,...input}).map(a=>a.code);
 check('a healthy PC raises no alerts',()=>assert.deepEqual(codes({}),[]));
 check('a backup timer firing is not success: stale or failed backups alert',()=>{assert.deepEqual(codes({backup:{...backup,lastSuccessAt:ago(50).toISOString()}}),['BACKUP_STALE']);assert.deepEqual(codes({backup:{...backup,healthy:false}}),['BACKUP_STALE']);assert.deepEqual(codes({backup:null}),['BACKUP_UNKNOWN'])});
 check('failing WAL archiving, low disks, off-site failure and certificate expiry alert',()=>assert.deepEqual(codes({backup:{...backup,archive:{healthy:false},capacity:{backupLow:true,systemLow:true},offsiteHealthy:false,certificateExpiresAt:new Date(now+5*86400000).toISOString()}}),['WAL_ARCHIVE_FAILING','BACKUP_DISK_LOW','SYSTEM_DISK_LOW','OFFSITE_BACKUP_FAILING','CERTIFICATE_EXPIRING']));
 check('sync problems alert: unreachable cloud, broken chain, refused or stale checkpoint, backlog',()=>{
  assert.deepEqual(codes({runtime:{...runtime,lastSyncedAt:ago(40)}}),['CLOUD_UNREACHABLE']);
  assert.deepEqual(codes({runtime:{...runtime,replicaChainError:'x'}}),['ERP_CHAIN_BROKEN']);
  assert.deepEqual(codes({runtime:{...runtime,replicaError:'x'}}),['ERP_CHECKPOINT_REFUSED']);
  assert.deepEqual(codes({runtime:{...runtime,dataRevision:20n,lastReplicaAt:ago(90)}}),['ERP_CHECKPOINT_STALE']);
  assert.deepEqual(codes({outboxPending:5000}),['OUTBOX_BACKLOG'])});
 check('a PC not connected to any cloud is not alerted for cloud sync',()=>assert.deepEqual(evaluateBranchAlerts({runtime:{...runtime,lastSyncedAt:null},outboxPending:0,backup,cloudConfigured:false,now}).map(a=>a.code),[]));
 const node={isActive:true,ownsWrites:true,lastSeenAt:ago(1),replicaError:null,healthReport:{alerts:[{code:'BACKUP_STALE',severity:'critical',message:'m'}]},healthReportedAt:ago(2)};
 check('the cloud adds what only it can see: a silent PC, escalating with time',()=>{assert.deepEqual(cloudBranchAlerts({...node,lastSeenAt:ago(20),healthReport:null},now).map(a=>[a.code,a.severity]),[['PC_SILENT','warning']]);assert.deepEqual(cloudBranchAlerts({...node,lastSeenAt:ago(120),healthReport:null},now).map(a=>a.severity),['critical'])});
 check('reported alerts are shown only while the report is fresh',()=>{assert.deepEqual(cloudBranchAlerts(node,now).map(a=>a.code),['BACKUP_STALE']);assert.deepEqual(cloudBranchAlerts({...node,healthReportedAt:ago(30)},now).map(a=>a.code),[])});
 check('a revoked PC that still owns its branch is critical',()=>assert.deepEqual(cloudBranchAlerts({...node,isActive:false},now).map(a=>a.code),['BRANCH_FENCED_WITHOUT_PC']));

 // Cloud endpoint and webhook delivery.
 const app=require('../dist/app').default,db=cloud.client();
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const base=`http://127.0.0.1:${server.address().port}/api/v1`;
 const org=await db.organization.create({data:{name:'Alert org'}}),branch=await db.branch.create({data:{organizationId:org.id,name:'Alert branch',code:'AL'}});
 const token=crypto.randomBytes(32).toString('hex');
 await db.branchSyncNode.create({data:{organizationId:org.id,branchId:branch.id,name:'Alert PC',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),lastSeenAt:new Date()}});
 const post=(body,t=token)=>fetch(base+'/branch-sync/health',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify(body)});
 let r=await post({alerts:[{code:'BACKUP_STALE',severity:'critical',message:'No backup'}]});
 check('the PC reports its alerts with its own credentials',()=>assert.equal(r.status,200));
 r=await post({alerts:[]},'0'.repeat(64));check('other credentials cannot report health',()=>assert.equal(r.status,401));
 r=await post({alerts:[{code:'lowercase',severity:'critical',message:'x'}]});check('malformed reports are rejected',()=>assert.equal(r.status,400));
 const received=[];let failNext=false;
 hook=await new Promise(res=>{const s=http.createServer((req,resp)=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{if(failNext){failNext=false;resp.statusCode=500;return resp.end()}received.push(JSON.parse(b));resp.end('ok')})});s.listen(0,'127.0.0.1',()=>res(s))});
 process.env.ALERT_WEBHOOK_URL=`http://127.0.0.1:${hook.address().port}/alerts`;
 await notifyBranchAlerts();
 check('a new alert set is posted to the webhook with branch identity',()=>{assert.equal(received.length,1);assert.equal(received[0].branchId,branch.id);assert.equal(received[0].branchName,'Alert branch');assert.deepEqual(received[0].alerts.map(a=>a.code),['BACKUP_STALE'])});
 await notifyBranchAlerts();check('an unchanged alert set is not posted again',()=>assert.equal(received.length,1));
 await post({alerts:[]});failNext=true;await notifyBranchAlerts();
 check('a failed delivery is not recorded as notified',()=>assert.equal(received.length,1));
 await notifyBranchAlerts();
 check('the next run retries and reports the cleared state',()=>{assert.equal(received.length,2);assert.equal(received[1].cleared,true)});
 console.log(`${checks} branch health checks passed.`);
 await db.$disconnect();await require('../dist/config').prisma.$disconnect();
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));if(hook)await new Promise(r=>hook.close(r));await cloud?.drop().catch(()=>{})});
