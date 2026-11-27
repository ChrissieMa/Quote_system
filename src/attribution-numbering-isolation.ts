/** Empty synthetic records must never become the last business sequence value. */
export const businessNumberLookup = (field: string): {
  fields: string[]; sort: Array<{ field: string; direction: 'desc' }>; maxRecords: number; filterByFormula: string;
} => {
  if (!['Quote Number', 'Internal Order No', 'Invoice Number', 'Receipt Number'].includes(field)) {
    throw new Error('Unsupported business number field.');
  }
  return { fields: [field], sort: [{ field, direction: 'desc' }], maxRecords: 1,
    filterByFormula: `{${field}} != ''` };
};

export const nextBusinessNumber = async (table: {select(options:ReturnType<typeof businessNumberLookup>):{firstPage():Promise<readonly {get(field:string):unknown}[]>}}, field:string,prefix:string):Promise<string>=>{
 const records=await table.select(businessNumberLookup(field)).firstPage();
 if(records.length===0||!records[0].get(field))return `${prefix}-2026-0001`;
 const lastNumber=String(records[0].get(field));const match=lastNumber.match(/-(\d+)$/);
 if(match){const next=parseInt(match[1],10)+1;return `${prefix}-2026-${next.toString().padStart(4,'0')}`;}
 return `${prefix}-2026-0001`;
};
