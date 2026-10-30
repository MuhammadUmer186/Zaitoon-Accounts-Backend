// Real HTTP + PostgreSQL, using only self-owned scratch databases and files.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createScratch}=require('./scratch-db.cjs');
let cloud,local,db,pc,server,checks=0;const cleanup=[];
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name)};
async function ownedDirectory(dir){await fs.mkdir(dir,{recursive:true});cleanup.push(dir);return dir}
(async()=>{
 cloud=await createScratch();local=await createScratch();
 Object.assign(process.env,{DATABASE_URL:cloud.url,NODE_ENV:'test'});delete process.env.FOODSYNC_DEPLOYMENT_MODE;
 const app=require('../dist/app').default,{UPLOAD_ROOT}=require('../dist/middleware/upload'),media=require('../dist/services/branchMedia');
 const {exportBranch}=require('../dist/services/branchProvisioning'),{importBranch}=require('../dist/services/branchImport');
 const {applyBranchDelta,buildBranchDelta}=require('../dist/services/branchReplica');
 const {signAccessToken}=require('../dist/utils/jwt');
 db=cloud.client();pc=local.client();
 for(const key of ['can_view_hr','can_view_payroll'])await db.permission.create({data:{key,module:'hr'}});
 const org=await db.organization.create({data:{name:'Media QA'}}),otherOrg=await db.organization.create({data:{name:'Foreign'}});
 const branch=await db.branch.create({data:{organizationId:org.id,code:'ZB-002',name:'QA'}}),other=await db.branch.create({data:{organizationId:org.id,code:'OTHER',name:'Other'}});
 const user=await db.user.create({data:{organizationId:org.id,email:'media@example.invalid',passwordHash:'TEST-HASH',firstName:'QA',lastName:'Owner'}}),role=await db.role.create({data:{organizationId:org.id,name:'owner',displayName:'Owner'}});await db.userRole.create({data:{userId:user.id,roleId:role.id}});
 // Owner is a built-in permission role; no live staff/passwords are involved.
 const dir=await ownedDirectory(path.join(UPLOAD_ROOT,org.id));
 const imageDir=await ownedDirectory(path.join(UPLOAD_ROOT,'menu',`qa-${org.id}`));
 cleanup.push(path.join(UPLOAD_ROOT,'branch-media',org.id));
 const pdf=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(470000,65),Buffer.from('\n%%EOF')]),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7fsAAAAASUVORK5CYII=','base64');
 await fs.writeFile(path.join(dir,'bill.pdf'),pdf);await fs.writeFile(path.join(imageDir,'dish.png'),png);
 const hrDir=await ownedDirectory(path.join(UPLOAD_ROOT,'hr',org.id));await fs.writeFile(path.join(hrDir,'identity.pdf'),pdf);
 const hrDoc=await db.hrRecord.create({data:{organizationId:org.id,branchId:branch.id,kind:'documents',title:'QA document',date:new Date(),createdBy:user.id,data:{filePath:path.join(hrDir,'identity.pdf'),fileName:'identity.pdf',fileType:'application/pdf'}}});
 const category=await db.menuCategory.create({data:{organizationId:org.id,name:'Meals'}}),dish=await db.dish.create({data:{organizationId:org.id,categoryId:category.id,name:'Meal',price:10,imagePath:path.join(imageDir,'dish.png')}});
 await db.organization.update({where:{id:org.id},data:{logoPath:path.join(imageDir,'dish.png')}});
 const doc=await db.document.create({data:{organizationId:org.id,branchId:branch.id,originalFilename:'bill.pdf',storedFilename:'bill.pdf',filePath:path.join(dir,'bill.pdf'),fileType:'application/pdf',fileSize:pdf.length,uploadedBy:user.id}});
 const hidden=await db.document.create({data:{...Object.fromEntries(Object.entries(doc).filter(([k])=>!['id','createdAt'].includes(k))),branchId:other.id}});
 const token=crypto.randomBytes(32).toString('hex'),node=await db.branchSyncNode.create({data:{organizationId:org.id,branchId:branch.id,name:'QA PC',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),provisionedBy:user.id,numberSeries:'P1'}});
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});const origin=`http://127.0.0.1:${server.address().port}`;
 async function api(route,body,auth=token){const res=await fetch(origin+'/api/v1/branch-sync/media/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},body:JSON.stringify(body)});return {status:res.status,data:await res.json()}}
 const principal={user:{id:user.id,organizationId:org.id,email:user.email}};
 const pkg=await exportBranch(principal,branch.id);
 const imageRef=pkg.tables.Dish[0].imagePath,docRef=pkg.tables.Document[0].filePath;
 check('bootstrap includes only selected branch documents and portable image/branding references',()=>{assert.equal(pkg.tables.Document.length,1);assert.equal(pkg.tables.Document[0].id,doc.id);assert.match(imageRef,/^fsmedia:1:Dish:/);assert.match(pkg.tables.Organization[0].logoPath,/^fsmedia:1:Organization:/);assert.ok(!JSON.stringify(pkg).includes(dir));assert.ok(!JSON.stringify(pkg).includes(imageDir))});
 let r=await api('read',{kind:'Document',id:doc.id,ref:docRef,offset:0});check('authorized branch download returns bounded bytes with an exact offset/reference',()=>{assert.equal(r.status,200);assert.equal(r.data.ref,docRef);assert.equal(r.data.offset,0);assert.equal(Buffer.from(r.data.data,'base64').length,192*1024);assert.equal(r.data.complete,false)});
 r=await api('read',{kind:'Document',id:hidden.id,ref:docRef,offset:0});check('foreign branch attachments cannot be downloaded',()=>assert.equal(r.status,404));
 r=await api('read',{kind:'Organization',id:otherOrg.id,ref:pkg.tables.Organization[0].logoPath,offset:0});check('foreign organization branding cannot be downloaded',()=>assert.equal(r.status,404));
 r=await api('read',{kind:'HrRecord',id:crypto.randomUUID(),ref:docRef.replace('Document','HrRecord'),offset:0});check('HR attachment transfer requires confidential HR enrollment',()=>assert.equal(r.status,403));
 r=await api('read',{kind:'Document',id:doc.id,ref:docRef,offset:0},'bad');check('anonymous or invalid node cannot download attachments',()=>assert.equal(r.status,401));
 r=await api('write',{ref:imageRef,offset:0,data:''});check('branch cannot overwrite cloud catalog/branding images',()=>assert.equal(r.status,403));
 // Lose the branch's cached copy. Cloud reads reconstruct the immutable blob
 // from its source; the client resumes and verifies before DB activation.
 await fs.unlink(media.mediaPath(node,docRef));
 await media.pullPackageMedia(pkg.tables,node,origin,token);
 const imported=await importBranch(pc,pkg),importedDoc=await pc.document.findUnique({where:{id:doc.id}});
 check('installer downloads and imports working local attachments without source paths',()=>{assert.equal(imported.branchId,branch.id);assert.notEqual(importedDoc.filePath,doc.filePath);assert.match(importedDoc.filePath,/branch-media/)});
 check('imported attachment content matches the source byte for byte',()=>{});assert.deepEqual(await fs.readFile(importedDoc.filePath),pdf);
 const staffToken=signAccessToken(user.id,org.id,user.email);
 const image=await fetch(origin+`/api/v1/public/dishes/${dish.id}/image`);check('public dish image remains available',()=>assert.equal(image.status,200));assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
 // Upload a new blob in several calls, including a duplicate after lost ACK.
 const bytes=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(420000,66)]),digest=crypto.createHash('sha256').update(bytes).digest('hex'),ref=`fsmedia:1:Document:${digest}:pdf:${bytes.length}`;
 r=await api('write',{ref,offset:0,data:bytes.subarray(0,192*1024).toString('base64')});assert.equal(r.status,200);
 r=await api('write',{ref,offset:0,data:bytes.subarray(0,192*1024).toString('base64')});check('duplicate chunk resumes at the committed offset instead of appending twice',()=>{assert.equal(r.data.offset,192*1024);assert.equal(r.data.complete,false)});
 while(!r.data.complete)r=await api('write',{ref,offset:r.data.offset,data:bytes.subarray(r.data.offset,r.data.offset+192*1024).toString('base64')});
 check('multi-chunk upload completes with an authenticated immutable blob',()=>{assert.equal(r.status,200);assert.equal(r.data.offset,bytes.length)});assert.deepEqual(await fs.readFile(media.mediaPath(node,ref)),bytes);
 const pending={Document:[{...doc,id:crypto.randomUUID(),filePath:ref}]};await media.hydrateMedia(pending,node);
 await db.$transaction(tx=>applyBranchDelta(tx,node,pending,[]));
 const stored=await db.document.findUnique({where:{id:pending.Document[0].id}});check('received document metadata commits against the verified destination file',()=>assert.equal(stored.filePath,media.mediaPath(node,ref)));
 const request=await fetch(origin+`/api/v1/documents/${stored.id}/file`,{headers:{Authorization:'Bearer '+staffToken}});check('existing authenticated document workflow serves a synchronized attachment',()=>assert.equal(request.status,200));assert.deepEqual(Buffer.from(await request.arrayBuffer()),bytes);
 const noFile=structuredClone(pkg.tables);noFile.Document[0].filePath=docRef.replace(/:[a-f0-9]{64}:/,':'+ 'a'.repeat(64)+':');await assert.rejects(()=>media.hydrateMedia(noFile,node),e=>e.code==='MEDIA_INCOMPLETE');check('missing blob refuses activation rather than committing a broken document link',()=>{});
 await assert.rejects(()=>media.hydrateMedia({Document:[{filePath:'C:/private/secrets.txt'}]},node),e=>e.code==='MEDIA_INVALID');check('host paths from another PC are never accepted as incoming media',()=>{});
 const corruptRef=`fsmedia:1:Document:${'b'.repeat(64)}:pdf:9`;r=await api('write',{ref:corruptRef,offset:0,data:Buffer.from('%PDF-bad!').toString('base64')});check('changed or corrupt content fails SHA-256 verification',()=>{assert.equal(r.status,409);assert.equal(r.data.code,'MEDIA_INTEGRITY')});await assert.rejects(()=>fs.access(media.mediaPath(node,corruptRef)));
 const html=Buffer.from('<script>alert(1)</script>'),htmlRef=`fsmedia:1:Document:${crypto.createHash('sha256').update(html).digest('hex')}:pdf:${html.length}`;r=await api('write',{ref:htmlRef,offset:0,data:html.toString('base64')});check('client MIME claims do not permit HTML/script masquerading as a PDF',()=>assert.equal(r.data.code,'MEDIA_TYPE_INVALID'));
 await pc.branchRuntime.create({data:{id:'local',nodeId:node.id,organizationId:org.id,branchId:branch.id,numberSeries:'P1'}});
 await pc.document.update({where:{id:doc.id},data:{documentType:'bill'}});
 const delta=await buildBranchDelta(pc,0n);check('document changes enter the durable revision log and incremental checkpoint',()=>{assert.equal(delta.tables.Document.length,1);assert.match(delta.tables.Document[0].filePath,/^fsmedia:/)});
 await db.branchSyncNode.update({where:{id:node.id},data:{syncHr:true}});
 const hrPackage=await exportBranch(principal,branch.id,true),hrRef=hrPackage.tables.HrRecord[0].data.filePath;
 check('confidential bootstrap strips HR host paths and names their authenticated content',()=>{assert.match(hrRef,/^fsmedia:1:HrRecord:/);assert.ok(!JSON.stringify(hrPackage).includes(hrDir))});
 r=await api('read',{kind:'HrRecord',id:hrDoc.id,ref:hrRef,offset:0});check('enrolled node with current HR permissions can download its own HR attachment',()=>assert.equal(r.status,200,JSON.stringify(r.data)));
 const hrRows={HrRecord:hrPackage.tables.HrRecord};await media.hydrateMedia(hrRows,{...node,syncHr:true});await db.$transaction(tx=>applyBranchDelta(tx,node,hrRows,[]));
 const hrFile=await fetch(origin+`/api/v1/hr/records/documents/${hrDoc.id}/file`,{headers:{Authorization:'Bearer '+staffToken}});check('existing HR download workflow accepts a synchronized file while retaining access checks',()=>assert.equal(hrFile.status,200));assert.deepEqual(Buffer.from(await hrFile.arrayBuffer()),pdf);
 await db.permission.delete({where:{key:'can_view_payroll'}});r=await api('read',{kind:'HrRecord',id:hrDoc.id,ref:hrRef,offset:0});check('removing enrolling administrator payroll access stops confidential file downloads immediately',()=>assert.equal(r.status,403));
 await db.branchSyncNode.update({where:{id:node.id},data:{isActive:false}});r=await api('write',{ref,offset:0,data:''});check('revocation stops media upload immediately',()=>assert.equal(r.status,401));
 console.log(`${checks} branch media checks passed.`);
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1}).finally(async()=>{
 if(server)await new Promise(r=>server.close(r));await db?.$disconnect();await pc?.$disconnect();await require('../dist/config').prisma.$disconnect();
 for(const dir of cleanup.reverse())await fs.rm(dir,{recursive:true,force:true});await local?.drop();await cloud?.drop();
});
