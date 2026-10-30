// The fiscal/provider secrets are deliberately absent from the PC process.
(async()=>{
 const {prisma}=require('../../dist/config'),{executeBranchCommand}=require('../../dist/services/branchOnline');
 const input=JSON.parse(process.env.PAYMENT_TEST_INPUT);
 try{
  if(input.refund){
   if(input.performRefund){
    const app=require('../../dist/app').default,{signAccessToken}=require('../../dist/utils/jwt');
    const user=await prisma.user.findFirst({where:{isActive:true}}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s))});
    try{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/orders/${input.refund}/refund`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+signAccessToken(user.id,user.organizationId,user.email)},body:JSON.stringify({reason:'QA branch refund'})});if(!response.ok)throw new Error('Branch refund failed: '+await response.text())}finally{await new Promise(r=>server.close(r))}
    await require('../../dist/services/branchReplicaTransport').publishBranchReplica();
   }
   await require('../../dist/services/branchPayments').flushBranchRefunds();console.log(JSON.stringify(await prisma.paymentIntent.findUnique({where:{id:input.intentId}})));return
  }
  const outcome=await executeBranchCommand(input.command,input.branchId);
  if(input.sync)await require('../../dist/services/branchReplicaTransport').publishBranchReplica();
  const order=await prisma.customerOrder.findUnique({where:{id:input.command.payload.orderId}}),count=await prisma.tillPayment.count({where:{orderId:input.command.payload.orderId}});
  console.log(JSON.stringify({outcome,order,count,intents:await prisma.paymentIntent.count()}));
 }finally{await prisma.$disconnect()}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
