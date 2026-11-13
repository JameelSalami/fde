/** Fixed one-order OpenMES read; host owns source principal and transaction guarantee. */
import {createHash} from "node:crypto";
import pg from "pg";
import {FdeInputError} from "../json.js";
import {admitSource,type NativeObservation} from "../model.js";
import type {LabCredentials} from "./config.js";

export const MES_NATIVE_ID="1";
export const MES_BUSINESS_ID="CNDEMO-ERP-MFG-WO-2026-00001";
export const MES_INSTANCE="mfg-cn-reference-mes";
export const MES_SQL="SELECT id::text, order_no, status, planned_qty::text, "+
  "produced_qty::text, updated_at::text FROM public.work_orders WHERE id = $1";

const fail=():never=>{throw new FdeInputError("mes-source-refused",
  "OpenMES source scope, row or transport not verified");};

/** Pure vendor projection. No meaning/authorization is inferred from a source DONE status. */
export function projectMesRow(raw:unknown,observedAt:string):NativeObservation{
  if(!Array.isArray(raw)||raw.length!==1||
     !Array.isArray(raw[0])||raw[0].length!==6)return fail();
  const [nativeId,businessId,state,planned,reported,revision]=raw[0];
  if(nativeId!==MES_NATIVE_ID||businessId!==MES_BUSINESS_ID||
     typeof state!=="string"||typeof planned!=="string"||
     typeof reported!=="string"||typeof revision!=="string")return fail();
  return admitSource({
    schema:"fde.native-observation/v1",dataClass:"isolated-synthetic-native",
    role:"mes",vendor:"openmes",instance:MES_INSTANCE,
    nativeId,businessId,revision,nativeState:state,planned,reported,unit:"pcs",
    coverage:{order:"exact-native-row",receipt:"not-covered",
      ledger:"not-covered",physical:"not-covered"},
    capture:{observedAt,querySha256:createHash("sha256").update(MES_SQL).digest("hex"),
      mode:"source-read-only",transport:"TLSv1.3"}
  });
}
export async function readMes(credentials:LabCredentials["mes"],ca:string):Promise<NativeObservation> {
  const parsers={
    getTypeParser(oid:number,format?: "text"|"binary"){
      if([1114,1184,1700].includes(oid))return (v:string)=>v;
      return pg.types.getTypeParser(oid,format);
    }
  };
  const db=new pg.Client({
    host:"198.51.100.34",port:5432,database:credentials.database,
    user:credentials.username,password:credentials.password,
    ssl:{ca,rejectUnauthorized:true,minVersion:"TLSv1.2"},
    types:parsers,connectionTimeoutMillis:5000,statement_timeout:5000,
    query_timeout:5000,application_name:"fde_synthetic_readonly"
  });
  let connected=false;
  try{
    await db.connect();connected=true;
    const check=await db.query(
      "SELECT current_user AS principal, host(inet_client_addr()) AS peer, "+
      "ssl, version FROM pg_stat_ssl WHERE pid=pg_backend_pid()");
    const auth=check.rows[0];
    if(check.rowCount!==1||auth?.principal!=="mfg_ci_mes_ro"||
       auth.peer!=="198.51.100.33"||auth.ssl!==true||auth.version!=="TLSv1.3")
      return fail();
    await db.query("BEGIN READ ONLY");
    await db.query("SET LOCAL statement_timeout = '5000ms'");
    const rows=await db.query({text:MES_SQL,values:[1],rowMode:"array"});
    const source=projectMesRow(rows.rows,new Date().toISOString());
    if(rows.rowCount!==1)return fail();
    await db.query("COMMIT");
    return source;
  }catch(error){
    if(error instanceof FdeInputError)throw error;
    return fail();
  }finally{
    if(connected){try{await db.query("ROLLBACK");}catch{/* no retry */}}
    try{await db.end();}catch{/* no leak */}
  }
}
