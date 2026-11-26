import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { LocalAttributionStore } from './attribution-store';
import { AttributionProjector } from './attribution-projection';
import { createAttributionBusinessHooks } from './attribution-business';
import { SerializedAirtableProjectionTransport, projectionSdkOptions } from './attribution-airtable';
import { SyntheticAttributionAcceptance, AcceptancePlan, ACCEPTANCE_CASES, validateAcceptancePlan } from './attribution-synthetic-acceptance';
import { createSyntheticAcceptanceRouter } from './attribution-synthetic-router';
import { actualSdkFixture } from './test-only/attribution-sdk-fixture';
import { nextBusinessNumber } from './attribution-numbering-isolation';
import { calculateOwnerFinanceSummary } from './owner-finance';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const fixed=Date.parse('2026-11-26T04:00:00Z');
function fixture(file=':memory:') {
 const f=actualSdkFixture(),errors:string[]=[];let now=fixed;
 const store=new LocalAttributionStore(file,Buffer.alloc(32,8));
 const transport=new SerializedAirtableProjectionTransport(store,f.table,true,projectionSdkOptions(f.mapping));
 const projector=new AttributionProjector(store,transport,f.mapping,e=>errors.push(e));
 const hooks=createAttributionBusinessHooks(store,()=>now,e=>errors.push(e));
 const engine=new SyntheticAttributionAcceptance({store,transport,projector,hooks,mapping:f.mapping,tables:f.table,now:()=>now});
 const codes:Record<string,string>={},ids:Record<string,string>={};
 for(const caseId of ACCEPTANCE_CASES){
  const channel=caseId==='google_seo'?'google_organic':caseId==='meta'?'meta_ads':caseId==='threeD'?'google_ads':caseId;
  const aid='aid_v1_'+digest(caseId).slice(0,32);ids[caseId]=aid;
  const touch={observedAt:new Date(now).toISOString(),channel,source:channel==='direct'?'(direct)':channel==='meta_ads'?'instagram':'google',medium:channel==='direct'?'(none)':channel==='google_organic'?'organic':channel==='meta_ads'?'paid_social':'cpc',campaignKey:null,landingPath:caseId==='threeD'?'/display-box/':'/',evidence:channel==='direct'?'direct_observed':channel==='google_organic'?'search_referrer':channel==='meta_ads'?'paid_utm':'google_click_parameter',confidence:channel==='google_ads'?'signal_strong':'signal_limited'};
  const result=store.create({contractVersion:'1.0.0',attributionId:aid,requestId:'ar_v1_'+digest('request:'+caseId).slice(0,32),entrySurface:caseId==='threeD'?'configurator':'wordpress',firstTouch:touch,lastTouch:touch,consent:{ad_storage:'granted',analytics_storage:'granted',ad_user_data:'granted',ad_personalization:'granted'}},now);assert.equal(result.outcome,'created');if(result.outcome==='created')codes[caseId]=result.shortCode;
 }
 const plan:AcceptancePlan={schemaVersion:'attribution-synthetic-acceptance-v1',runId:'attrtest_'+digest('synthetic-public-run').slice(0,24),approvalReference:'OWNER-APPROVAL-SYNTHETIC_ONLY',notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+1800000).toISOString(),cleanupExpiresAt:new Date(now+2400000).toISOString(),allowCleanup:true,automationReview:'no_customer_actions_verified',attributionIds:ids as any,
  linkFields:{"inquiries":["Quote","Order","Monthly Performance","Quotes","Order_2026","Customer","First Attribution","Latest Attribution"],"quotes":["Customer","Inquiries","Monthly Performance","Inquiry","Performance Month","Attribution Snapshot"],"orders":["Customer","Order Items","Deliveries","Inquiries","Marketing Spend","Inquiry","Performance Month","Attribution Snapshot"],"attributions":["First Campaign","Last Campaign","Inquiries First Attribution","Inquiries Latest Attribution","Quotes Attribution Snapshot","Orders Attribution Snapshot"]}};
 return {f,store,transport,projector,hooks,engine,codes,plan,errors,input:{contractVersion:'1.0.0',codes},setNow:(n:number)=>{now=n;}};
}

test('five real-SDK synthetic triples exercise actual hooks, survive replay and clean only own IDs',async()=>{
 const x=fixture();try{
  const outside='rec'+digest('outside').slice(0,14);x.f.seed(x.f.mapping.tables.orders,outside,{Notes:'unrelated synthetic sentinel','Product Amount':999});
  const result=await x.engine.run(x.plan,x.input);assert.deepEqual(result,{outcome:'accepted',cases:5,syntheticBusinessRecords:15,syntheticAttributions:5,cleanupComplete:false});
  const writes=x.f.calls.filter(c=>c.method==='post').length;assert.deepEqual(await x.engine.run(x.plan,x.input),result);assert.equal(x.f.calls.filter(c=>c.method==='post').length,writes);
  for(const c of x.f.calls.filter(c=>c.method==='post'&&c.path.includes(x.f.mapping.tables.quotes))){for(const row of c.data.records){assert.equal(row.fields.Total,0);assert.ok(!('Quote Number'in row.fields));assert.ok(!('Public Token'in row.fields));}}
  const cleanup=await x.engine.cleanup(x.plan);assert.equal(cleanup.cleanupComplete,true);assert.equal(cleanup.cases,5);
  assert.deepEqual(x.f.read(x.f.mapping.tables.orders,outside),{Notes:'unrelated synthetic sentinel','Product Amount':999});
  assert.equal([...x.f.rows.values()].reduce((n,t)=>n+t.size,0),1);
  for(const code of Object.values(x.codes))assert.equal(x.store.resolve(code,fixed),null);
  assert.ok(x.store.acceptanceJournal(x.plan.runId),'History is retained, not reset');assert.deepEqual(x.errors,[]);
 }finally{x.store.close();}
});

