const http=require('node:http');
(async()=>{
 const input=JSON.parse(process.env.WALLET_TEST_INPUT),{prisma}=require('../../dist/config'),wallet=require('../../dist/services/branchWallets');
 const req={user:{id:input.actorId,organizationId:input.organizationId}};
 try{
  if(input.action==='flush'){const result=await wallet.flushBranchWallets();console.log(JSON.stringify({result,receipts:await prisma.branchWalletReceipt.findMany()}));return}
  if(input.action==='earn'){
   await prisma.$transaction(tx=>require('../../dist/services/tenders').earnLoyalty(tx,req,input.order,input.lines));console.log(JSON.stringify({ok:true}));return
  }
  if(input.action==='refund'){
   await prisma.$transaction(async tx=>{const tenders=require('../../dist/services/tenders');await tenders.creditTenders(tx,req,input.organizationId,input.order.id);await tenders.reverseLoyaltyEarn(tx,req,input.organizationId,input.order.id)});console.log(JSON.stringify({ok:true}));return
  }
  if(input.action==='http'){
   // Any branch-PC API call through the real routes, policy and permissions.
   const app=require('../../dist/app').default,{signAccessToken}=require('../../dist/utils/jwt'),user=await prisma.user.findUnique({where:{id:input.actorId}});
   const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});
   try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1${input.route}`,{method:input.method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+signAccessToken(user.id,user.organizationId,user.email)},...(input.body!==undefined&&{body:JSON.stringify(input.body)})});console.log(JSON.stringify({status:r.status,body:await r.json().catch(()=>null)}));return}finally{await new Promise(r=>server.close(r))}
  }
  if(input.action==='complete'){
   const app=require('../../dist/app').default,{signAccessToken}=require('../../dist/utils/jwt'),user=await prisma.user.findUnique({where:{id:input.actorId}});
   const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});
   try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/orders/${input.order.id}/complete`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+signAccessToken(user.id,user.organizationId,user.email)},body:JSON.stringify({paymentMethod:input.lines[0].method,giftCardCode:input.lines[0].giftCardCode,discountAmount:0,customerId:input.order.customerId})});console.log(JSON.stringify({status:r.status,body:await r.json()}));return}finally{await new Promise(r=>server.close(r))}
  }
  const result=await prisma.$transaction(async tx=>{
   await wallet.debitBranchWallet(tx,req,input.order,input.lines,input.order.id);
   if(input.action==='rollback')throw new Error('EXPECTED_ROLLBACK');
   return {ok:true};
  },{timeout:25000});console.log(JSON.stringify(result));
 }catch(e){console.log(JSON.stringify({error:e.code||e.message,status:e.statusCode||500}));if(input.expectError!==true)process.exitCode=1}
 finally{await prisma.$disconnect()}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
