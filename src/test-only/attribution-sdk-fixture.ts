import { createHash } from 'node:crypto';
import type { AttributionProjectionMapping } from '../attribution-projection';
import { syntheticProjectionMapping } from './attribution-projection-fixture';
const SdkTable = require('airtable/lib/table');
const digest = (x: string) => createHash('sha256').update(x).digest('hex');
const id = (prefix: string, x: string) => prefix + digest(x).slice(0,14);

export function actualSdkFixture() {
  const named = syntheticProjectionMapping();
  const mapping = structuredClone({ ...named, campaigns: undefined }) as unknown as AttributionProjectionMapping;
  mapping.campaigns = new Map();
  const alias = new Map<string,string>();
  for (const table of Object.keys(mapping.tables) as Array<keyof typeof mapping.tables>) mapping.tables[table] = id('tbl', table);
  for (const group of ['attribution','inquiry','quote','order'] as const) {
    for (const key of Object.keys(mapping[group])) {
      const fields=mapping[group] as Record<string,string>;const label=(named[group] as Record<string,string>)[key];
      fields[key]=id('fld',group+':'+key);alias.set(fields[key],group==='attribution'&&key==='code'?'Handoff Code':group==='attribution'&&key==='attributionId'?'Attribution ID':label);
    }
  }
  const records=new Map<string,Map<string,Record<string,unknown>>>(); const calls:any[]=[];let counter=0;
  const getTable=(table:string)=>{if(!records.has(table))records.set(table,new Map());return records.get(table)!;};
  const response=(rid:string,fields:Record<string,unknown>,byId:boolean,only?:string[])=>({id:rid,fields:Object.fromEntries(Object.entries(fields).filter(([key,v])=>(!only||only.includes(key)||only.includes(alias.get(key)||key))&&v!==''&&v!==null&&v!==false&&!(Array.isArray(v)&&!v.length)).map(([key,v])=>[byId?key:(alias.get(key)||key),structuredClone(v)]))});
  const cell=(fields:Record<string,unknown>,name:string)=>{const key=Object.keys(fields).find(k=>k===name||alias.get(k)===name);return key?fields[key]:undefined;};
  const split=(x:string)=>{const out:string[]=[];let depth=0,quoted=false,start=0;for(let i=0;i<x.length;i++){const c=x[i];if(c==="'")quoted=!quoted;if(!quoted){if(c==='(')depth++;if(c===')')depth--;if(c===','&&!depth){out.push(x.slice(start,i).trim());start=i+1;}}}out.push(x.slice(start).trim());return out;};
  const isEmpty=(x:unknown)=>x===undefined||x===null||x===''||x===false||(Array.isArray(x)&&!x.length);
  const matches=(formula:string,rid:string,fields:Record<string,unknown>):boolean=>{
    if(/^AND\(/.test(formula)&&formula.endsWith(')'))return split(formula.slice(4,-1)).every(x=>matches(x,rid,fields));
    if(/^OR\(/.test(formula)&&formula.endsWith(')'))return split(formula.slice(3,-1)).some(x=>matches(x,rid,fields));
    let match=/^RECORD_ID\(\) = '([A-Za-z0-9_-]+)'$/.exec(formula);if(match)return rid===match[1];
    match=/^\{([A-Za-z0-9 _/&-]+)\} = '([^']*)'$/.exec(formula);if(match){if(/^fld[A-Za-z0-9]{14}$/.test(match[1]))throw Error('Field-ID formulas are not accepted');return cell(fields,match[1])===match[2];}
    match=/^\{([A-Za-z0-9 _/&-]+)\} = BLANK\(\)$/.exec(formula);if(match)return isEmpty(cell(fields,match[1]));
    match=/^\{([A-Za-z0-9 _/&-]+)\} = 0$/.exec(formula);if(match)return cell(fields,match[1])===0;
    match=/^\{([A-Za-z0-9 _/&-]+)\} != ''$/.exec(formula);if(match)return !isEmpty(cell(fields,match[1]));
    throw Error('Unexpected or unscoped synthetic API query: '+formula);
  };
  const fakeBase={runAction(method:string,path:string,query:any,data:any,done:Function){
    try {
      calls.push({method,path,query:structuredClone(query),data:structuredClone(data)});
      const [table,rid]=path.split('/').filter(Boolean);const rows=getTable(table);
      if(method==='get'&&rid){if(!rows.has(rid))throw Error('Missing synthetic record');return queueMicrotask(()=>done(null,{},response(rid,rows.get(rid)!,false)));}
      if(method==='get'){
        const formula=query.filterByFormula;if(typeof formula!=='string')throw Error('Broad table query rejected');
        let ids=[...rows].filter(([key,fields])=>matches(formula,key,fields)).map(([key])=>key);
        if(query.sort)ids.sort((a,b)=>{const v=cell(rows.get(a)!,query.sort[0].field),w=cell(rows.get(b)!,query.sort[0].field);if(isEmpty(v)!==isEmpty(w))return isEmpty(v)?-1:1;return String(w).localeCompare(String(v));});
        const body={records:ids.slice(0,query.maxRecords).map(key=>response(key,rows.get(key)!,query.returnFieldsByFieldId===true,query.fields))};return queueMicrotask(()=>done(null,{},body));
      }
      if(method==='delete'){
        if(!Array.isArray(query.records)||query.records.some((key:string)=>!rows.has(key)))throw Error('Synthetic deletion requires exact existing IDs');
        for(const key of query.records)rows.delete(key);return queueMicrotask(()=>done(null,{}, {records:query.records.map((key:string)=>({id:key,deleted:true}))}));
      }
      if(method==='post'||method==='patch'){
        const out=data.records.map((r:any)=>{const key=method==='post'?id('rec',String(++counter)):r.id;if(method==='patch'&&!rows.has(key))throw Error('Missing synthetic update');rows.set(key,{...rows.get(key),...structuredClone(r.fields)});return response(key,rows.get(key)!,data.returnFieldsByFieldId===true);});return queueMicrotask(()=>done(null,{}, {records:out}));
      }
      throw Error('Unexpected synthetic SDK operation');
    }catch(e){queueMicrotask(()=>done(e));}
  }};
  const table=(name:string)=>new SdkTable(fakeBase,name,null);
  return {mapping,alias,table,calls,seed:(name:string,rid:string,fields:Record<string,unknown>={})=>getTable(name).set(rid,structuredClone(fields)),read:(name:string,rid:string)=>structuredClone(getTable(name).get(rid)),rows:records};
}
