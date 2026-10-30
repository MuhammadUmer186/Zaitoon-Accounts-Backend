const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),{spawn}=require('node:child_process');
const {createScratch}=require('./scratch-db.cjs');let cloud,pc,db,local,server,proxy,child,checks=0;const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
(async()=>{
 cloud=await createScratch();pc=await createScratch();Object.assign(process.env,{DATABASE_URL:cloud.url,NODE_ENV:'test',FREE_DISH_RATE_LIMIT:'5'});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{signAccessToken,signBranchRelayToken}=require('../dist/utils/jwt'),{exportBranch}=require('../dist/services/branchProvisioning'),{importBranch}=require('../dist/services/branchImport');db=cloud.client();local=pc.client();
 for(const key of ['free_dish_manage','free_dish_redeem'])await db.permission.create({data:{key,module:'free_dish'}});
 const org=await db.organization.create({data:{name:'Voucher QA'}}),branch=await db.branch.create({data:{organizationId:org.id,code:'ZB-002',name:'A'}}),other=await db.branch.create({data:{organizationId:org.id,code:'ZB-003',name:'B'}});
 const owner=await db.user.create({data:{organizationId:org.id,email:'vouchers@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'Owner'}}),role=await db.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});await db.userRole.create({data:{userId:owner.id,roleId:role.id}});
 const staff=await db.user.create({data:{organizationId:org.id,email:'no-voucher@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'NoAccess'}});await db.userBranchAccess.create({data:{userId:staff.id,organizationId:org.id,branchId:branch.id}});
 const section=await db.branchSection.create({data:{organizationId:org.id,branchId:branch.id,name:'Juice'}}),otherSection=await db.branchSection.create({data:{organizationId:org.id,branchId:other.id,name:'Other'}}),item=await db.freeDishItem.create({data:{organizationId:org.id,name:'Icecream'}});
 const nodeToken=crypto.randomBytes(32).toString('hex'),node=await db.branchSyncNode.create({data:{organizationId:org.id,branchId:branch.id,name:'QA PC',numberSeries:'P1',tokenHash:crypto.createHash('sha256').update(nodeToken).digest('hex'),provisionedBy:owner.id}});
 // Created after enrollment: the central voucher authority remains writable.
 const offer=await db.freeDishQr.create({data:{organizationId:org.id,branchId:branch.id,sectionId:section.id,itemId:item.id,name:'Icecream',publicToken:crypto.randomBytes(32).toString('hex'),createdBy:owner.id}}),foreign=await db.freeDishQr.create({data:{organizationId:org.id,branchId:other.id,sectionId:otherSection.id,itemId:item.id,name:'Other',publicToken:crypto.randomBytes(32).toString('hex'),createdBy:owner.id}});
 const pkg=await exportBranch({user:{id:owner.id,organizationId:org.id,email:owner.email}},branch.id);check('bootstrap never creates another voucher authority on the PC',()=>{assert.equal(pkg.tables.FreeDishQr,undefined);assert.equal(pkg.tables.FreeDishSubmission,undefined)});await importBranch(local,pkg);await local.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:org.id,branchId:branch.id,numberSeries:'P1'}});
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const cloudUrl=`http://127.0.0.1:${server.address().port}`,branchSecret=crypto.randomBytes(32).toString('hex');
 // The PC reaches the cloud through this proxy, which can drop one redemption
 // reply after the cloud has committed it (the genuinely ambiguous case).
 let dropRedeem=false;
 proxy=await new Promise(r=>{const s=require('node:http').createServer((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',async()=>{try{const up=await fetch(cloudUrl+req.url,{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json',...(req.headers.authorization&&{authorization:req.headers.authorization})},...(req.method!=='GET'&&{body})});const buf=Buffer.from(await up.arrayBuffer());if(dropRedeem&&req.url.endsWith('/branch-sync/free-dish')&&body.includes('"/redeem"')){dropRedeem=false;req.socket.destroy();return}res.writeHead(up.status,{'content-type':up.headers.get('content-type')||'application/json'});res.end(buf)}catch{req.socket.destroy()}})});s.listen(0,'127.0.0.1',()=>r(s))});
 const proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
 child=spawn(process.execPath,[path.join(__dirname,'helpers/pc-test-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:pc.url,FOODSYNC_DEPLOYMENT_MODE:'branch',JWT_SECRET:branchSecret,BRANCH_CLOUD_URL:proxyUrl,BRANCH_SYNC_TOKEN:nodeToken},stdio:['ignore','pipe','pipe']});
 const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('PC test server start timeout')),20000);child.stdout.on('data',data=>{output+=data;const m=output.match(/QA_SERVER_PORT=(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]))}});child.once('exit',code=>reject(new Error('PC exited '+code)))});
 const jwt=require('jsonwebtoken'),pcToken=jwt.sign({userId:owner.id,organizationId:org.id,email:owner.email},branchSecret),noAccess=jwt.sign({userId:staff.id,organizationId:org.id,email:staff.email},branchSecret);
 async function api(origin,method,route,body,token=pcToken,clientIp){const r=await fetch(origin+'/api/v1'+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,...(clientIp&&{'X-Forwarded-For':clientIp})},...(body!==undefined&&{body:JSON.stringify(body)})});const text=await r.text();return {status:r.status,data:(()=>{try{return JSON.parse(text)}catch{return text}})()}}
 const pcUrl=`http://127.0.0.1:${port}`;
 let r=await api(pcUrl,'GET',`/public/free-dish/qr/${offer.publicToken}`);check('public offer works on the branch LAN through central authority',()=>assert.equal(r.status,200,JSON.stringify(r.data)));
 const guest={fullName:'QA Guest',country:'PK',dialingCountry:'PK',whatsapp:'03001112233',email:'voucher-guest@example.invalid',dateOfBirth:'1990-01-01'};
 r=await api(pcUrl,'POST',`/public/free-dish/qr/${offer.publicToken}/submit`,guest);check('LAN form registers once in the cloud without a local voucher copy',()=>{assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.data.voucherCode,/^FD-/)});const code=r.data.voucherCode;assert.equal(await db.freeDishSubmission.count(),1);assert.equal(await local.freeDishSubmission.count(),0);
 r=await api(pcUrl,'POST',`/public/free-dish/qr/${offer.publicToken}/submit`,guest);check('registration retry returns the same voucher',()=>assert.equal(r.data.voucherCode,code));
 r=await api(pcUrl,'GET',`/public/free-dish/qr/${foreign.publicToken}`);check('a branch cannot relay another branch public offer',()=>assert.equal(r.status,404));
 r=await api(pcUrl,'POST','/free-dish/verify',{input:code},noAccess);check('cloud checks real staff voucher permission, not node credentials alone',()=>assert.equal(r.status,403));
 r=await api(pcUrl,'POST','/free-dish/verify',{input:code});check('permitted staff verify central voucher state from the branch UI',()=>{assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.state,'valid')});
 const directToken=signAccessToken(owner.id,org.id,owner.email);
 const racing=await Promise.all(Array.from({length:8},(_,i)=>api(i%2?pcUrl:cloudUrl,'POST','/free-dish/redeem',{input:code},i%2?pcToken:directToken)));
 check('simultaneous cloud and LAN scanners confirm collection exactly once',()=>{assert.equal(racing.filter(r=>r.status===200).length,1,JSON.stringify(racing));assert.ok(racing.filter(r=>r.status!==200).every(r=>r.data.code==='ALREADY_REDEEMED'))});assert.equal(await db.auditLog.count({where:{action:'redeem_free_dish'}}),1);
 r=await api(pcUrl,'POST','/free-dish/verify',{input:code});check('lost redemption response can be resolved by verifying the final central state',()=>assert.equal(r.data.state,'redeemed'));
 r=await api(pcUrl,'GET','/free-dish/submissions');check('branch registrations table and summaries read the central records',()=>{assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.metrics.redeemedVouchers,1);assert.equal(r.data.data.length,1)});
 r=await api(pcUrl,'GET',`/free-dish/submissions?branchId=${other.id}`);check('even a cloud owner relay is constrained to the enrolled branch',()=>assert.equal(r.status,403));
 r=await api(pcUrl,'POST','/free-dish/items',{name:'Not allowed'});check('cloud-managed offers cannot be changed through branch relay',()=>assert.equal(r.data.code,'CENTRALLY_MANAGED_CONFIGURATION'));
 r=await api(cloudUrl,'GET','/users',undefined,signBranchRelayToken(owner.id,org.id,owner.email,branch.id));check('short-lived relay capability cannot access staff or other modules',()=>assert.equal(r.status,401));
 // Registration limits apply per guest although every relay reaches the cloud from loopback.
 const guests=[];for(let i=1;i<=6;i++)guests.push(await api(pcUrl,'POST',`/public/free-dish/qr/${offer.publicToken}/submit`,{...guest,whatsapp:`0300111${2200+i}`,email:`guest-${i}@example.invalid`},pcToken,`10.20.0.${i}`));
 check('six guests behind one branch PC all register under a limit of five per guest',()=>assert.ok(guests.every(g=>g.status===200),JSON.stringify(guests.map(g=>g.status))));
 const repeat=[];for(let i=0;i<6;i++)repeat.push(await api(pcUrl,'POST',`/public/free-dish/qr/${offer.publicToken}/submit`,guest,pcToken,'10.20.1.1'));
 check('a single guest is still limited',()=>{assert.ok(repeat.slice(0,5).every(g=>g.status===200));assert.equal(repeat[5].status,429)});
 // A collection whose reply is lost is never presented as 'not collected'.
 const second=guests[0].data.voucherCode;dropRedeem=true;
 r=await api(pcUrl,'POST','/free-dish/redeem',{input:second});
 check('a redemption whose reply is lost tells staff not to hand out the dish yet',()=>{assert.equal(r.status,503);assert.equal(r.data.code,'FREE_DISH_UNCONFIRMED')});
 r=await api(pcUrl,'POST','/free-dish/verify',{input:second});
 check('verifying shows the collection was recorded centrally',()=>assert.equal(r.data.state,'redeemed'));
 r=await api(pcUrl,'POST','/free-dish/redeem',{input:second});
 check('a second attempt is refused as already collected',()=>assert.equal(r.data.code,'ALREADY_REDEEMED'));
 await db.user.update({where:{id:owner.id},data:{isActive:false}});r=await api(pcUrl,'POST','/free-dish/verify',{input:code});check('disabling staff in the cloud immediately revokes voucher operations',()=>assert.equal(r.status,403));
 await db.branchSyncNode.update({where:{id:node.id},data:{isActive:false}});r=await api(pcUrl,'GET',`/public/free-dish/qr/${offer.publicToken}`);check('revoked PC loses public voucher relay access',()=>assert.equal(r.status,401));
 await new Promise(r=>server.close(r));server=null;await new Promise(r=>proxy.close(r));proxy=null;r=await api(pcUrl,'POST','/free-dish/redeem',{input:code});check('cloud outage never records an offline voucher redemption',()=>{assert.equal(r.status,503);assert.equal(r.data.code,'FREE_DISH_OFFLINE')});assert.equal(await local.freeDishSubmission.count(),0);
 console.log(`${checks} branch Free Dish checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{child?.kill();if(server)await new Promise(r=>server.close(r));if(proxy)await new Promise(r=>proxy.close(r));await db?.$disconnect();await local?.$disconnect();await require('../dist/config').prisma.$disconnect();await pc?.drop();await cloud?.drop()});
