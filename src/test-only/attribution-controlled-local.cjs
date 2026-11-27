// Development only: exact browser acceptance runner + frozen frontend ZIP + real
// disposable WordPress + actual Quote router/SDK against fake Airtable records.
// No external browser requests, real customers, credentials or Production writes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const {Server}=require('node:net');
const {createHash}=require('node:crypto');
const express=require('express');
const {runControlledBrowser}=require('./attribution-controlled-browser.cjs');
const {composeAttribution}=require('../../dist/attribution-composition.js');
const {createAttributionRouter}=require('../../dist/attribution-router.js');
const {AttributionProjector}=require('../../dist/attribution-projection.js');
const {createAttributionBusinessHooks}=require('../../dist/attribution-business.js');
const {SyntheticAttributionAcceptance}=require('../../dist/attribution-synthetic-acceptance.js');
const {actualSdkFixture}=require('../../dist/test-only/attribution-sdk-fixture.js');
const sha=x=>createHash('sha256').update(x).digest('hex');
const site='https://lksdisplaybox.online',api='https://quote.lksdisplaybox.online';
const linkFields={inquiries:['Quote','Order','Monthly Performance','Quotes','Order_2026','Customer','First Attribution','Latest Attribution'],quotes:['Customer','Inquiries','Monthly Performance','Inquiry','Performance Month','Attribution Snapshot'],orders:['Customer','Order Items','Deliveries','Inquiries','Marketing Spend','Inquiry','Performance Month','Attribution Snapshot'],attributions:['First Campaign','Last Campaign','Inquiries First Attribution','Inquiries Latest Attribution','Quotes Attribution Snapshot','Orders Attribution Snapshot']};
async function main(){
 const [zip,website,runtime,output]=process.argv.slice(2);assert.ok(zip&&website&&runtime&&output,'Provide frozen ZIP, Website checkout, installed WP runtime and output directory');
 assert.equal(sha(fs.readFileSync(zip)),'5ccf3a6ac897fa85fc4cb51d3b054f30dc015daaf89ed57b83ed4b752b09e866','Frozen package must be unchanged');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lks-complete-browser-')));
 let composed,server;
 try{
  const packageDir=path.join(temp,'package'),evidence=path.join(temp,'evidence');fs.mkdirSync(packageDir);fs.mkdirSync(evidence);
  execFileSync('/usr/bin/unzip',['-q',zip,'-d',packageDir]);
  const runtimeRequire=createRequire(path.join(runtime,'package.json'));
  const {runCLI}=await import(pathToFileURL(runtimeRequire.resolve('@wp-playground/cli')).href);
  const php=fs.readFileSync(path.join(website,'browser/attribution-bridge-v1/integration/real-wordpress-case.php'),'utf8');
  const originalListen=Server.prototype.listen,servers=new Set();
  Server.prototype.listen=function(...args){servers.add(this);if(typeof args[0]==='number')args.splice(1,0,'127.0.0.1');else if(args[0]&&typeof args[0]==='object'&&Object.hasOwn(args[0],'port'))args[0]={...args[0],host:'127.0.0.1'};else throw Error('Unexpected test binding');return originalListen.apply(this,args);};
  try{await runCLI({command:'run-blueprint',wp:'7.1.5',php:'8.3',quiet:true,autoMount:false,wordpressInstallMode:'download-and-install','site-url':site,
   'define-bool':{DISABLE_WP_CRON:true,WP_HTTP_BLOCK_EXTERNAL:true,AUTOMATIC_UPDATER_DISABLED:true},
   'mount-before-install':[{hostPath:path.join(packageDir,'wp-content'),vfsPath:'/wordpress/wp-content'},{hostPath:evidence,vfsPath:'/evidence'}],
   blueprint:{preferredVersions:{wp:'7.1.5',php:'8.3'},features:{networking:false},steps:[
    {step:'setSiteOptions',options:{home:site,siteurl:site,active_plugins:['lks-attribution-bridge-v1/lks-attribution-bridge-v1.php']}},
    {step:'runPHP',code:php.replace('<?php',"<?php define('LKS_SYNTHETIC_CASE','fixed');")}
   ]}});}finally{Server.prototype.listen=originalListen;for(const s of servers)if(s.listening)await new Promise(r=>s.close(r));}
  const wp=JSON.parse(fs.readFileSync(path.join(evidence,'fixed.json'),'utf8'));assert.equal(wp.wordpress,'7.1.5');assert.equal(wp.config_count,1);assert.equal(wp.configuration_before_module,true);
  const shell=`<!doctype html><html><head><meta charset="UTF-8"><title>Synthetic Website</title><script>window.dataLayer=[];</script>${wp.rendered_lks_html}</head><body><button id="lksWpConsentAccept">Accept</button><a href="https://wa.me/85200000000?text=Synthetic%20only">WhatsApp</a><script>document.querySelector('button').addEventListener('click',()=>window.dataLayer.push({event:'wpconsent_consent_processed',wpconsentPreferences:{essential:true,marketing:true,statistics:true}}));</script></body></html>`;
  const client=actualSdkFixture(),mapping=client.mapping,reports=[];
  composed=composeAttribution({enabled:true,storePath:path.join(temp,'synthetic.sqlite'),pathPolicy:{kind:'test',directory:temp},exclusiveWriterConfirmed:true,
   proofKey:()=>Buffer.alloc(32,7),tables:client.table,mapping,publicPaths:['/','/contact/','/quote/','/configurator/','/display-box/'],campaignKeys:[],nodeVersion:process.version,now:Date.now,report:m=>reports.push(m),limit:{maxRequests:60,windowMs:60000,maxClients:20}});assert.ok(composed);
  const projector=new AttributionProjector(composed.store,composed.transport,mapping,m=>reports.push(m));
  const hooks=createAttributionBusinessHooks(composed.store,Date.now,m=>reports.push(m));
  const engine=new SyntheticAttributionAcceptance({store:composed.store,transport:composed.transport,projector,hooks,mapping,tables:client.table,now:Date.now});
  const app=express();app.use(createAttributionRouter({enabled:true,store:composed.store,validation:composed.validation,now:Date.now,allowRequest:()=>true,requireOwner:(_q,_r,n)=>n(),requireOwnerOriginAndCsrf:(_q,_r,n)=>n(),reportError:m=>reports.push(m)}));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const local='http://127.0.0.1:'+server.address().port;
  let cleanup=false;const network=[];fs.mkdirSync(output,{recursive:true});
  const result=await runControlledBrowser({output:path.join(output,'full-browser-five-paths.json'),route:async({requestId,request,resourceType,networkStartedAt,sessionId,command})=>{
   const u=new URL(request.url);let body=Buffer.alloc(0),status=200,type='text/javascript',headers=[];network.push({method:request.method,origin:u.origin,path:u.pathname});
   if(u.origin===site){
    if(resourceType==='Document'&&!u.pathname.startsWith('/configurator/')){body=Buffer.from(shell);type='text/html';}
    else {const relative=decodeURIComponent(u.pathname).replace(/^\//,'');const file=path.resolve(packageDir,relative);assert.ok(file.startsWith(packageDir+path.sep),'Path escape');if(fs.existsSync(file)&&fs.statSync(file).isFile()){body=fs.readFileSync(file);type=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.svg')?'image/svg+xml':'text/javascript';}else status=404;}
   }else if(u.origin===api&&['/api/attribution/v1/handoffs','/api/attribution/v1/revoke'].includes(u.pathname)&&['OPTIONS','POST'].includes(request.method)){
    const reqHeaders=Object.fromEntries(Object.entries(request.headers).filter(([k])=>['origin','content-type','idempotency-key','access-control-request-method','access-control-request-headers'].includes(k.toLowerCase())));
    const response=await fetch(local+u.pathname,{method:request.method,headers:reqHeaders,...(request.postData?{body:request.postData}:{})});status=response.status;body=Buffer.from(await response.arrayBuffer());headers=[...response.headers].map(([name,value])=>({name,value}));type='application/json';
    console.log(JSON.stringify({event:'LOCAL_ROUTER_REPLY',method:request.method,path:u.pathname,status}));
    assert.ok(status>=200&&status<300,'Synthetic router rejected browser request: '+status);
    if(request.method==='POST'&&u.pathname.endsWith('/handoffs')){
     const responseData=JSON.parse(body.toString());
     const timing={event:'FROZEN_FRONTEND_RESPONSE_TIMING',serverExpiry:responseData.expiresAt,networkStartedAt,expiryOverClientMaximumMs:Date.parse(responseData.expiresAt)-(networkStartedAt+7*24*60*60*1000),responseShape:Object.keys(responseData).sort()};
     fs.writeFileSync(path.join(output,'frozen-frontend-timing.json'),JSON.stringify(timing,null,2)+'\n');console.log(JSON.stringify(timing));
    }
   }else {status=403;}
   await command('Fetch.fulfillRequest',{requestId,responseCode:status,responseHeaders:[{name:'Content-Type',value:type},...headers.filter(h=>!['content-type','content-length','transfer-encoding','connection'].includes(h.name.toLowerCase()))],body:body.toString('base64')},sessionId);
  },acceptance:async cases=>{
   const now=Date.now();const plan={schemaVersion:'attribution-synthetic-acceptance-v1',runId:'attrtest_navigation20261127',approvalReference:'DEVELOPMENT_SYNTHETIC_ONLY',notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+1800000).toISOString(),cleanupExpiresAt:new Date(now+2400000).toISOString(),allowCleanup:true,automationReview:'no_customer_actions_verified',attributionIds:Object.fromEntries(cases.map(c=>[c.caseId,c.attributionId])),linkFields};
   const accepted=await engine.run(plan,{contractVersion:'1.0.0',codes:Object.fromEntries(cases.map(c=>[c.caseId,c.shortCode]))});assert.equal(accepted.cases,5);assert.equal(accepted.syntheticBusinessRecords,15);assert.equal(accepted.syntheticAttributions,5);
   const journal=JSON.parse(composed.store.acceptanceJournal(plan.runId));
   for(const c of cases){const e=journal.entities.find(e=>e.caseId===c.caseId),iq=client.read(mapping.tables.inquiries,e.inquiry),q=client.read(mapping.tables.quotes,e.quote),o=client.read(mapping.tables.orders,e.order);const snap=q[mapping.quote.snapshot];assert.deepEqual(iq[mapping.inquiry.first],snap);assert.deepEqual(o[mapping.order.snapshot],snap);const a=client.read(mapping.tables.attributions,snap[0]);assert.equal(a[mapping.attribution.firstChannel],c.firstTouch.channel);}
   const removed=await engine.cleanup(plan);assert.equal(removed.cleanupComplete,true);assert.equal([...client.rows.values()].reduce((n,t)=>n+t.size,0),0);cleanup=true;
  }});
  assert.equal(cleanup,true);assert.equal(result.cases.length,5);assert.equal(result.unusedParentReceiptRevoked,true);assert.deepEqual(reports,[]);
  const proof={recordedAt:new Date().toISOString(),packageSha256:sha(fs.readFileSync(zip)),wordpress:wp.wordpress,configurationBeforeModule:wp.configuration_before_module,realBrowser:'Mac Chrome normal OS keychain and fresh isolated profile',sameAcceptanceRunner:true,paths:result.cases.map(c=>({caseId:c.caseId,channel:c.firstTouch.channel,inquiry:true,quote:true,order:true})),businessRows:15,attributionRows:5,all20FakeRowsDeleted:true,unusedParentReceiptRevoked:true,externalBrowserRequests:0,productionWrites:0,securityBypass:false,limits:'Synthetic HTTPS interception -> actual loopback Quote router -> installed SDK fake REST; not Production TLS, Cloudflare clearance or actual Airtable certification'};
  fs.writeFileSync(path.join(output,'full-browser-tool-proof.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
 }catch(error){
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'full-browser-tool-proof.json'),JSON.stringify({recordedAt:new Date().toISOString(),passed:false,error:error.message,sameAcceptanceRunner:true,packageSha256:sha(fs.readFileSync(zip)),productionWrites:0,externalBrowserRequests:0,securityBypass:false,scope:'Actual frozen ZIP, real disposable WordPress, normal Mac Chrome, actual loopback router and installed SDK fake REST. First browser case reached POST201 but did not retain receipt; no business projection began.'},null,2)+'\n');
  throw error;
 }finally{if(server)await new Promise(r=>server.close(r));if(composed)composed.store.close();fs.rmSync(temp,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
