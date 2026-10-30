// Creates and drops only uniquely named fs_qa_* databases on the configured server.
const path=require('node:path'),{execFileSync}=require('node:child_process');
const backend=path.resolve(__dirname,'..');
require(path.join(backend,'node_modules/dotenv')).config({path:path.join(backend,'.env')});
const {PrismaClient}=require(path.join(backend,'node_modules/@prisma/client'));
const cli=path.join(backend,'node_modules/prisma/build/index.js'),schema=path.join(backend,'prisma/schema.prisma');
// Additive SQL applied by the deployment entrypoint after the schema exists.
const additions=['20261026-auth-rate-limit.sql','20261026-branch-runtime.sql','20261026-branch-ownership.sql','20261026-branch-replica.sql','20261027-branch-sync-safety.sql','20261027-branch-media.sql','20261027-branch-payments.sql','20261027-branch-wallets.sql','20261027-branch-transfers.sql'];
let counter=0;
function urls(){
  const original=new URL(process.env.DATABASE_URL),admin=new URL(original);admin.pathname='/postgres';
  return {original,admin};
}
async function createScratch({apply=additions}={}){
  const {original,admin}=urls(),name=`fs_qa_${process.pid}_${Date.now()}${counter++}`;
  if(!/^fs_qa_\d+_\d+$/.test(name))throw new Error('Unsafe QA target');
  const target=new URL(original);target.pathname='/'+name;
  if(target.pathname===original.pathname)throw new Error('Unsafe QA target');
  const adminDb=new PrismaClient({datasources:{db:{url:admin.toString()}}});
  await adminDb.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const env={...process.env,DATABASE_URL:target.toString()};
  const run=args=>execFileSync(process.execPath,[cli,...args],{env,stdio:'pipe',cwd:backend});
  try{
    run(['db','push','--skip-generate','--schema',schema]);
    run(['db','execute','--file',path.join(backend,'prisma/post-push.sql'),'--schema',schema]);
    for(const file of apply)run(['db','execute','--file',path.join(backend,'prisma/additions',file),'--schema',schema]);
  }catch(error){await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await adminDb.$disconnect();throw error}
  return {name,url:target.toString(),
    applySql:file=>run(['db','execute','--file',path.isAbsolute(file)?file:path.join(backend,'prisma/additions',file),'--schema',schema]),
    client:()=>new PrismaClient({datasources:{db:{url:target.toString()}}}),
    drop:async()=>{await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await adminDb.$disconnect()}};
}
module.exports={createScratch,additions};