test('plan rejects expiry, longer windows, missing approval, cleanup scope and non-distinct IDs before network',()=>{
 const x=fixture();try{for(const patch of [{expiresAt:new Date(fixed-1).toISOString()},{expiresAt:new Date(fixed+7200000).toISOString()},{approvalReference:''},{allowCleanup:false},{automationReview:'unknown'},{attributionIds:{...x.plan.attributionIds,meta:x.plan.attributionIds.direct}}])assert.throws(()=>validateAcceptancePlan({...x.plan,...patch},fixed));assert.equal(x.f.calls.length,0);}finally{x.store.close();}
});

test('unknown, missing, cross-case and real-code substitutions create no business records',async()=>{
 const x=fixture();try{for(const patch of [{codes:{...x.codes,direct:'LKS-1111111111111111'}},{codes:{...x.codes,meta:x.codes.direct}},{codes:{...x.codes,google_ads:''}},{codes:{...x.codes},tableId:'arbitrary'}])await assert.rejects(()=>x.engine.run(x.plan,{...x.input,...patch}));assert.equal(x.f.calls.length,0);}finally{x.store.close();}
});

test('cleanup rejects changed marker, money, actual business number and outside links before deleting anything',async()=>{
 for(const mutate of ['marker','money','number','link']){const x=fixture();try{
  await x.engine.run(x.plan,x.input);const table=x.f.rows.get(x.f.mapping.tables.quotes)!;const [id,fields]=[...table][0];
  if(mutate==='marker')fields.Notes='changed';if(mutate==='money')fields.Total=12;if(mutate==='number')fields['Quote Number']='QT-2026-0042';if(mutate==='link')fields.Inquiry=['rec'+digest('not-owned').slice(0,14)];table.set(id,fields);
  await assert.rejects(()=>x.engine.cleanup(x.plan));assert.equal(x.f.calls.filter(c=>c.method==='delete').length,0);
 }finally{x.store.close();}}
});

test('unknown create acknowledgement halts and never blindly creates a second batch',async()=>{
 const x=fixture();let calls=0;const table=x.f.table;const engine=new SyntheticAttributionAcceptance({store:x.store,transport:x.transport,projector:x.projector,hooks:x.hooks,mapping:x.f.mapping,now:()=>fixed,tables:name=>{const t=table(name);return{...t,create:async(rows:any)=>{calls++;await t.create(rows);throw Error('synthetic lost acknowledgement');}} as any;}});
 try{await assert.rejects(()=>engine.run(x.plan,x.input));await assert.rejects(()=>engine.run(x.plan,x.input));assert.equal(calls,1);assert.ok(x.store.acceptanceJournal(x.plan.runId)?.includes('creating_inquiries'));assert.throws(()=>x.store.acquireProjectionWriter());}finally{x.store.close();}
});

test('journal and accepted run survive a process/store reopen without creating more data',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'lks-safe-acceptance-'))),file=join(dir,'test.sqlite');const x=fixture(file);
 try{await x.engine.run(x.plan,x.input);const writes=x.f.calls.filter(c=>c.method==='post').length;x.store.close();const store=new LocalAttributionStore(file,Buffer.alloc(32,8));try{const transport=new SerializedAirtableProjectionTransport(store,x.f.table,true,projectionSdkOptions(x.f.mapping));const projector=new AttributionProjector(store,transport,x.f.mapping,()=>{});const hooks=createAttributionBusinessHooks(store,()=>fixed,()=>{});const engine=new SyntheticAttributionAcceptance({store,transport,projector,hooks,mapping:x.f.mapping,tables:x.f.table,now:()=>fixed});assert.equal((await engine.run(x.plan,x.input)).cases,5);assert.equal(x.f.calls.filter(c=>c.method==='post').length,writes);}finally{store.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});

test('blank synthetic rows cannot reset any of the four existing business number sequences',async()=>{
 const f=actualSdkFixture();for(const [field,prefix] of [['Quote Number','QT'],['Internal Order No','ORD'],['Invoice Number','INV'],['Receipt Number','RCPT']]){
  const table=field==='Quote Number'?f.mapping.tables.quotes:f.mapping.tables.orders;
  f.seed(table,'rec'+digest(field+':number').slice(0,14),{[field]:prefix+'-2026-0041'});f.seed(table,'rec'+digest(field+':blank').slice(0,14),{Notes:'LKS-ATTR-ACCEPTANCE:synthetic'});
  assert.equal(await nextBusinessNumber(f.table(table),field,prefix),prefix+'-2026-0042');
 }
 await assert.rejects(()=>nextBusinessNumber(f.table(f.mapping.tables.quotes),'arbitrary','QT'));
});

