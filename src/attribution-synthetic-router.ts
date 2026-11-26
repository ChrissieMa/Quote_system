import express, { RequestHandler, Router } from 'express';
import { SyntheticAttributionAcceptance, AcceptancePlan, ACCEPTANCE_CASES } from './attribution-synthetic-acceptance';
const json=express.json({limit:'4kb',strict:true});
export const createSyntheticAcceptanceRouter = (options:{
 enabled:boolean;engine:SyntheticAttributionAcceptance;requireOwner:RequestHandler;requireOwnerOriginAndCsrf:RequestHandler;
 plan:(cleanup?:boolean)=>AcceptancePlan|null;formToken:()=>string;
}):Router=>{
 const router=Router();if(!options.enabled)return router;
 const base='/admin/attribution/v1/acceptance';
 const available=(cleanup=false):RequestHandler=>(_q,r,next)=>{const p=options.plan(cleanup);if(!p){r.sendStatus(404);return;}r.locals.acceptancePlan=p;next();};
 router.get(base,options.requireOwner,available(true),(_q,r)=>{
  const p=r.locals.acceptancePlan as AcceptancePlan;
  // The existing app CSRF value stays inside the Owner browser. No new secret/token mechanism.
  const token=JSON.stringify(options.formToken()).replace(/</g,'\\u003c');
  r.setHeader('Cache-Control','no-store');r.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  r.type('html').send(`<!doctype html><html lang="zh-HK"><meta charset="utf-8"><title>TEST 歸因驗收</title><h1>TEST 歸因驗收</h1><p>只限今次批准嘅五條假資料來源。唔會開正常單據或發訊息。</p>${ACCEPTANCE_CASES.map(c=>`<label>${c}<input id="${c}" maxlength="20" autocomplete="off"></label><br>`).join('')}<button id="run">驗證五條來源</button><button id="cleanup">清除今次測試資料</button><pre id="result">${JSON.stringify(options.engine.summary(p))}</pre><script>
const send=async(action,body)=>{const r=await fetch('${base}/'+action,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json','Accept':'application/json','X-CSRF-Token':${token}},body:JSON.stringify(body)});document.querySelector('#result').textContent=JSON.stringify(await r.json());};
document.querySelector('#run').onclick=()=>send('run',{contractVersion:'1.0.0',codes:Object.fromEntries(${JSON.stringify(ACCEPTANCE_CASES)}.map(c=>[c,document.getElementById(c).value]))});
document.querySelector('#cleanup').onclick=()=>send('cleanup',{contractVersion:'1.0.0'});
</script></html>`);
 });
 router.post(base+'/run',options.requireOwner,options.requireOwnerOriginAndCsrf,available(),json,async(q,r)=>{
  try{r.json(await options.engine.run(r.locals.acceptancePlan,q.body));}catch{r.status(409).json({outcome:'halted',message:'驗收已停止；保留現場，唔好重開測試。'});}
 });
 router.post(base+'/cleanup',options.requireOwner,options.requireOwnerOriginAndCsrf,available(true),json,async(q,r)=>{
  if(!q.body||Object.keys(q.body).join(',')!=='contractVersion'||q.body.contractVersion!=='1.0.0'){r.sendStatus(422);return;}
  try{r.json(await options.engine.cleanup(r.locals.acceptancePlan));}catch{r.status(409).json({outcome:'halted',message:'清理未確認；只保留今次測試資料，禁止擴大刪除。'});}
 });
 router.use(((error:any,_q:any,r:any,_next:any)=>{r.status(422).json({outcome:'invalid'});}) as express.ErrorRequestHandler);
 return router;
};
