/** Closed, bounded JSON admission. This rejects duplicate raw object keys before JSON.parse. */
export class FdeInputError extends Error {
  constructor(readonly code:string,detail:string){super(code+": "+detail);this.name="FdeInputError";}
}
export function reject(code:string,detail:string):never {throw new FdeInputError(code,detail);}

export function parseStrictJson(text:string):unknown {
  return parseJsonWithLimits(text,262144,128,false);
}

/** The finite BOM response can contain several findings per admitted input row.
 * This larger output-only budget never expands the ordinary request codec. */
export function parseIndustrialResponseJson(text:string):unknown {
  return parseJsonWithLimits(text,2097152,2048,true,65536);
}
export function detachIndustrialResponse(value:unknown):unknown {
  return detachWithArrayLimit(value,2048,65536);
}

/** Provider transport metadata is not domain input. Ollama may return a bounded
 * context-token array larger than the domain codec's 128-member ceiling. */
export function parseProviderEnvelopeJson(text:string):unknown {
  return parseJsonWithLimits(text,32768,4096,true);
}

function parseJsonWithLimits(text:string,inputBudget:number,arrayLimit:number,byteBudget:boolean,nodeLimit=8192):unknown {
  if(typeof text!=="string"||text.length===0||text.length>inputBudget||
     (byteBudget&&Buffer.byteLength(text,"utf8")>inputBudget))
    reject("input-budget","JSON source is empty or too long");
  let i=0,nodes=0;
  const whitespace=()=>{while(i<text.length&&/\s/.test(text[i]!))i++;};
  const jsonString=():string=>{
    const fragment=text.slice(i).match(/^"(?:[^"\\\u0000-\u001f]|\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4}))*"/);
    if(!fragment)reject("invalid-json","invalid JSON string");
    i+=fragment[0]!.length;
    return JSON.parse(fragment[0]!) as string;
  };
  const value=(depth:number):void=>{
    if(depth>32||++nodes>nodeLimit)reject("input-budget","JSON depth or node budget");
    whitespace();
    if(text[i]==="{"){
      i++;whitespace();
      const names=new Set<string>();
      if(text[i]==="}"){i++;return;}
      while(true){
        whitespace();
        const key=jsonString();
        if(names.has(key))reject("duplicate-key","repeated JSON object member");
        names.add(key);whitespace();
        if(text[i++]!==":")reject("invalid-json","object colon");
        value(depth+1);whitespace();
        const c=text[i++];
        if(c==="}")return;
        if(c!==",")reject("invalid-json","object separator");
      }
    }
    if(text[i]==="["){
      i++;whitespace();
      if(text[i]==="]"){i++;return;}
      while(true){
        value(depth+1);whitespace();
        const c=text[i++];
        if(c==="]")return;
        if(c!==",")reject("invalid-json","array separator");
      }
    }
    if(text[i]==='"'){jsonString();return;}
    const tail=text.slice(i);
    const literal=tail.match(/^(?:true|false|null)(?![\w])/);
    if(literal){i+=literal[0]!.length;return;}
    const numeric=tail.match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if(numeric){i+=numeric[0]!.length;return;}
    reject("invalid-json","unknown token");
  };
  value(0);whitespace();
  if(i!==text.length)reject("invalid-json","trailing token");
  try{return detachWithArrayLimit(JSON.parse(text),arrayLimit,nodeLimit);}
  catch(error){if(error instanceof FdeInputError)throw error;return reject("invalid-json","JSON parse failed");}
}

/** Safely detach plain JSON-like caller data. Never execute an accessor. */
export function detach(value:unknown):unknown {
  return detachWithArrayLimit(value,128);
}

function detachWithArrayLimit(value:unknown,arrayLimit:number,nodeLimit=8192):unknown {
  const seen=new Set<object>();let nodes=0;
  const visit=(v:unknown,depth:number):unknown=>{
    if(++nodes>nodeLimit||depth>32)reject("input-budget","value graph too large");
    if(v===null||typeof v==="boolean")return v;
    if(typeof v==="number"&&Number.isFinite(v))return v;
    if(typeof v==="string"&&v.length<=8192&&!v.includes("\0"))return v;
    if(!v||typeof v!=="object")reject("invalid-primitive","not finite plain JSON");
    if(seen.has(v))reject("invalid-cycle","cyclic input");
    seen.add(v);
    const proto=Object.getPrototypeOf(v);
    if(Object.getOwnPropertySymbols(v).length)reject("invalid-member","symbol member");
    if(Array.isArray(v)){
      if(proto!==Array.prototype||v.length>arrayLimit)reject("invalid-array","unsupported array");
      const desc=Object.getOwnPropertyDescriptors(v);
      if(Object.keys(desc).length!==v.length+1)reject("invalid-array","sparse/extended array");
      const a:unknown[]=[];
      for(let k=0;k<v.length;k++){
        const d=desc[String(k)];
        if(!d||!("value" in d)||!d.enumerable)reject("invalid-accessor","array accessor");
        a.push(visit(d.value,depth+1));
      }
      seen.delete(v);return Object.freeze(a);
    }
    if(proto!==Object.prototype&&proto!==null)reject("invalid-prototype","nonplain input");
    const desc=Object.getOwnPropertyDescriptors(v);
    const o:Record<string,unknown>={};
    for(const [k,d] of Object.entries(desc)){
      if(["__proto__","constructor","prototype"].includes(k))
        reject("invalid-member","prototype field");
      if(!("value" in d)||!d.enumerable)reject("invalid-accessor","object accessor");
      o[k]=visit(d.value,depth+1);
    }
    seen.delete(v);return Object.freeze(o);
  };
  return visit(value,0);
}

export function object(v:unknown,keys:readonly string[],name:string):Record<string,unknown>{
  if(!v||typeof v!=="object"||Array.isArray(v)||
     (Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null))
    reject("invalid-object",name);
  const p=v as Record<string,unknown>;
  const actual=Object.keys(p);
  if(actual.length!==keys.length||keys.some(k=>!Object.hasOwn(p,k)))
    reject("closed-object",name);
  return p;
}
export function string(v:unknown,name:string,max=160):string {
  if(typeof v!=="string"||!v||v.length>max||/[\x00-\x1f\x7f]/.test(v))
    reject("invalid-string",name);
  return v;
}
export function identity(v:unknown,name:string):string {
  const x=string(v,name);
  if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(x))reject("invalid-identity",name);
  return x;
}
export function digest(v:unknown,name:string):string {
  if(typeof v!=="string"||!/^[0-9a-f]{64}$/.test(v))reject("invalid-digest",name);
  return v;
}
