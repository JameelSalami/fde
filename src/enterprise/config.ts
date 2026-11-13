/** Host-owned authentication: a dedicated existing lab account, never an FDE grant. */
import {lstat,readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {detach,object,reject} from "../json.js";

export const ORIGINAL_LAB_ROOT=
  "/path/to/your/fictional-vendor-lab";
const SECRET=resolve(ORIGINAL_LAB_ROOT,".data/lab-cn/sql-readonly/credentials.json");
const CERT=resolve(ORIGINAL_LAB_ROOT,".data/lab-cn/sql-readonly/pg-ca.crt");

export interface LabCredentials {
  readonly schema:"manufacturing.cn-sql-least-privilege/v1";
  readonly source:"isolated-synthetic-lab";
  readonly tlsRequired:true;
  readonly erp:{readonly username:"mfg_ci_erp_ro";readonly password:string;
    readonly host:"192.0.2.10";readonly database:"cn_reference_20261016"};
  readonly mes:{readonly username:"mfg_ci_mes_ro";readonly password:string;
    readonly clientSubnet:"198.51.100.33/32";readonly database:"cn_reference_mes"};
}
/** Credential *shape* is not host-authenticated until the owner-only file is checked. */
export function admitLabCredentials(raw:unknown):LabCredentials {
  const c=object(detach(raw),["schema","source","tlsRequired","erp","mes"],"host-auth");
  const erp=object(c.erp,["username","host","database","password"],"erp-auth");
  const mes=object(c.mes,["username","clientSubnet","database","password"],"mes-auth");
  if(c.schema!=="manufacturing.cn-sql-least-privilege/v1"||
     c.source!=="isolated-synthetic-lab"||c.tlsRequired!==true||
     erp.username!=="mfg_ci_erp_ro"||erp.host!=="192.0.2.10"||
     erp.database!=="cn_reference_20261016"||
     mes.username!=="mfg_ci_mes_ro"||mes.clientSubnet!=="198.51.100.33/32"||
     mes.database!=="cn_reference_mes"||
     typeof erp.password!=="string"||erp.password.length<40||
     typeof mes.password!=="string"||mes.password.length<40)
    reject("lab-auth-refused","unsupported source principal/site");
  return c as unknown as LabCredentials;
}
export async function sourceAuth():Promise<{readonly creds:LabCredentials;readonly ca:string}> {
  const st=await lstat(SECRET);
  if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
     (process.getuid&&st.uid!==process.getuid()))
    reject("lab-auth-refused","source credential file not owner-only");
  let parsed:unknown;
  try{parsed=JSON.parse(await readFile(SECRET,"utf8"));}
  catch{reject("lab-auth-refused","unreadable credential envelope");}
  const creds=admitLabCredentials(parsed);
  const ca=await readFile(CERT,"utf8");
  if(ca.length>12000||!ca.startsWith("-----BEGIN CERTIFICATE-----"))
    reject("lab-auth-refused","source CA missing or invalid");
  return {creds,ca};
}
