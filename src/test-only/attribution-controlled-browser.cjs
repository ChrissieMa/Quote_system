// Bounded Owner-approved acceptance harness. No Production code/settings edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {CdpPipe,browserChildEnvironment} = require('../../dist/test-only/attribution-browser-fixture.js');
async function runControlledBrowser(options={}) {
const readonly=options.readonly===true;
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'lks-approved-live-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
 ...(options.visible?[]:['--headless=new']),'--disable-background-networking','--disable-component-update',
 '--disable-sync','--no-first-run','--no-default-browser-check',
 '--user-data-dir='+profile,'--remote-debugging-pipe','about:blank'
],{env:browserChildEnvironment(profile),stdio:['ignore','ignore','pipe','pipe','pipe']});
const exited = new Promise(r=>chrome.once('close',r));
const cdp = new CdpPipe(chrome.stdio[3],chrome.stdio[4],chrome);
const site='https://lksdisplaybox.online', api='https://quote.lksdisplaybox.online';
const sessions=new Map(), errors=[], results=[], requests=[], revocations=[], networkTimes=new Map(), documents=new Map();
const out=options.output||path.join(__dirname,'controlled-live-five-sources.json');
let context, parentForCleanup;
const command=(m,p={},s)=>cdp.send(m,p,s);
async function evaluate(s,expression){
 const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},s);
 if(r.exceptionDetails)throw Error('Synthetic browser expression failed');
 return r.result?.value;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(errors.length)throw Error(errors.join(';'));if(await fn())return;await delay(100);}throw Error(label);}
