import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LocalAttributionStore } from './attribution-store';
import { AttributionProjector, AttributionProjectionMapping } from './attribution-projection';
import { createAttributionBusinessHooks } from './attribution-business';
import { SerializedAirtableProjectionTransport } from './attribution-airtable';
import { syntheticProjectionMapping } from './test-only/attribution-projection-fixture';
const SdkTable = require('airtable/lib/table');
const digest = (x: string) => createHash('sha256').update(x).digest('hex');
const id = (prefix: string, x: string) => prefix + digest(x).slice(0,14);

import { actualSdkFixture } from './test-only/attribution-sdk-fixture';

test('actual installed Airtable SDK field IDs, name-only formulas and empty-field omission preserve the full projection',async()=>{
 const f=actualSdkFixture();const errors:string[]=[];const now=Date.parse('2026-11-26T04:00:00Z');
 const store=new LocalAttributionStore(':memory:',Buffer.alloc(32,9));
 try{
  const options={readFields:{[f.mapping.tables.attributions]:Object.values(f.mapping.attribution),[f.mapping.tables.inquiries]:Object.values(f.mapping.inquiry),[f.mapping.tables.quotes]:Object.values(f.mapping.quote),[f.mapping.tables.orders]:Object.values(f.mapping.order)},lookupNames:{[f.mapping.attribution.code]:'Handoff Code'}};
  const transport=new (SerializedAirtableProjectionTransport as any)(store,f.table,true,options);
  const projector=new AttributionProjector(store,transport,f.mapping,e=>errors.push(e));
  const touch={observedAt:new Date(now).toISOString(),channel:'google_ads',source:'google',medium:'cpc',campaignKey:null,landingPath:'/',evidence:'google_click_parameter',confidence:'signal_strong'};
  const receipt=store.create({contractVersion:'1.0.0',requestId:'ar_v1_'+digest('sdk-request').slice(0,32),attributionId:'aid_v1_'+digest('sdk-journey').slice(0,32),firstTouch:touch,lastTouch:touch,entrySurface:'wordpress',consent:{ad_storage:'granted',analytics_storage:'granted',ad_user_data:'granted',ad_personalization:'granted'}},now);
  assert.equal(receipt.outcome,'created');if(receipt.outcome!=='created')throw Error('receipt');
  const iq=id('rec','inquiry'),q=id('rec','quote'),o=id('rec','order');f.seed(f.mapping.tables.inquiries,iq);f.seed(f.mapping.tables.quotes,q);f.seed(f.mapping.tables.orders,o);
  const hooks=createAttributionBusinessHooks(store,()=>now,e=>errors.push(e));hooks.inquiry(receipt.shortCode,iq);hooks.quote(receipt.shortCode,iq,q);hooks.order(q,o);
  const result=await projector.flush();assert.equal(result.failed,false,JSON.stringify(errors));assert.equal(result.completed,3);
  const pin=f.read(f.mapping.tables.quotes,q)![f.mapping.quote.snapshot];assert.deepEqual(f.read(f.mapping.tables.orders,o)![f.mapping.order.snapshot],pin);assert.deepEqual(f.read(f.mapping.tables.inquiries,iq)![f.mapping.inquiry.first],pin);
  assert.ok(f.calls.filter(c=>c.method==='get').every(c=>c.query.returnFieldsByFieldId===true&&Array.isArray(c.query.fields)));
  assert.ok(f.calls.filter(c=>c.method==='post'||c.method==='patch').every(c=>c.data.returnFieldsByFieldId===true));
  assert.ok(f.calls.every(c=>!c.path.split('/').filter(Boolean)[1]),'No direct record GET fallback across a base');
  assert.deepEqual(errors,[]);
 }finally{store.close();}
});
