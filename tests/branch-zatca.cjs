// ZATCA devices registered in the cloud move to the branch PC automatically:
// three counters, chains continued, secrets never readable in transit.
// Cloud here (key K1); PC steps run as separate processes with key K2. fs_qa_* only.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {createScratch}=require('./scratch-db.cjs');
const execAsync=require('node:util').promisify(require('node:child_process').execFile);
const backend=path.resolve(__dirname,'..'),repo=path.resolve(backend,'..');
let checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
function selfSignedBody(){const rs=require('jsrsasign');const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'secp256k1'});const cert=new rs.KJUR.asn1.x509.Certificate({version:3,serial:{int:4242},issuer:{str:'/CN=TestCA'},subject:{str:'/CN=Test EGS'},notbefore:'250101000000Z',notafter:'351231235959Z',sbjpubkey:publicKey.export({type:'spki',format:'pem'}),sigalg:'SHA256withECDSA',cakey:privateKey.export({type:'sec1',format:'pem'})});return cert.getPEM().replace(/-----[^-]+-----|\s/g,'')}
const scratch=[];let server,cloudDb,work;
(async()=>{
 const cloud=await createScratch(),pc=await createScratch();scratch.push(cloud,pc);
 execFileSync(process.execPath,[path.join(backend,'prisma/sync-permissions.js')],{env:{...process.env,DATABASE_URL:cloud.url},stdio:'pipe',cwd:backend});
 const K1=crypto.randomBytes(32).toString('base64'),K2=crypto.randomBytes(32).toString('base64');
 Object.assign(process.env,{DATABASE_URL:cloud.url,NODE_ENV:'test',ZATCA_ENCRYPTION_KEY:K1});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const {zatcaApi}=require('../dist/services/zatca/api'),token64=Buffer.from(selfSignedBody()).toString('base64');let cloudReports=0;
 Object.assign(zatcaApi,{complianceCsid:async(_e,csr)=>({status:200,ok:true,data:{binarySecurityToken:token64,secret:'s3cret-compliance',requestID:77,csr},text:''}),complianceInvoice:async()=>({status:200,ok:true,data:{validationResults:{status:'PASS'}},text:''}),productionCsid:async()=>({status:200,ok:true,data:{binarySecurityToken:token64,secret:'pr0d-secret-value',requestID:78},text:''}),report:async()=>{cloudReports++;return {status:200,ok:true,data:{reportingStatus:'REPORTED',validationResults:{status:'PASS',warningMessages:[]}},text:''}}});
 const app=require('../dist/app').default,{signAccessToken}=require('../dist/utils/jwt'),{importBranch}=require('../dist/services/branchImport'),zatca=require('../dist/services/zatca/index'),{unseal}=require('../dist/services/zatca/crypto');
 cloudDb=cloud.client();
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const origin=`http://127.0.0.1:${server.address().port}`,base=origin+'/api/v1';
 async function api(method,route,body,token){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json().catch(()=>null)}}
 const org=await cloudDb.organization.create({data:{name:'Zaitoon KSA',tradeName:'Zaitoon',country:'SA',currency:'SAR',timezone:'Asia/Riyadh',vatNumber:'399999999900003',crNumber:'1010010000'}});
 const branch=await cloudDb.branch.create({data:{organizationId:org.id,name:'Makkah',code:'MAK',vatRate:15}});
 const owner=await cloudDb.user.create({data:{organizationId:org.id,email:'zatca-owner@example.invalid',passwordHash:'TEST-HASH-ONLY',firstName:'Z',lastName:'O'}}),role=await cloudDb.role.create({data:{organizationId:org.id,name:'super_admin',displayName:'SA'}});
 await cloudDb.userRole.create({data:{userId:owner.id,roleId:role.id}});
 const category=await cloudDb.menuCategory.create({data:{organizationId:org.id,name:'Menu'}}),dish=await cloudDb.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Meal',price:23}});
 const token=signAccessToken(owner.id,org.id,owner.email);
 let r=await api('PUT','/zatca/settings',{vatNumber:'399999999900003',crNumber:'1010010000',zatcaEnabled:true},token);assert.equal(r.status,200,JSON.stringify(r.data));
 const address={street:'Ibrahim Al Khalil',building:'1234',district:'Ajyad',city:'Makkah',postalCode:'24231'};
 const counters=['C2','C3','main'];
 for(const counterCode of counters){r=await api('POST','/zatca/devices',{branchId:branch.id,environment:'sandbox',otp:'123456',counterCode,...address},token);assert.equal(r.status,201,JSON.stringify(r.data))}
 const active=await cloudDb.zatcaDevice.count({where:{branchId:branch.id,status:'active'}});
 check('three counters are registered with ZATCA in the cloud',()=>assert.equal(active,3));
 // One sale invoiced and reported by the cloud before the PC takes over.
 const cloudOrder=await cloudDb.customerOrder.create({data:{organizationId:org.id,branchId:branch.id,orderNo:1001,orderType:'takeaway',status:'completed',closedAt:new Date(Date.now()-120*86400000),counterCode:'main',paymentMethod:'cash',subtotal:20,vatRate:15,vatAmount:3,totalAmount:23,items:{create:{dishId:dish.id,dishName:'Meal',unitPrice:23,quantity:1,lineTotal:23}}}});
 const cloudInvoice=await zatca.issueForOrder(cloudOrder.id,'invoice');await zatca.reportDue();
 const cloudDevicesBefore=await cloudDb.zatcaDevice.findMany({orderBy:{counterCode:'asc'}});
 r=await api('POST','/branch-sync/nodes',{branchId:branch.id,name:'Makkah master PC'},token);assert.equal(r.status,201,JSON.stringify(r.data));const node=r.data;

 work=fs.mkdtempSync(path.join(os.tmpdir(),'fs-zatca-'));const keyPath=path.join(work,'transfer-key.pem');
 const publicKey=execFileSync(process.execPath,[path.join(repo,'deploy/windows/transfer-key.cjs'),keyPath]).toString();
 r=await api('POST',`/branch-operations/provision/${branch.id}`,{nodeId:node.id,transferPublicKey:'not a key'.padEnd(120,'x')},token);
 check('an invalid transfer key is refused',()=>{assert.equal(r.status,400);assert.equal(r.data.code,'TRANSFER_KEY_INVALID')});
 r=await api('POST',`/branch-operations/provision/${branch.id}`,{nodeId:node.id,transferPublicKey:publicKey},token);assert.equal(r.status,200,JSON.stringify(r.data));
 const pkg=r.data,text=JSON.stringify(pkg);
 check('the package carries all three counters with their chain position',()=>{assert.equal(pkg.tables.ZatcaDevice.length,3);const main=pkg.tables.ZatcaDevice.find(d=>d.counterCode==='main');assert.equal(main.icv,1);assert.equal(main.lastInvoiceHash,cloudInvoice.hash);assert.equal(pkg.tables.Organization[0].zatcaEnabled,true)});
 check('no secret is readable in the package, and no cloud-sealed value travels',()=>{for(const s of ['s3cret-compliance','pr0d-secret-value','PRIVATE KEY',K1])assert.ok(!text.includes(s),s);for(const d of cloudDevicesBefore)for(const f of ['privateKeySealed','complianceSecretSealed','productionSecretSealed'])assert.ok(!text.includes(d[f]),f)});
 check('invoices older than 90 days travel for refunds, without their XML',()=>{assert.equal(pkg.tables.ZatcaDocument.length,1);assert.equal(pkg.tables.ZatcaDocument[0].xml,'')});
 const legacy=await api('GET',`/branch-operations/provision/${branch.id}?nodeId=${node.id}`,undefined,token);
 check('an installer without a transfer key gets no fiscal devices and e-invoicing off',()=>{assert.equal(legacy.data.tables.ZatcaDevice,undefined);assert.equal(legacy.data.fiscalDevices,undefined);assert.equal(legacy.data.tables.Organization[0].zatcaEnabled,false)});

 // The real installer step, with the PC's own key.
 const settings={installDirectory:repo,databaseUrl:pc.url,nodeId:node.id,branchId:branch.id,numberSeries:node.numberSeries,syncHr:false,zatcaEncryptionKey:K2,transferKeyPath:keyPath};
 fs.writeFileSync(path.join(work,'settings.json'),JSON.stringify(settings));fs.writeFileSync(path.join(work,'package.json'),text);
 const provisioned=execFileSync(process.execPath,[path.join(repo,'deploy/windows/provision.cjs'),path.join(work,'settings.json'),path.join(work,'package.json')],{cwd:backend}).toString();
 const pcDb=pc.client(),pcDevices=await pcDb.zatcaDevice.findMany({orderBy:{counterCode:'asc'}});
 check('the installer re-seals each device under the PC key and deletes the transfer key',()=>{assert.match(provisioned,/ZATCA devices installed: 3/);assert.equal(fs.existsSync(keyPath),false);for(const d of pcDevices){assert.ok(d.privateKeySealed);assert.notEqual(d.privateKeySealed,cloudDevicesBefore.find(c=>c.id===d.id).privateKeySealed)}});
 check('the cloud key cannot open the PC copies',()=>assert.throws(()=>unseal(pcDevices[0].privateKeySealed)));
 await pcDb.$disconnect();

 // The PC signs on three counters at once, refunds the cloud sale and syncs.
 const out=JSON.parse((await execAsync(process.execPath,[path.join(__dirname,'helpers/pc-zatca.cjs')],{cwd:backend,stdio:['ignore','pipe','inherit'],env:{...process.env,DATABASE_URL:pc.url,ZATCA_ENCRYPTION_KEY:K2,JWT_SECRET:crypto.randomBytes(32).toString('hex'),FOODSYNC_DEPLOYMENT_MODE:'branch',NODE_ENV:'test',BRANCH_CLOUD_URL:origin,BRANCH_SYNC_TOKEN:node.token,PC_INPUT:JSON.stringify({org:org.id,branch:branch.id,dish:dish.id,counters:['main','C2','C3'],creditOrderId:cloudOrder.id})}})).stdout.trim().split('\n').pop());
 const byCounter=Object.fromEntries(out.devices.map(d=>[d.id,d.counterCode]));
 check('the PC opens the transferred keys with its own key',()=>assert.equal(out.unsealed,true));
 check('each counter signs with its own device',()=>assert.deepEqual(out.docs.map(d=>byCounter[d.deviceId]),['main','C2','C3']));
 check('the main counter continues the cloud chain; new counters start their own',()=>{assert.equal(out.docs[0].icv,2);assert.equal(out.docs[0].previousHash,cloudInvoice.hash);assert.equal(out.docs[1].icv,1);assert.equal(out.docs[2].icv,1);assert.ok(out.docs.every(d=>d.qr))});
 check('a refund of a cloud-era sale is credited on the PC by the original counter',()=>{assert.equal(byCounter[out.credit.deviceId],'main');assert.equal(out.credit.icv,3);assert.equal(out.credit.previousHash,out.docs[0].hash)});
 const nodeAfter=await cloudDb.branchSyncNode.findUnique({where:{id:node.id}});if(!out.synced)console.error('CLOUD-DIAG',nodeAfter.replicaError);
 check('the PC synchronizes its fiscal records upward',()=>assert.equal(out.synced,true));
 const cloudDocs=await cloudDb.zatcaDocument.count({where:{branchId:branch.id}}),cloudMain=await cloudDb.zatcaDevice.findFirst({where:{counterCode:'main'}});
 check('the cloud now holds every invoice and the latest chain position, keeping its own sealed secrets',()=>{assert.equal(cloudDocs,5);assert.equal(cloudMain.icv,3);assert.equal(cloudMain.lastInvoiceHash,out.credit.hash);assert.equal(cloudMain.privateKeySealed,cloudDevicesBefore.find(d=>d.counterCode==='main').privateKeySealed);assert.ok(unseal(cloudMain.privateKeySealed).includes('PRIVATE KEY'))});
 const before=cloudReports;await zatca.reportDue();
 const pending=await cloudDb.zatcaDocument.findUnique({where:{id:out.docs[2].id}});
 check('the cloud never re-reports invoices the PC signed',()=>{assert.equal(pending.status,'failed');assert.equal(cloudReports,before)});
 await assert.rejects(()=>cloudDb.zatcaDevice.update({where:{id:cloudMain.id},data:{icv:{increment:1}}}),e=>e.message.includes('FOODSYNC_BRANCH_OWNERSHIP'));
 await assert.rejects(()=>cloudDb.zatcaDocument.create({data:{organizationId:org.id,branchId:branch.id,deviceId:cloudMain.id,type:'invoice',invoiceNo:'X',uuid:crypto.randomUUID(),icv:99,hash:'h',previousHash:'p',qr:'q',xml:'x',issuedAt:new Date(),totalAmount:1,vatAmount:0}}),e=>e.message.includes('FOODSYNC_BRANCH_OWNERSHIP'));
 check('the cloud cannot advance a counter chain or add an invoice for the PC branch (one signer per counter)',()=>{});
 console.log(`${checks} branch ZATCA checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{
 if(server)await new Promise(r=>server.close(r));await cloudDb?.$disconnect();await require('../dist/config').prisma.$disconnect().catch(()=>{});
 if(work)fs.rmSync(work,{recursive:true,force:true});for(const s of scratch)await s.drop().catch(e=>console.error('cleanup',e.message));
});