cdp.onEvent=m=>{
 if(m.method==='Network.requestWillBeSent')networkTimes.set(m.params.requestId,Math.floor(m.params.wallTime*1000));
 if(m.method==='Network.responseReceived'&&m.params.type==='Document'){
  const response=m.params.response,u=new URL(response.url);
  // A Cloudflare child iframe can return200 while the top document is403.
  // Keep the exact main-frame identity; never call that iframe an app success.
  if(u.origin===site)documents.set(m.sessionId+':'+m.params.frameId,{url:u.origin+u.pathname,status:response.status,fromDiskCache:response.fromDiskCache===true});
 }
 if(m.method==='Fetch.requestPaused') void (async()=>{
  const {requestId,request,resourceType}=m.params;const u=new URL(request.url);
  const info=sessions.get(m.sessionId);
  let allowed=request.method==='GET' && (u.origin===site || (u.origin==='https://www.googletagmanager.com'&&['/gtm.js','/gtag/js'].includes(u.pathname)));
  // Keep the site's normal browser security checks intact; never solve a CAPTCHA.
  if(u.origin==='https://challenges.cloudflare.com'||(u.origin===site&&u.pathname.startsWith('/cdn-cgi/challenge-platform/')))allowed=true;
  if(u.origin===api&&['/api/attribution/v1/handoffs','/api/attribution/v1/revoke'].includes(u.pathname)&&['OPTIONS','POST'].includes(request.method)){
   allowed=!readonly;
   if(allowed&&request.method==='POST'&&u.pathname.endsWith('/handoffs')){
    const body=JSON.parse(request.postData||'null');
    assert.ok(body&&body.contractVersion==='1.0.0');
    assert.ok(!/gclid|gbraid|wbraid|fbclid|utm_|@|phone|email/i.test(request.postData));
    const header=name=>Object.entries(request.headers).find(([k])=>k.toLowerCase()===name)?.[1];
    assert.equal(header('origin'),site);assert.equal(header('cookie'),undefined);assert.equal(header('authorization'),undefined);assert.equal(header('referer'),undefined);
    requests.push({caseId:info?.caseId,path:u.pathname,body});
   }
  }
  if(options.route){await options.route({requestId,request,resourceType,networkStartedAt:networkTimes.get(m.params.networkId),sessionId:m.sessionId,command});return;}
  // Block all external analytics/conversions, WhatsApp, forms and unrelated writes.
  await command(allowed?'Fetch.continueRequest':'Fetch.failRequest',allowed?{requestId}:{requestId,errorReason:'BlockedByClient'},m.sessionId);
 })().catch(e=>errors.push(e.message));
 if(m.method==='Network.responseReceived'&&m.params.response.url===api+'/api/attribution/v1/revoke')revocations.push({session:m.sessionId,status:m.params.response.status});
};
async function newPage(caseId,browserContextId){
 const {targetId}=await command('Target.createTarget',{url:'about:blank',browserContextId});
 const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
 sessions.set(sessionId,{caseId});
 await command('Page.enable',{},sessionId);await command('Network.enable',{},sessionId);
 await command('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},sessionId);
 await command('Page.addScriptToEvaluateOnNewDocument',{source:`document.addEventListener('click',e=>{const a=e.target?.closest?.('a[href]');if(!a)return;let u;try{u=new URL(a.href)}catch{return}if(['https://wa.me','https://api.whatsapp.com'].includes(u.origin))e.preventDefault();},true);`},sessionId);
 return {sessionId,browserContextId,targetId};
}
async function newCase(caseId){const {browserContextId}=await command('Target.createBrowserContext');context=browserContextId;return newPage(caseId,browserContextId);}
async function navigate(s,url,referrer){
 const p={url};if(referrer)p.referrer=referrer;
 const nav=await command('Page.navigate',p,s);assert.ok(!nav.errorText,'Normal HTTPS navigation failed');
 await until(()=>evaluate(s,"document.readyState==='complete'"),'Public page did not finish loading');
 await until(()=>evaluate(s,"typeof window.lksAttributionBridgeV1==='object' && window.lksAttributionBridgeV1.enabled===true"),'Actual WordPress configuration missing');
}
async function click(s,selector){
 const b=await evaluate(s,`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 assert.ok(b,'Expected public control missing');
 await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...b},s);
 await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...b},s);
}
async function grant(s){
 await until(()=>evaluate(s,"Boolean(document.querySelector('#lksWpConsentAccept'))"),'Existing consent control not available');
 await click(s,'#lksWpConsentAccept');
}
async function codeFromCta(s){
 const selector='a[href^="https://wa.me/"],a[href^="https://api.whatsapp.com/"]';
 await until(()=>evaluate(s,`Boolean(document.querySelector(${JSON.stringify(selector)}))`),'Existing WhatsApp anchor missing');
 await click(s,selector);
 return evaluate(s,`(()=>{for(const a of document.querySelectorAll(${JSON.stringify(selector)})){const code=new URL(a.href).searchParams.get('text')?.match(/LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}/)?.[0];if(code)return code}return null})()`);
}
async function run(){
 if(!readonly&&!options.route)assert.ok(Date.now()<Date.parse('2026-11-27T11:41:27Z'),'Insufficient time remains in the approved window');
 const version=await command('Browser.getVersion');console.log(JSON.stringify({event:'LIVE_BROWSER_READY',product:version.product,normalTLS:!options.route,sandbox:true}));
 if(readonly){
  const p=await newCase('readonly_preflight');
  for(const pathname of ['/','/configurator/']){
   const navigationStarted=Date.now();
   const n=await command('Page.navigate',{url:site+pathname},p.sessionId);assert.ok(!n.errorText);
   const navigationMs=Date.now()-navigationStarted;
   await until(()=>evaluate(p.sessionId,"document.readyState==='complete'"),'Public read-only navigation incomplete');
   await delay(1000);
   let challenge=await evaluate(p.sessionId,"/just a moment|請稍候/i.test(document.title)||Boolean(document.querySelector('script[src*=\"challenge-platform\"]'))");
   const mainDocument=()=>documents.get(p.sessionId+':'+n.frameId);
   if(challenge&&options.onVerification){await options.onVerification({path:pathname,sessionId:p.sessionId,command,evaluate,navigationMs,document:mainDocument()});challenge=await evaluate(p.sessionId,"/just a moment|請稍候/i.test(document.title)");}
   const state={path:pathname,navigationMs,document:mainDocument(),...await evaluate(p.sessionId,"({title:document.title,canvas:document.querySelectorAll('canvas').length,configEnabled:window.lksAttributionBridgeV1?.enabled===true,scripts:[...document.querySelectorAll('script[src]')].map(e=>e.src).filter(x=>/index-|wordpress-bootstrap/.test(x))})")};
   if(options.onReadinessPage)await options.onReadinessPage(state,{sessionId:p.sessionId,command});
   assert.equal(challenge,false,'HUMAN_VERIFICATION_REQUIRED: '+pathname);
   assert.ok(pathname!=='/configurator/'||state.canvas>0,'Actual public 3D canvas missing');
   console.log(JSON.stringify({event:'READONLY_PUBLIC_SOURCE',...state}));
  }
  assert.equal(requests.length,0,'Read-only probe must not register any attribution');return {readonly:true,productionWrites:0};
 }
 const cases=[
  ['google_ads','/quote/?gclid=SyntheticApprovedGoogle12345678901234567890',null,'google_ads'],
  ['google_seo','/display-box/','https://www.google.com/','google_organic'],
  ['meta','/contact/?utm_source=instagram&utm_medium=paid_social&fbclid=SyntheticApprovedMeta12345678901234567890',null,'meta_ads'],
  ['direct','/',null,'direct'],
  ['threeD','/display-box/?gclid=SyntheticApprovedThreeD12345678901234567890',null,'google_ads']
 ];
 for(const [caseId,landing,referrer,expected] of cases){
  const p=await newCase(caseId);let s=p.sessionId;
  await navigate(s,site+landing,referrer);
  assert.equal(requests.filter(r=>r.caseId===caseId).length,0,'Pre-consent registration forbidden');
  const pre=await evaluate(s,"Object.keys(localStorage).filter(k=>/attribution/i.test(k)).length");assert.equal(pre,0);
  assert.equal(await evaluate(s,"[document.cookie,JSON.stringify({...localStorage}),JSON.stringify({...sessionStorage})].some(x=>x.includes('SyntheticApproved'))"),false,'No pre-consent advertising identifier persistence');
  await grant(s);
  await until(()=>Promise.resolve(requests.some(r=>r.caseId===caseId&&r.path.endsWith('/handoffs'))),'Actual browser handoff not sent');
  await until(()=>evaluate(s,"Object.keys(localStorage).some(k=>/handoff/.test(k))"),'Actual handoff response not persisted');
  await delay(200);
  const first=requests.filter(r=>r.caseId===caseId&&r.path.endsWith('/handoffs')).at(-1).body;
  assert.equal(first.firstTouch.channel,expected);
  let body=first;
  if(caseId==='threeD'){
   const before=requests.filter(r=>r.caseId===caseId&&r.path.endsWith('/handoffs')).length;
   // Keep the real Website tab alive so its own client can revoke its unused
   // parent receipt after the approved business-row cleanup, without exposing proof.
   parentForCleanup=p;
   s=(await newPage(caseId,p.browserContextId)).sessionId;
   const nav=await command('Page.navigate',{url:site+'/configurator/'},s);assert.ok(!nav.errorText,'3D navigation failed: '+nav.errorText);
   await until(()=>evaluate(s,"document.readyState==='complete'&&document.querySelectorAll('canvas').length>0"),'Actual 3D canvas missing',25000);
   await until(()=>Promise.resolve(requests.filter(r=>r.caseId===caseId&&r.path.endsWith('/handoffs')).length>before),'3D live registration missing');
   await delay(200);body=requests.filter(r=>r.caseId===caseId&&r.path.endsWith('/handoffs')).at(-1).body;
   assert.equal(body.attributionId,first.attributionId);assert.equal(body.firstTouch.channel,'google_ads');
   assert.equal(body.firstTouch.landingPath,'/display-box/');assert.equal(body.entrySurface,'configurator');
  }
  const code=await codeFromCta(s);assert.match(code||'',/^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);
  if(caseId==='threeD')assert.equal(await evaluate(s,"window.dataLayer.filter(x=>x?.event==='lks_whatsapp_click_intent').length"),1,'3D must emit exactly one existing intent');
  results.push({caseId,attributionId:body.attributionId,shortCode:code,firstTouch:body.firstTouch,lastTouch:body.lastTouch,entrySurface:body.entrySurface,preConsentZeroPersistence:true,normalTLS:!options.route});
  fs.writeFileSync(out,JSON.stringify({recordedAt:new Date().toISOString(),source:options.source||'development-only',cases:results,complete:results.length===5,noMessagesSent:true,externalAnalyticsBlocked:true},null,2)+'\n');
  console.log(JSON.stringify({event:'LIVE_SOURCE_PASS',caseId,channel:body.firstTouch.channel,surface:body.entrySurface}));
  if(caseId!=='threeD'){await command('Target.disposeBrowserContext',{browserContextId:p.browserContextId});context=null;}
 }
 assert.equal(new Set(results.map(r=>r.attributionId)).size,5);assert.deepEqual(errors,[]);
 if(options.acceptance){await options.acceptance(results);}else {
 console.log('AWAITING_CONFIRMED_OWN_20_ROW_CLEANUP');
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Controlled cleanup handoff expired')),Math.max(1,Date.parse('2026-11-27T11:50:00Z')-Date.now()));
  let input='';process.stdin.setEncoding('utf8');process.stdin.resume();
  process.stdin.on('data',chunk=>{input+=chunk;if(input.includes('\n')){clearTimeout(timer);input.trim()==='cleanup-confirmed'?resolve():reject(Error('Unexpected cleanup acknowledgement'));process.stdin.pause();}});
 });
 }
 await evaluate(parentForCleanup.sessionId,"window.dataLayer.push({event:'wpconsent_consent_processed',wpconsentPreferences:{essential:true,marketing:false,statistics:false}});true");
 await until(()=>Promise.resolve(revocations.some(r=>r.session===parentForCleanup.sessionId&&r.status===204)),'Unused parent synthetic receipt revocation not acknowledged');
 const receipt=JSON.parse(fs.readFileSync(out));receipt.unusedParentReceiptRevoked=true;fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n');
 console.log('UNUSED_PARENT_SYNTHETIC_RECEIPT_REVOKED');return {cases:results,unusedParentReceiptRevoked:true};
}
return run().finally(async()=>{
 if(chrome.exitCode===null)await command('Browser.close').catch(()=>chrome.kill('SIGTERM'));
 await exited;fs.rmSync(profile,{recursive:true,force:true});
});

}
module.exports={runControlledBrowser};
if(require.main===module)runControlledBrowser({readonly:process.argv.includes('--readonly-preflight')}).catch(e=>{console.error('CONTROLLED_LIVE_BROWSER_STOP',e.message);process.exitCode=1;});
