// Audit probes: run only inside run-isolated.cjs's disposable fs_qa_* database.
const path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..'), backend = path.join(root, 'backend');
const outputDir = path.join(root,'outputs/qa-hardening-2026-10-26'); fs.mkdirSync(outputDir,{recursive:true});
require(path.join(backend,'node_modules/dotenv')).config({ path: path.join(backend,'.env') });
const dbName = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!/^fs_qa_[0-9]+_[0-9]+$/.test(dbName)) throw new Error('Security probes require the isolated QA database');
const { PrismaClient } = require(path.join(backend,'node_modules/@prisma/client'));
const bcrypt = require(path.join(backend,'node_modules/bcryptjs'));
const db = new PrismaClient(), evidence = [], matrix = [], profiles = [], roleNames = ['super_admin','owner','admin','accountant','branch_manager','cashier','store_keeper','kitchen_staff','call_center_agent','dispatcher','rider','waiter','hr_manager','hr_officer'];
let server, appDb, base;
const note = (id, title, expected, actual, defect, details = {}) => { evidence.push({ id,title,expected,actual,result:defect?'confirmed defect':'pass',...details }); console.log(`${defect ? 'FAIL' : 'PASS'} ${id} ${title}: ${JSON.stringify(actual)}`) };
async function request(method, route, body, token) {
  const r = await fetch(base + route, { method, headers: { 'Content-Type':'application/json', ...(token && { Authorization:'Bearer '+token }) }, ...(body !== undefined && { body:JSON.stringify(body) }) });
  const raw = await r.text(); let data; try { data = JSON.parse(raw) } catch { data = raw }
  return { status:r.status, data, raw, headers:Object.fromEntries(r.headers.entries()) };
}
(async () => {
  const {z}=require(path.join(backend,'node_modules/zod'));
  const {updateSchema}=require(path.join(backend,'dist/utils/updateSchema'));
  const creation=z.object({amount:z.number().min(0).default(500),active:z.boolean().default(true).optional(),label:z.string()}).strict();
  const patch=updateSchema(creation);
  note('VALIDATION-PATCH','Partial edits preserve omitted defaults and strict validation','No defaults injected; invalid inputs rejected',{empty:patch.parse({}),explicit:patch.parse({amount:0,active:false})},Object.keys(patch.parse({})).length!==0||patch.parse({amount:0}).amount!==0||patch.safeParse({amount:-1}).success||patch.safeParse({unknown:true}).success);
  const orgA = await db.organization.create({ data:{name:'QA Restaurant A',timezone:'Asia/Karachi'} }), orgB = await db.organization.create({ data:{name:'QA Restaurant B',timezone:'Asia/Karachi'} });
  const a = await db.branch.create({ data:{organizationId:orgA.id,name:'QA Allowed Branch',code:'QA-A'} }), b = await db.branch.create({ data:{organizationId:orgA.id,name:'QA Restricted Branch',code:'QA-B'} }), foreignBranch = await db.branch.create({ data:{organizationId:orgB.id,name:'QA Foreign Branch',code:'QA-F'} });
  for (const name of roleNames) await db.role.create({ data:{organizationId:orgA.id,name,displayName:name} });
  await db.role.create({ data:{organizationId:orgB.id,name:'cashier',displayName:'Foreign cashier'} });
  execFileSync(process.execPath,[path.join(backend,'prisma/sync-permissions.js')],{cwd:backend,env:process.env,stdio:'pipe'});
  const jwt = require(path.join(backend,'dist/utils/jwt'));
  const password = crypto.randomBytes(16).toString('hex'), hash = await bcrypt.hash(password,4);
  async function staff(name, orgId=orgA.id, roleName=name, branchId=null) {
    const user = await db.user.create({data:{organizationId:orgId,email:`qa-${name}-${crypto.randomUUID()}@example.invalid`,firstName:'QA',lastName:name,passwordHash:hash}});
    const role = await db.role.findFirstOrThrow({where:{organizationId:orgId,name:roleName}});
    await db.userRole.create({data:{userId:user.id,roleId:role.id}});
    if (branchId) await db.userBranchAccess.create({data:{organizationId:orgId,userId:user.id,branchId}});
    return {user,role,token:jwt.signAccessToken(user.id,orgId,user.email)};
  }
  const identities = {};
  for (const role of roleNames) identities[role] = await staff(role,orgA.id,role,['super_admin','owner','admin'].includes(role)?null:a.id);
  const owner = identities.owner;
  const foreign = await staff('foreign',orgB.id,'cashier',foreignBranch.id);
  const viewerRole = await db.role.create({data:{organizationId:orgA.id,name:'qa_report_viewer',displayName:'QA report viewer'}});
  for (const key of ['can_view_reports','can_view_financial_reports']) { const permission = await db.permission.findUniqueOrThrow({where:{key}}); await db.rolePermission.create({data:{roleId:viewerRole.id,permissionId:permission.id}}) }
  const viewer = await staff('report-viewer',orgA.id,viewerRole.name,a.id);
  const app = require(path.join(backend,'dist/app')).default; appDb = require(path.join(backend,'dist/config')).prisma;
  server = await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))}); base=`http://127.0.0.1:${server.address().port}/api/v1`;
  // Table-driven role checks use explicit documented permission gates.
  const section = await db.branchSection.create({data:{organizationId:orgA.id,branchId:a.id,name:'QA Counter'}});
  const item = await db.freeDishItem.create({data:{organizationId:orgA.id,name:'QA Dessert'}});
  const q = await db.freeDishQr.create({data:{organizationId:orgA.id,branchId:a.id,sectionId:section.id,itemId:item.id,name:'QA Offer',publicToken:crypto.randomBytes(32).toString('hex'),createdBy:owner.user.id}});
  const voucher = await db.freeDishSubmission.create({data:{organizationId:orgA.id,qrId:q.id,branchId:a.id,sectionId:section.id,fullName:'QA Guest',country:'GB',normalizedWhatsApp:'+447911123456',normalizedEmail:'qa-guest@example.invalid',dateOfBirth:new Date('1990-01-01'),voucherCode:'FD-ABCDE-FGHJK',itemName:item.name,quantity:1,branchName:a.name,sectionName:section.name}});
  const routes = [
    ['GET','/users','can_manage_users'],['GET','/acl/roles','can_manage_roles'],['GET','/free-dish/items','free_dish_manage'],['GET','/free-dish/submissions','free_dish_manage'],['POST','/free-dish/verify','free_dish_redeem'],['GET','/hr/catalog',['can_view_hr','can_view_payroll']],['GET','/payments','can_manage_payments']
  ];
  for (const [role, who] of Object.entries(identities)) {
    const me = await request('GET','/auth/me',undefined,who.token), perms=me.data.permissionMatrix.permissions;
    profiles.push({role,permissions:perms,moduleAccess:me.data.permissionMatrix.moduleAccess,roles:me.data.permissionMatrix.roles});
    for (const [method,route,required] of routes) {
      const allowed = [required].flat().some(p=>perms.includes(p));
      const r = await request(method,route,method==='POST'?{input:voucher.voucherCode}:undefined,who.token);
      matrix.push({role,method,route,expected:allowed?200:403,actual:r.status,pass:r.status===(allowed?200:403)});
    }
  }
  note('ROLE-MATRIX','14 seeded roles, 7 protected API operations', '98 matching allow/deny decisions', {checks:matrix.length,mismatches:matrix.filter(x=>!x.pass)},matrix.some(x=>!x.pass));
  const emptyLogin=await request('POST','/auth/login');
  note('LOGIN-EMPTY','Empty login returns validation error',400,emptyLogin.status,emptyLogin.status!==400);
  const anonymous=await request('GET','/users'); note('AUTH-CONTROL','Anonymous staff access',401,anonymous.status,anonymous.status!==401);
  const scoped = identities.store_keeper;
  // Branch-scoped documents: only synthetic sentinel content is written/deleted.
  const uploadRoot=path.join(backend,'uploads'), dir=path.join(uploadRoot,orgA.id), file=path.join(dir,'qa-audit-sentinel.pdf');
  if (!path.resolve(file).startsWith(path.resolve(uploadRoot)+path.sep)) throw new Error('Unsafe test file');
  fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(file,'%PDF-1.4\nQA AUDIT SENTINEL ONLY\n');
  try {
    const doc=await db.document.create({data:{organizationId:orgA.id,branchId:b.id,originalFilename:'qa-audit-sentinel.pdf',storedFilename:'qa-audit-sentinel.pdf',filePath:file,fileType:'application/pdf',fileSize:32,uploadedBy:owner.user.id}});
    const download=await request('GET',`/documents/${doc.id}/file`,undefined,scoped.token), list=await request('GET','/documents',undefined,scoped.token), metadata=await request('GET',`/documents/${doc.id}`,undefined,scoped.token), ocr=await request('POST',`/documents/${doc.id}/process-ocr`,{},scoped.token), remove=await request('DELETE',`/documents/${doc.id}`,undefined,scoped.token);
    note('DOC-01','Cross-branch document metadata, OCR and deletion bypass branch access','No restricted metadata/mutation; file remains',{download:download.status,listIncludesRestricted:list.data.data.some(d=>d.id===doc.id),metadata:metadata.status,pathExposed:!!metadata.data.filePath,ocr:ocr.status,delete:remove.status,rowRemaining:await db.document.count({where:{id:doc.id}}),fileRemaining:fs.existsSync(file)},download.status!==403||list.status!==200||list.data.data.some(d=>d.id===doc.id)||metadata.status!==403||ocr.status!==403||remove.status!==403||!fs.existsSync(file)||await db.document.count({where:{id:doc.id}})!==1,{fixture:{documentId:doc.id,allowedBranch:a.id,restrictedBranch:b.id}});

    // A real PDF keeps this test about authorization, not content validation.
    const uploadPdf=await new Promise(resolve=>{const PDF=require('pdfkit'),doc=new PDF(),chunks=[];doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.text('Synthetic authorization fixture');doc.end();});
    const uploadTo=async branchId=>{ const form=new FormData();form.set('branchId',branchId);form.set('file',new Blob([uploadPdf],{type:'application/pdf'}),'qa-only.pdf');const r=await fetch(base+'/documents/upload',{method:'POST',headers:{Authorization:'Bearer '+scoped.token},body:form});return {status:r.status,data:await r.json()}; };
    const beforeFiles=fs.readdirSync(dir).sort();
    const rejectedUpload=await uploadTo(b.id);
    note('DOC-UPLOAD-DENIED','Rejected uploads leave no file behind','403 and unchanged directory',{status:rejectedUpload.status},rejectedUpload.status!==403||JSON.stringify(fs.readdirSync(dir).sort())!==JSON.stringify(beforeFiles));
    const ownUpload=await uploadTo(a.id);
    const ownMetadata=await request('GET',`/documents/${ownUpload.data.id}`,undefined,scoped.token);
    const ownOcr=await request('POST',`/documents/${ownUpload.data.id}/process-ocr`,{},scoped.token);
    const ownFile=await request('GET',`/documents/${ownUpload.data.id}/file`,undefined,scoped.token);
    const ownDelete=await request('DELETE',`/documents/${ownUpload.data.id}`,undefined,scoped.token);
    note('DOC-OWN','Allowed document lifecycle and redacted metadata','201 upload, 200 reads/OCR/delete, no leaked paths',{upload:ownUpload.status,metadata:ownMetadata.status,ocr:ownOcr.status,file:ownFile.status,delete:ownDelete.status},ownUpload.status!==201||[ownMetadata,ownOcr,ownFile,ownDelete].some(r=>r.status!==200)||ownMetadata.data.filePath!==undefined||ownUpload.data.storedFilename!==undefined||JSON.stringify(fs.readdirSync(dir).sort())!==JSON.stringify(beforeFiles));

  } finally { if(fs.existsSync(file))fs.unlinkSync(file); if(fs.existsSync(dir)&&fs.readdirSync(dir).length===0)fs.rmdirSync(dir) }
  // Read isolation controls and financial report leak.
  const saleData=(branch,amount,no,date=new Date())=>({organizationId:orgA.id,branchId:branch.id,saleNo:no,saleDate:date,subtotal:amount,totalAmount:amount,netAmount:amount,cashAmount:amount,createdBy:owner.user.id});
  await db.dailySale.create({data:saleData(a,22,'QA-SALE-A')}); await db.dailySale.create({data:saleData(b,9012,'QA-SALE-B')});
  const salesDenied=await request('GET',`/sales?branchId=${b.id}`,undefined,viewer.token), report=await request('GET',`/reports/dashboard?branchId=${b.id}`,undefined,viewer.token), v2=await request('GET',`/reports/dashboard-v2?branchId=${b.id}`,undefined,viewer.token), financial=await request('GET',`/reports/financial?branchId=${b.id}`,undefined,viewer.token);
  note('REPORT-01','Branch-scoped users can read another branch financial reports',403,{salesControl:salesDenied.status,dashboard:report.status,restrictedSales:report.data.totalSalesToday,dashboardV2:v2.status,financial:financial.status},[salesDenied,report,v2,financial].some(r=>r.status!==403),{fixture:{allowedBranch:a.id,restrictedBranch:b.id}});
  // Authorization must reject all foreign-user references, even for owner of A.
  const before=await request('GET','/users',undefined,foreign.token), roles=await request('GET',`/acl/users/${foreign.user.id}/roles`,undefined,owner.token), assignment=await request('POST',`/acl/users/${foreign.user.id}/roles`,{roleId:owner.role.id},owner.token), after=await request('GET','/users',undefined,foreign.token);
  const access=await db.userBranchAccess.findFirstOrThrow({where:{userId:foreign.user.id}});
  const editAccess=await request('PUT',`/acl/users/${foreign.user.id}/branches/${access.id}`,{canApprove:true},owner.token), removeRole=await request('DELETE',`/acl/users/${foreign.user.id}/roles/${foreign.role.id}`,undefined,owner.token);
  note('ACL-01','Tenant A owner can read and change Tenant B roles/branch access','404/403, foreign user unchanged',{foreignRoleRead:roles.status,assignOwnerFromA:assignment.status,foreignProtectedReadBefore:before.status,foreignProtectedReadAfter:after.status,editForeignAccess:editAccess.status,deleteForeignRole:removeRole.status},[roles,assignment,editAccess,removeRole].some(r=>r.status!==404)||before.status!==403||after.status!==403,{fixture:{actorOrg:orgA.id,targetOrg:orgB.id,targetUser:foreign.user.id,accessId:access.id}});
  const cross=await request('POST','/users',{email:'qa-cross@example.invalid',firstName:'QA',lastName:'Cross',password:crypto.randomBytes(16).toString('hex'),roleIds:[foreign.role.id],branchIds:[foreignBranch.id]},owner.token);
  let relations=null;
  if(cross.data.id) { const roleLink=await db.userRole.findFirst({where:{userId:cross.data.id},include:{role:true}}), branchLink=await db.userBranchAccess.findFirst({where:{userId:cross.data.id},include:{branch:true}}); relations={userOrg:cross.data.organizationId,roleOrg:roleLink?.role.organizationId,accessOrg:branchLink?.organizationId,branchOrg:branchLink?.branch.organizationId} }
  note('USER-01','User creation accepts foreign-organization roles and branches','400/404; no cross-tenant relationships',{status:cross.status,relations},cross.status!==400||relations!==null);
  const brokenEmail='qa-invalid-role@example.invalid';
  const partial=await request('POST','/users',{email:brokenEmail,firstName:'QA',lastName:'Partial',password:crypto.randomBytes(16).toString('hex'),roleIds:['qa-nonexistent-role']},owner.token), orphan=await db.user.count({where:{organizationId:orgA.id,email:brokenEmail}});
  note('ATOMIC-01','Failed user creation persists a partial account','Validation error and zero created users',{status:partial.status,usersPersisted:orphan},partial.status!==400||orphan!==0);
  const custom=await db.role.create({data:{organizationId:orgA.id,name:'qa_atomic_role',displayName:'QA atomic role'}}), permission=await db.permission.findUniqueOrThrow({where:{key:'can_view_hr'}});
  await db.rolePermission.create({data:{roleId:custom.id,permissionId:permission.id}});
  const brokenPerm=await request('PUT',`/acl/roles/${custom.id}/permissions`,{permissionIds:['qa-nonexistent-permission']},owner.token), countPerm=await db.rolePermission.count({where:{roleId:custom.id}});
  note('ATOMIC-02','Failed permission update permanently clears existing grants','Validation error; original grant retained',{status:brokenPerm.status,grantsBefore:1,grantsAfter:countPerm},brokenPerm.status!==400||countPerm!==1);

  const ownAccess=await db.userBranchAccess.findFirstOrThrow({where:{userId:scoped.user.id}});
  const wrongParent=await request('PUT',`/acl/users/${owner.user.id}/branches/${ownAccess.id}`,{canApprove:true},owner.token);
  note('ACL-PARENT','Branch access ID must belong to the URL user',404,wrongParent.status,wrongParent.status!==404);
  const ownToken=jwt.signRefreshToken(scoped.user.id);
  await db.refreshToken.create({data:{token:ownToken,userId:scoped.user.id,expiresAt:new Date(Date.now()+3600000)}});
  const statuses=[];
  for(let i=0;i<2;i++) statuses.push(await request('PUT',`/orgs/${orgA.id}/users/${scoped.user.id}/status`,{isActive:false},owner.token));
  note('SESSION-DISABLE','Repeated disable is idempotent and revokes refresh sessions','Both disabled, zero tokens',{statuses:statuses.map(r=>r.status),active:statuses.map(r=>r.data.isActive),tokens:await db.refreshToken.count({where:{userId:scoped.user.id}})},statuses.some(r=>r.status!==200||r.data.isActive!==false)||await db.refreshToken.count({where:{userId:scoped.user.id}})!==0);
  await request('PUT',`/orgs/${orgA.id}/users/${scoped.user.id}/status`,{isActive:true},owner.token);
  const updateInvalid=await request('PUT',`/users/${viewer.user.id}`,{firstName:'Must Roll Back',roleIds:[foreign.role.id]},owner.token);
  const retained=await db.user.findUniqueOrThrow({where:{id:viewer.user.id},include:{roles:true}});
  note('ATOMIC-UPDATE','Invalid role changes preserve account and grants','400, original name and role',{status:updateInvalid.status,name:retained.firstName,roles:retained.roles.map(r=>r.roleId)},updateInvalid.status!==400||retained.firstName!==viewer.user.firstName||retained.roles.length!==1||retained.roles[0].roleId!==viewerRole.id);
  const cash=await db.account.create({data:{organizationId:orgA.id,code:'QA_CASH',name:'QA Cash',accountClass:'ASSET',normalBalance:'DEBIT'}});
  const income=await db.account.create({data:{organizationId:orgA.id,code:'QA_INCOME',name:'QA Income',accountClass:'REVENUE',normalBalance:'CREDIT'}});
  for(const [location,amount,no] of [[a,22,'QA-LEDGER-A'],[b,9012,'QA-LEDGER-B']]) await db.journalEntry.create({data:{organizationId:orgA.id,branchId:location.id,entryNo:no,entryDate:new Date(),description:no,status:'posted',createdBy:owner.user.id,lines:{create:[{accountId:cash.id,debitAmount:amount},{accountId:income.id,creditAmount:amount}]}}});
  const reportPaths=['dashboard','dashboard-v2','financial','inventory-health','sales','general-ledger','daily-sales','branch-sales','branch-profit','cash-closing','expenses','purchases','supplier-payable','inventory-stock','food-cost','wastage','audit-log','profit-loss','balance-sheet','cash-flow','trial-balance','vat-summary'];
  const reportChecks=[];
  for(const reportPath of reportPaths) {
    const [own,other]=await Promise.all([request('GET','/reports/'+reportPath,undefined,viewer.token),request('GET','/reports/'+reportPath+'?branchId='+b.id,undefined,viewer.token)]);
    reportChecks.push({path:reportPath,own:own.status,other:other.status,leaked:own.raw.includes('QA-LEDGER-B')||own.raw.includes('QA-SALE-B')||own.raw.includes('QA Restricted Branch')});
  }
  note('REPORT-CATALOG','All 22 report routes enforce implicit and explicit scope','Own scope 200 (audit log 403), other scope 403',reportChecks,reportChecks.some(r=>r.own!==(r.path==='audit-log'?403:200)||r.other!==403||r.leaked));
  const {reportReadScope}=require(path.join(backend,'dist/utils/reportReadScope'));
  const {netByAccount}=require(path.join(backend,'dist/services/financialStatements'));
  const [limited,complete]=await Promise.all([reportReadScope.run({organizationId:orgA.id,branchIds:[a.id]},()=>netByAccount(orgA.id,{})),reportReadScope.run({organizationId:orgA.id},()=>netByAccount(orgA.id,{}))]);
  note('REPORT-LEDGER','Concurrent financial helper scopes remain isolated','22 scoped versus 9034 whole organization',{limited:limited.get(cash.id)?.debit,complete:complete.get(cash.id)?.debit},limited.get(cash.id)?.debit!==22||complete.get(cash.id)?.debit!==9034);

  const sameEmail='qa-shared-login@example.invalid', otherPassword=crypto.randomBytes(16).toString('hex');
  await db.user.create({data:{organizationId:orgA.id,email:sameEmail,firstName:'QA',lastName:'LoginA',passwordHash:hash}});
  await db.user.create({data:{organizationId:orgB.id,email:sameEmail,firstName:'QA',lastName:'LoginB',passwordHash:await bcrypt.hash(otherPassword,4)}});
  const duplicateAttempts=[];
  for(let i=0;i<1;i++) {
    for(const [label,pw] of [['A',password],['A',password],['A',password],['B',otherPassword],['B',otherPassword],['B',otherPassword]]) {
      const r=await request('POST','/auth/login',{email:sameEmail,password:pw,organizationId:label==='A'?orgA.id:orgB.id});
      duplicateAttempts.push({account:label,status:r.status,correctOrganization:r.status===200?r.data.user.organizationId===(label==='A'?orgA.id:orgB.id):null});
    }
  }
  note('LOGIN-01','Valid per-tenant duplicate email authenticates nondeterministically','Every valid attempt selects its intended organization',{attempts:duplicateAttempts},duplicateAttempts.some(r=>r.status!==200||r.correctOrganization===false));
  const disabled=identities.accountant;
  await db.user.update({where:{id:disabled.user.id},data:{isActive:false}});
  const inactive=await request('GET','/reports/dashboard',undefined,disabled.token), refresh=jwt.signRefreshToken(disabled.user.id);
  await db.refreshToken.create({data:{token:refresh,userId:disabled.user.id,expiresAt:new Date(Date.now()+3600000)}});
  const inactiveRefresh=await request('POST','/auth/refresh',{refreshToken:refresh}), activeGuard=await request('GET','/free-dish/sections',undefined,disabled.token);
  await db.organization.update({where:{id:orgA.id},data:{isActive:false}});
  const orgLogin=await request('POST','/auth/login',{email:owner.user.email,password});
  await db.organization.update({where:{id:orgA.id},data:{isActive:true}});
  note('SESSION-01','Disabled users and organizations retain ordinary session access','401 and no renewed credentials',{disabledReport:inactive.status,disabledRefresh:inactiveRefresh.status,freeDishActiveGuard:activeGuard.status,disabledOrganizationLogin:orgLogin.status},[inactive,inactiveRefresh,activeGuard,orgLogin].some(r=>r.status!==401));

  const implicit=await request('GET','/reports/dashboard',undefined,viewer.token);
  const catalog=await request('GET','/reports/daily-sales',undefined,viewer.token);
  const exported=await request('GET','/reports/daily-sales?format=csv',undefined,viewer.token);
  note('REPORT-IMPLICIT','Implicit report and CSV branch scope','Only allowed branch data',{dashboard:implicit.status,branches:implicit.data.branchPerformance?.map(b=>b.branchId),catalog:catalog.status,csv:exported.status},implicit.status!==200||catalog.status!==200||exported.status!==200||JSON.stringify(implicit.data).includes(b.id)||JSON.stringify(catalog.data).includes('QA-SALE-B')||exported.raw.includes('QA-SALE-B'));
  const ambiguous=await request('POST','/auth/login',{email:sameEmail,password});
  note('LOGIN-CONTEXT','Duplicate email requires explicit organization',409,ambiguous.status,ambiguous.status!==409);
  const rotation=jwt.signRefreshToken(owner.user.id);
  await db.refreshToken.create({data:{token:rotation,userId:owner.user.id,expiresAt:new Date(Date.now()+3600000)}});
  const rotated=await Promise.all([request('POST','/auth/refresh',{refreshToken:rotation}),request('POST','/auth/refresh',{refreshToken:rotation})]);
  note('SESSION-REPLAY','Concurrent refresh has one winner','200 and 401',rotated.map(r=>r.status).sort(),rotated.filter(r=>r.status===200).length!==1||rotated.filter(r=>r.status===401).length!==1);

  await db.authAttemptBucket.deleteMany(); const attempts=[]; for(let i=0;i<32;i++) attempts.push((await request('POST','/auth/login',{email:owner.user.email,password:'qa-wrong-password'})).status);
  note('LOGIN-02','Password login has no throttling on repeated failed attempts','Bounded rate limit or lockout',{attempts:attempts.length,statusCounts:attempts.reduce((m,s)=>(m[s]=(m[s]||0)+1,m),{})},!attempts.includes(429)||attempts.some(s=>![401,429].includes(s)),{scope:'32 local attempts; shared buckets must reject attempts beyond the configured default of 30'});
  await db.account.create({data:{organizationId:orgA.id,code:'QA_FORMULA',name:'=1+1',description:'QA harmless spreadsheet-formula marker',accountClass:'ASSET',normalBalance:'DEBIT'}});
  const csv=await request('GET','/accounts/export/csv',undefined,owner.token);
  fs.writeFileSync(path.join(outputDir,'account-export.csv'),csv.raw);
  note('EXPORT-01','CSV account export emits unescaped spreadsheet formula values','Formula-leading text neutralized',{status:csv.status,containsRawFormulaCell:/(?:,|^)"?=1\+1"?(?:,|\r?\n|$)/m.test(csv.raw)},/(?:,|^)"?=1\+1"?(?:,|\r?\n|$)/m.test(csv.raw),{scope:'Harmless =1+1 payload; spreadsheet execution not exercised'});
  // A different business day must not be replaced with the Node host calendar.
  const hostDay=[new Date().getFullYear(),String(new Date().getMonth()+1).padStart(2,'0'),String(new Date().getDate()).padStart(2,'0')].join('-');
  const dayIn=z=>new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const zone=['Pacific/Kiritimati','Etc/GMT+12'].find(z=>dayIn(z)!==hostDay), day=dayIn(zone);
  const tzOrg=await db.organization.create({data:{name:'QA Timezone',timezone:zone}}), tzRole=await db.role.create({data:{organizationId:tzOrg.id,name:'owner',displayName:'QA owner'}}), tzBranch=await db.branch.create({data:{organizationId:tzOrg.id,name:'QA Timezone Branch',code:'TZ'}});
  const tzUser=await db.user.create({data:{organizationId:tzOrg.id,email:'qa-timezone@example.invalid',firstName:'QA',lastName:'Time',passwordHash:hash}}); await db.userRole.create({data:{roleId:tzRole.id,userId:tzUser.id}});
  await db.dailySale.create({data:{...saleData(tzBranch,321,'QA-TIMEZONE',new Date(day+'T00:00:00Z')),organizationId:tzOrg.id,createdBy:tzUser.id}});
  const tzReport=await request('GET','/reports/dashboard?branchId='+tzBranch.id,undefined,jwt.signAccessToken(tzUser.id,tzOrg.id,tzUser.email));
  note('DATE-01','Dashboard today ignores configured business timezone',321,{status:tzReport.status,businessTimezone:zone,businessDay:day,hostDay,totalSalesToday:tzReport.data.totalSalesToday},tzReport.status!==200||tzReport.data.totalSalesToday!==321);
  // Small, bounded local benchmark; no production load or invented SLO.
  const samples=[]; for(let i=0;i<20;i++){const t=performance.now();await request('GET','/free-dish/submissions',undefined,owner.token);samples.push(performance.now()-t)} samples.sort((a,b)=>a-b);
  note('PERF-SMOKE','Local registration-report response baseline','Measurement only; no agreed production SLO',{requests:samples.length,rows:1,p50Ms:+samples[9].toFixed(2),p95Ms:+samples[18].toFixed(2),maxMs:+samples[19].toFixed(2)},false,{scope:'Sequential, local, one issued voucher; not a load/scalability sign-off'});
})().catch(e=>{console.error('AUDIT PROBE ERROR',e.message);process.exitCode=2}).finally(async()=>{
  if(server)await new Promise(r=>server.close(r)); await appDb?.$disconnect(); await db.$disconnect();
  fs.writeFileSync(path.join(outputDir,'security-evidence.json'),JSON.stringify({evidence,matrix,profiles,confirmedDefects:evidence.filter(x=>x.result==='confirmed defect').length},null,2));
  if(!process.exitCode&&evidence.some(x=>x.result==='confirmed defect'))process.exitCode=1;
});
