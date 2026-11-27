const test=require('node:test');
const assert=require('node:assert/strict');
const {runControlledBrowser}=require('./attribution-controlled-browser.cjs');

test('a successful security iframe cannot turn a blocked top document into readiness',async()=>{
 let observed;let frameFulfilled=false;
 await assert.rejects(()=>runControlledBrowser({readonly:true,
  route:async({requestId,request,command,sessionId})=>{
   const main=new URL(request.url).origin==='https://lksdisplaybox.online';
   if(!main)frameFulfilled=true;
   const body=main?'<html><title>Just a moment...</title><iframe src="https://challenges.cloudflare.com/synthetic-readiness-only"></iframe></html>':'<html><title>Synthetic security frame</title></html>';
   await command('Fetch.fulfillRequest',{requestId,responseCode:main?403:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from(body).toString('base64')},sessionId);
  },onReadinessPage:state=>{observed=state;}
 }),/HUMAN_VERIFICATION_REQUIRED/);
 assert.equal(frameFulfilled,true);
 assert.equal(observed.document.status,403);
 assert.equal(observed.document.url,'https://lksdisplaybox.online/');
 assert.equal(observed.canvas,0);
});
