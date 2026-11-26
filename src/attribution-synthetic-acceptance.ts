import { createHash } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, readFileSync, closeSync } from 'node:fs';
import { LocalAttributionStore, AttributionSnapshot } from './attribution-store';
import { AttributionBusinessHooks } from './attribution-business';
import { AttributionProjector, AttributionProjectionMapping } from './attribution-projection';
import { SerializedAirtableProjectionTransport } from './attribution-airtable';

export const ACCEPTANCE_PLAN_PATH = '/data/lks-attribution/acceptance.json';
export const ACCEPTANCE_CASES = ['google_ads','google_seo','meta','direct','threeD'] as const;
export type AcceptanceCase = typeof ACCEPTANCE_CASES[number];
type Role = 'inquiries'|'quotes'|'orders'|'attributions';
type Cell = string | number | string[];
type Row = {id:string;fields:Record<string,unknown>};
export type AcceptanceTable = {
  select(options:{filterByFormula:string;fields:string[];maxRecords:number;pageSize:number}):{firstPage():Promise<readonly Row[]>};
  create(rows:Array<{fields:Record<string,Cell>}>):Promise<readonly Row[]>;
  destroy(ids:string[]):Promise<readonly {id:string}[]>;
};
export type AcceptancePlan = {
  schemaVersion:'attribution-synthetic-acceptance-v1';runId:string;approvalReference:string;
  notBefore:string;expiresAt:string;cleanupExpiresAt:string;allowCleanup:true;automationReview:'no_customer_actions_verified';
  attributionIds:Record<AcceptanceCase,string>;
  linkFields:Record<Role,string[]>;
};
type Entity = {caseId:AcceptanceCase;code:string;attributionId:string;inquiry?:string;quote?:string;order?:string;attribution?:string};
export type AcceptanceResult = { outcome: string; cases: number; syntheticBusinessRecords: number; syntheticAttributions: number; cleanupComplete: boolean };
type Journal = {v:1;digest:string;phase:string;entities:Entity[];pending:Role|null;accepted:boolean;deleted:Role[]};
export type AcceptanceOptions = {
  store:LocalAttributionStore;mapping:AttributionProjectionMapping;transport:SerializedAirtableProjectionTransport;
  projector:AttributionProjector;hooks:AttributionBusinessHooks;tables:(name:string)=>AcceptanceTable;now:()=>number;
};
const exact=(x:unknown,keys:string[]):x is Record<string,unknown>=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x as object).sort().join(',')===[...keys].sort().join(',');
const iso=(x:unknown)=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x)?Date.parse(x):NaN;
const rid=(x:unknown):x is string=>typeof x==='string'&&/^rec[A-Za-z0-9]{14}$/.test(x);
const fidName=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9 _/-]{1,100}$/.test(x);
const canonical=(x:unknown):string=>x===null||typeof x!=='object'?JSON.stringify(x):Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.entries(x as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
const hash=(x:unknown)=>createHash('sha256').update(canonical(x)).digest('hex');
const empty=(x:unknown)=>x===undefined||x===null||x===''||(Array.isArray(x)&&!x.length);
const marker=(plan:AcceptancePlan,c:AcceptanceCase)=>`LKS-ATTR-ACCEPTANCE:${plan.runId}:${c}`;
const roles:Role[]=['inquiries','quotes','orders','attributions'];
const requiredLinks:Record<Role,string[]>={"inquiries":["Quote","Order","Monthly Performance","Quotes","Order_2026","Customer","First Attribution","Latest Attribution"],"quotes":["Customer","Inquiries","Monthly Performance","Inquiry","Performance Month","Attribution Snapshot"],"orders":["Customer","Order Items","Deliveries","Inquiries","Marketing Spend","Inquiry","Performance Month","Attribution Snapshot"],"attributions":["First Campaign","Last Campaign","Inquiries First Attribution","Inquiries Latest Attribution","Quotes Attribution Snapshot","Orders Attribution Snapshot"]};

export function validateAcceptancePlan(value:unknown,now:number,cleanup=false):AcceptancePlan {
 if(!exact(value,['schemaVersion','runId','approvalReference','notBefore','expiresAt','cleanupExpiresAt','allowCleanup','automationReview','attributionIds','linkFields']))throw Error('Synthetic acceptance unavailable.');
 const p=value as unknown as AcceptancePlan,start=iso(p.notBefore),end=iso(p.expiresAt),cleanupEnd=iso(p.cleanupExpiresAt);
 if(p.schemaVersion!=='attribution-synthetic-acceptance-v1'||!/^attrtest_[a-z0-9]{16,48}$/.test(p.runId)||!/^OWNER-APPROVAL-[A-Za-z0-9_-]{8,80}$/.test(p.approvalReference)||p.allowCleanup!==true||p.automationReview!=='no_customer_actions_verified'||!Number.isFinite(start)||!Number.isFinite(end)||!Number.isFinite(cleanupEnd)||end<=start||end-start>3600000||cleanupEnd<end||cleanupEnd-end>900000||now<start||now>(cleanup?cleanupEnd:end))throw Error('Synthetic acceptance unavailable.');
 if(!exact(p.attributionIds,[...ACCEPTANCE_CASES])||new Set(Object.values(p.attributionIds)).size!==5||Object.values(p.attributionIds).some(v=>!/^aid_v1_[0-9a-f]{32}$/.test(v)))throw Error('Invalid synthetic ID allowlist.');
 if(!exact(p.linkFields,roles)||roles.some(role=>!Array.isArray(p.linkFields[role])||p.linkFields[role].length>40||p.linkFields[role].some(x=>!fidName(x))||new Set(p.linkFields[role]).size!==p.linkFields[role].length))throw Error('Invalid synthetic link inventory.');
 if(roles.some(role=>requiredLinks[role].some(name=>!p.linkFields[role].includes(name))))throw Error('Synthetic link inventory is incomplete.');
 return p;
}

/** Fixed non-secret operator plan only. Missing/invalid plans never activate a probe. */
export function loadAcceptancePlan(now:number,cleanup=false):AcceptancePlan|null {
 let fd:number|undefined;
 try{
  const before=lstatSync(ACCEPTANCE_PLAN_PATH);if(!before.isFile()||before.isSymbolicLink())return null;
  fd=openSync(ACCEPTANCE_PLAN_PATH,constants.O_RDONLY|constants.O_NOFOLLOW);const st=fstatSync(fd);
  if(!st.isFile()||(st.mode&0o077)!==0||st.size<100||st.size>20000)return null;
  return validateAcceptancePlan(JSON.parse(readFileSync(fd,'utf8')),now,cleanup);
 }catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
}

export class SyntheticAttributionAcceptance {
 private busy=false;
 constructor(private readonly o:AcceptanceOptions){if(!o.transport.usesStore(o.store))throw Error('Synthetic acceptance must use the same existing writer store.');}
 private save(p:AcceptancePlan,j:Journal){this.o.store.saveAcceptanceJournal(p.runId,JSON.stringify(j));}
 private load(p:AcceptancePlan):Journal|null{const raw=this.o.store.acceptanceJournal(p.runId);return raw?JSON.parse(raw):null;}
 private verdict(j:Journal):AcceptanceResult{return {outcome:j.phase==='retired'?'retired':j.accepted?'accepted':'halted',cases:j.accepted?5:0,syntheticBusinessRecords:j.entities.reduce((n,e)=>n+Number(Boolean(e.inquiry))+Number(Boolean(e.quote))+Number(Boolean(e.order)),0),syntheticAttributions:j.entities.filter(e=>e.attribution).length,cleanupComplete:j.phase==='retired'};}
 private snapshots(p:AcceptancePlan,input:unknown):Entity[]{
  if(!exact(input,['contractVersion','codes'])||input.contractVersion!=='1.0.0'||!exact(input.codes,[...ACCEPTANCE_CASES]))throw Error('Invalid synthetic request.');
  const codes=input.codes as Record<AcceptanceCase,string>;
  if(new Set(Object.values(codes)).size!==5)throw Error('Synthetic cases must be independent.');
  return ACCEPTANCE_CASES.map(caseId=>{
   const code=codes[caseId];if(typeof code!=='string'||!/^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(code))throw Error('Invalid synthetic code.');
   const s=this.o.store.resolve(code,this.o.now());
   const expected=caseId==='google_seo'?'google_organic':caseId==='meta'?'meta_ads':caseId==='threeD'?'google_ads':caseId;
   if(!s||s.attributionId!==p.attributionIds[caseId]||s.firstTouch.channel!==expected||s.entrySurface!==(caseId==='threeD'?'configurator':'wordpress')||iso(s.createdAt)<iso(p.notBefore)||iso(s.createdAt)>iso(p.expiresAt))throw Error('Synthetic source does not match the isolated test allowlist.');
   if(caseId==='threeD'&&s.firstTouch.landingPath!=='/display-box/')throw Error('3D did not retain the Website first touch.');
   return {caseId,code,attributionId:s.attributionId};
  });
 }
 private async create(p:AcceptancePlan,j:Journal,role:'inquiries'|'quotes'|'orders'){
  const idKey=role==='inquiries'?'inquiry':role==='quotes'?'quote':'order';
  if(j.entities.every(e=>rid(e[idKey])))return;
  if(j.pending||j.entities.some(e=>e[idKey]))throw Error('Unknown synthetic write outcome; stop, never retry creation.');
  validateAcceptancePlan(p,this.o.now());
  const fields=j.entities.map(e=>{
   const f:Record<string,Cell>={Notes:marker(p,e.caseId)};
   if(role==='quotes'){if(!rid(e.inquiry))throw Error('Missing own inquiry.');f.Inquiry=[e.inquiry];f.Total=0;f['Sub Total']=0;}
   if(role==='orders'){if(!rid(e.inquiry))throw Error('Missing own inquiry.');f.Inquiry=[e.inquiry];f['Product Amount']=0;f.Cost=0;}
   return {fields:f};
  });
  // Same existing durable writer protocol; never a second writer process.
  const owner=this.o.store.acquireProjectionWriter();
  try{
   j.pending=role;j.phase='creating_'+role;this.save(p,j);
   this.o.store.beginProjectionWrite(owner);
   let records:readonly Row[];
   try{records=await this.o.tables(this.o.mapping.tables[role]).create(fields);this.o.store.finishProjectionWrite(owner);}
   catch(e){this.o.store.markProjectionUncertain(owner);throw e;}
   if(records.length!==5||new Set(records.map(e=>e.id)).size!==5)throw Error('Synthetic create acknowledgement incomplete.');
   for(const e of j.entities){const row=records.find(x=>x.fields.Notes===marker(p,e.caseId));if(!row||!rid(row.id))throw Error('Synthetic acknowledgement does not match its marker.');e[idKey]=row.id;}
   j.pending=null;j.phase='created_'+role;this.save(p,j);
  }finally{this.o.store.releaseProjectionWriter(owner);}
 }
 private async readLinks(j:Journal){
  this.o.transport.start();
  try{
   for(const e of j.entities){
    const iq=await this.o.transport.read(this.o.mapping.tables.inquiries,e.inquiry!);
    const q=await this.o.transport.read(this.o.mapping.tables.quotes,e.quote!);
    const o=await this.o.transport.read(this.o.mapping.tables.orders,e.order!);
    const first=iq.fields[this.o.mapping.inquiry.first],latest=iq.fields[this.o.mapping.inquiry.latest],qp=q.fields[this.o.mapping.quote.snapshot],op=o.fields[this.o.mapping.order.snapshot];
    const pinned=this.o.store.projectionRecord(e.code);if(!pinned||!rid(pinned)||JSON.stringify(first)!==JSON.stringify([pinned])||JSON.stringify(latest)!==JSON.stringify(first)||JSON.stringify(qp)!==JSON.stringify(first)||JSON.stringify(op)!==JSON.stringify(first))throw Error('Synthetic live links do not match.');e.attribution=pinned;
   }
  }finally{this.o.transport.finish();}
 }
 async run(plan:AcceptancePlan,input:unknown){
  const p=validateAcceptancePlan(plan,this.o.now());if(this.busy)throw Error('Synthetic run is busy.');this.busy=true;
  try{
   const entities=this.snapshots(p,input);const digest=hash({plan:p,codes:entities.map(e=>e.code)});let j=this.load(p);
   if(j&&j.digest!==digest)throw Error('Synthetic idempotency conflict.');
   if(!j&&entities.some(e=>!this.o.store.acceptanceCodeUnused(e.code)||this.o.store.projectionRecord(e.code)))throw Error('A source already used by business data cannot be a synthetic case.');
   if(j?.phase==='retired')throw Error('Synthetic run is retired.');
   if(j?.accepted)return this.verdict(j);
   if(j?.pending)throw Error('Unknown synthetic write outcome; operator recovery is required.');
   j=j||{v:1,digest,phase:'validated',entities,pending:null,accepted:false,deleted:[]};this.save(p,j);
   for(const role of ['inquiries','quotes','orders'] as const)await this.create(p,j,role);
   validateAcceptancePlan(p,this.o.now());
   for(const e of j.entities){if(this.o.hooks.inquiry(e.code,e.inquiry!).outcome!=='matched'||this.o.hooks.quote(e.code,e.inquiry!,e.quote!).outcome!=='matched')throw Error('Synthetic binding failed.');this.o.hooks.order(e.quote!,e.order!);}
   if((await this.o.projector.flush()).failed)throw Error('Synthetic projection failed.');await this.readLinks(j);
   // Existing immutable pins must not be replaced by another case's source.
   for(let i=0;i<j.entities.length;i++){const e=j.entities[i],other=j.entities[(i+1)%5];this.o.hooks.quote(other.code,e.inquiry!,e.quote!);this.o.hooks.order(other.quote!,e.order!);}
   if((await this.o.projector.flush()).failed)throw Error('Synthetic immutable replay failed.');await this.readLinks(j);
   j.accepted=true;j.phase='accepted';this.save(p,j);return this.verdict(j);
  }finally{this.busy=false;}
 }
 async cleanup(plan:AcceptancePlan){
  const p=validateAcceptancePlan(plan,this.o.now(),true);if(this.busy)throw Error('Synthetic run is busy.');this.busy=true;
  try{
   const j=this.load(p);if(!j||!j.accepted||j.pending)throw Error('Only acknowledged accepted synthetic data can be cleaned automatically.');
   if(hash({plan:p,codes:j.entities.map(e=>e.code)})!==j.digest)throw Error('Synthetic cleanup plan changed.');
   if(j.phase==='retired')return this.verdict(j);
   const allIds=new Set(j.entities.flatMap(e=>[e.inquiry!,e.quote!,e.order!,e.attribution!]));if(allIds.size!==20)throw Error('Synthetic cleanup manifest incomplete.');
   // Validate all own rows before the first deletion, then repeat a narrow identity check per table.
   for(const role of roles){
    if(j.deleted.includes(role))continue;
    const key=role==='inquiries'?'inquiry':role==='quotes'?'quote':role==='orders'?'order':'attribution';
    const table=this.o.tables(this.o.mapping.tables[role]);
    for(const e of j.entities){
     const id=e[key]!;if(!rid(id)||!allIds.has(id))throw Error('Synthetic cleanup ID rejected.');
     const safeFields=role==='attributions'?p.linkFields[role]:['Notes',...p.linkFields[role]];
     const blanks:Record<Role,string[]>={
      inquiries:['Inquiry Date','Customer Name','Phone','Customer','Monthly Performance','Inquiry Status'],
      quotes:['Quote Number','Quote Date','Status','Public Token','Contact Name','Phone','Customer Name','Customer Phone','Customer Email','Chinese Delivery Address','Invoice Public Token','Customer Submitted At','Customer','Monthly Performance','Converted Order No','Order Ref','Quote Items JSON'],
      orders:['Internal 1 Order No','Internal Order No','Invoice Number','Invoice Date','Pay Date','Order Month & Year','Status','Customer','Invoice Public Token','Receipt Number','Receipt Public Token','Source Quote Ref','Monthly Performance'],
      attributions:[],
     };
     const zeros:Record<Role,string[]>={inquiries:[],quotes:['Total','Sub Total','Discount Amount HKD'],orders:['Product Amount','Cost','Actual Supplier Cost HKD','Actual Reissue Cost HKD','Customer Refund HKD','Amount Received HKD','Discount Amount HKD'],attributions:[]};
     const predicates=[`RECORD_ID() = '${id}'`,...blanks[role].map(f=>`{${f}} = BLANK()`),...zeros[role].map(f=>`OR({${f}} = BLANK(), {${f}} = 0)`)];
     if(role==='attributions')predicates.push(`{Handoff Code} = '${e.code}'`, `{Attribution ID} = '${e.attributionId}'`);
     const rows=await table.select({filterByFormula:`AND(${predicates.join(', ')})`,fields:safeFields,maxRecords:2,pageSize:2}).firstPage();
     if(rows.length!==1||rows[0].id!==id||(role!=='attributions'&&rows[0].fields.Notes!==marker(p,e.caseId)))throw Error('Synthetic cleanup marker mismatch.');
     for(const field of p.linkFields[role]){const links=rows[0].fields[field];if(!empty(links)&&(!Array.isArray(links)||links.some(link=>typeof link!=='string'||!allIds.has(link))))throw Error('Synthetic row acquired an outside link; stop.');}
    }
   }
   validateAcceptancePlan(p,this.o.now(),true);
   this.o.store.retireAcceptanceCodes(j.entities.map(e=>e.code));
   for(const role of ['orders','quotes','inquiries','attributions'] as const){
    if(j.deleted.includes(role))continue;const key=role==='inquiries'?'inquiry':role==='quotes'?'quote':role==='orders'?'order':'attribution';
    const ids=j.entities.map(e=>e[key]!);const removed=await this.o.tables(this.o.mapping.tables[role]).destroy(ids);
    if(removed.length!==5||new Set(removed.map(x=>x.id)).size!==5||removed.some(x=>!ids.includes(x.id)))throw Error('Synthetic cleanup acknowledgement mismatch.');
    j.deleted.push(role);j.phase='cleaning';this.save(p,j);
   }
   j.phase='retired';this.save(p,j);return this.verdict(j);
  }finally{this.busy=false;}
 }
 summary(plan:AcceptancePlan){const j=this.load(plan);return j?this.verdict(j):{outcome:'not_started',cases:0,syntheticBusinessRecords:0,syntheticAttributions:0,cleanupComplete:false};}
}