test('Owner-only router remains absent by default and rejects auth/CSRF before any data operation',async()=>{
 const x=fixture();let available=true;const app=express();const requireOwner:express.RequestHandler=(q,r,next)=>q.get('x-synthetic-owner')==='yes'?next():r.sendStatus(401);const csrf:express.RequestHandler=(q,r,next)=>q.get('x-synthetic-csrf')==='yes'?next():r.sendStatus(403);
 app.use(createSyntheticAcceptanceRouter({enabled:true,engine:x.engine,requireOwner,requireOwnerOriginAndCsrf:csrf,plan:()=>available?x.plan:null,formToken:()=> 'PUBLIC_SYNTHETIC_NOT_SECRET'}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const origin='http://127.0.0.1:'+(server.address() as any).port;const url=origin+'/admin/attribution/v1/acceptance/run';
 try{assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal((await fetch(url,{method:'POST',headers:{'x-synthetic-owner':'yes'}})).status,403);available=false;assert.equal((await fetch(url,{method:'POST',headers:{'x-synthetic-owner':'yes','x-synthetic-csrf':'yes'}})).status,404);assert.equal(x.f.calls.length,0);}finally{await new Promise<void>(r=>server.close(()=>r()));x.store.close();}
});

test('probe route is absent when its separate gate is false and the full HTTP run/cleanup has no business payload input',async()=>{
 const x=fixture();const app=express();const allow:express.RequestHandler=(_q,_r,next)=>next();
 const off=express();off.use(createSyntheticAcceptanceRouter({enabled:false,engine:x.engine,requireOwner:allow,requireOwnerOriginAndCsrf:allow,plan:()=>x.plan,formToken:()=> 'PUBLIC_SYNTHETIC_NOT_SECRET'}));
 app.use('/off',off);app.use(createSyntheticAcceptanceRouter({enabled:true,engine:x.engine,requireOwner:allow,requireOwnerOriginAndCsrf:allow,plan:()=>x.plan,formToken:()=> 'PUBLIC_SYNTHETIC_NOT_SECRET'}));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));const origin='http://127.0.0.1:'+(server.address() as any).port;
 try{
  assert.equal((await fetch(origin+'/off/admin/attribution/v1/acceptance')).status,404);
  const url=origin+'/admin/attribution/v1/acceptance';const options=(body:unknown)=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let r=await fetch(url+'/run',options(x.input));assert.equal(r.status,200);assert.equal((await r.json() as any).cases,5);
  r=await fetch(url+'/cleanup',options({contractVersion:'1.0.0',ids:['not-accepted']}));assert.equal(r.status,422);assert.equal(x.f.calls.filter(c=>c.method==='delete').length,0);
  r=await fetch(url+'/cleanup',options({contractVersion:'1.0.0'}));assert.equal(r.status,200);assert.equal((await r.json() as any).cleanupComplete,true);
 }finally{await new Promise<void>(r=>server.close(()=>r()));x.store.close();}
});


test('actual Finance summary and the actual app month selector exclude all zero-value unnumbered probe Orders',async()=>{
 const x=fixture();try{
  await x.engine.run(x.plan,x.input);
  const source=readFileSync(require.resolve('./index.ts'),'utf8');const a=source.indexOf('const getOrderFinanceMonth = ');const b=source.indexOf('\nconst getOrderSequenceKey',a);assert.ok(a>0&&b>a);
  const fn=source.slice(a,b).replace('const getOrderFinanceMonth = ','').replace('(orderNo: unknown): string | null','(orderNo)').replace(/;\s*$/,'');
  const getMonth=vm.runInNewContext('('+fn+')',{MONTH_CODES:{JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'}}) as (x:unknown)=>string|null;
  const orders=[...x.f.rows.get(x.f.mapping.tables.orders)!].map(([id,fields])=>({id,fields}));
  for(let m=1;m<=12;m++){
   const report=calculateOwnerFinanceSummary({month:'2026-'+String(m).padStart(2,'0'),orders,marketing:[],expenses:[],getOrderMonth:f=>getMonth(f['Internal 1 Order No']),getDriverPayable:()=>0,getOutstandingFinanceStatus:()=>null});
   assert.equal(report.monthOrders.length,0);assert.equal(report.revenue,0);assert.equal(report.outstandingRevenue,0);assert.equal(report.netProfit,0);assert.equal(report.orderCosts,0);
  }
 }finally{x.store.close();}
});


test('already-bound business source and incomplete link inventory fail before synthetic writes',async()=>{
 const x=fixture();try{x.hooks.inquiry(x.codes.direct,'rec00000000000001');await assert.rejects(()=>x.engine.run(x.plan,x.input));assert.equal(x.f.calls.length,0);assert.throws(()=>validateAcceptancePlan({...x.plan,linkFields:{...x.plan.linkFields,orders:['Inquiry']}},fixed));}finally{x.store.close();}
});
