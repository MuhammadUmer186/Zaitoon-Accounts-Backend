(async()=>{
 const {prisma}=require('../../dist/config'),input=JSON.parse(process.env.TRANSFER_TEST_INPUT);
 try{const result=await require('../../dist/services/branchOnline').executeBranchCommand(input.command,input.branchId);console.log(JSON.stringify(result))}finally{await prisma.$disconnect()}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1});
