// Test-only API process. No sync timers; all commands use scratch databases.
const app=require('../../dist/app').default;
const server=app.listen(0,'127.0.0.1',()=>console.log('QA_SERVER_PORT='+server.address().port));
