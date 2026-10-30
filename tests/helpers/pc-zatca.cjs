// PC-side steps for branch-zatca.cjs. Runs as the branch PC: its own
// DATABASE_URL, ZATCA_ENCRYPTION_KEY and FOODSYNC_DEPLOYMENT_MODE=branch.
// ZATCA itself is stubbed; nothing leaves this machine except calls to the test cloud.
require('dotenv').config();
(async()=>{
 const input=JSON.parse(process.env.PC_INPUT);
 const {zatcaApi}=require('../../dist/services/zatca/api');
 zatcaApi.report=async()=>({status:200,ok:true,data:{reportingStatus:'REPORTED',validationResults:{status:'PASS',warningMessages:[]}},text:''});
 const {prisma}=require('../../dist/config'),{issueForOrder}=require('../../dist/services/zatca/index'),{unseal}=require('../../dist/services/zatca/crypto');
 const {publishBranchReplica}=require('../../dist/services/branchReplicaTransport');
 const devices=await prisma.zatcaDevice.findMany({orderBy:{counterCode:'asc'}});
 const unsealed=devices.every(d=>unseal(d.privateKeySealed).includes('PRIVATE KEY')&&unseal(d.productionSecretSealed).length>0);
 // Three counters sell at the same moment.
 const orders=await Promise.all(input.counters.map((counterCode,i)=>prisma.customerOrder.create({data:{organizationId:input.org,branchId:input.branch,orderNo:9000+i,orderType:'takeaway',status:'completed',closedAt:new Date(),counterCode,paymentMethod:'cash',subtotal:20,vatRate:15,vatAmount:3,totalAmount:23,items:{create:{dishId:input.dish,dishName:'Meal',unitPrice:23,quantity:1,lineTotal:23}}}})));
 const docs=await Promise.all(orders.map(o=>issueForOrder(o.id,'invoice')));
 // Refund of a sale invoiced in the cloud before the PC took over.
 await prisma.customerOrder.update({where:{id:input.creditOrderId},data:{status:'refunded'}});
 const credit=await issueForOrder(input.creditOrderId,'credit','Customer refund');
 await new Promise(r=>setTimeout(r,1500));// background reporting
 // One invoice stays unreported, as if ZATCA had been unreachable.
 await prisma.zatcaDocument.update({where:{id:docs[2].id},data:{status:'failed'}});
 const synced=await publishBranchReplica();
 const runtimeAfter=await prisma.branchRuntime.findUnique({where:{id:'local'}});if(!synced)console.error('SYNC-DIAG',JSON.stringify({replicaError:runtimeAfter.replicaError,chain:runtimeAfter.replicaChainError,dataRevision:String(runtimeAfter.dataRevision),last:String(runtimeAfter.lastReplicaRevision),log:await prisma.branchChangeLog.count()}));
 const after=await prisma.zatcaDocument.findMany({where:{id:{in:[...docs.map(d=>d.id),credit.id]}}});
 console.log(JSON.stringify({unsealed,devices:devices.map(d=>({id:d.id,counterCode:d.counterCode})),docs:docs.map(d=>({id:d.id,deviceId:d.deviceId,icv:d.icv,previousHash:d.previousHash,hash:d.hash,qr:!!d.qr})),credit:{id:credit.id,deviceId:credit.deviceId,icv:credit.icv,previousHash:credit.previousHash,hash:credit.hash},statuses:Object.fromEntries(after.map(d=>[d.id,d.status])),synced}));
 await prisma.$disconnect();
})().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
