/** Fixed one-order ERPNext source read; host owns source authentication and transactions. */
import {createHash} from "node:crypto";
import mariadb from "mariadb";
import type {Connection} from "mariadb";
import {FdeInputError} from "../json.js";
import {admitSource,type NativeObservation} from "../model.js";
import type {LabCredentials} from "./config.js";

export const ERP_ORDER_NAME="MFG-WO-2026-00001";
export const ERP_INSTANCE="cn_reference_20261016";
export const ERP_SQL="SELECT name, status, docstatus, qty, produced_qty, stock_uom, modified "+
  "FROM cn_reference_20261016.\u0060tabWork Order\u0060 WHERE name = ?";

const fail=():never=>{throw new FdeInputError("erp-source-refused",
  "ERPNext source scope, row or transport not verified");};

/** Pure native-row admission; never assumes a row exists when an array is empty. */
export function projectErpRow(raw:unknown,observedAt:string):NativeObservation {
  if(!Array.isArray(raw)||raw.length!==1||
     !Array.isArray(raw[0])||raw[0].length!==7) return fail();
  const [nativeId,state,documentStatus,planned,reported,unit,revision]=raw[0];
  if(documentStatus!==1&&documentStatus!=="1") return fail();
  if(typeof nativeId!=="string"||nativeId!==ERP_ORDER_NAME||
     typeof state!=="string"||typeof planned!=="string"||
     typeof reported!=="string"||unit!=="Nos"||
     typeof revision!=="string")return fail();
  return admitSource({
    schema:"fde.native-observation/v1",dataClass:"isolated-synthetic-native",
    role:"erp",vendor:"erpnext",instance:ERP_INSTANCE,
    nativeId,businessId:nativeId,revision,nativeState:state,
    planned,reported,unit,
    coverage:{order:"exact-native-row",receipt:"not-covered",
      ledger:"not-covered",physical:"not-covered"},
    capture:{observedAt,querySha256:createHash("sha256").update(ERP_SQL).digest("hex"),
      mode:"source-read-only",transport:"TLSv1.3"}
  });
}
export async function readErp(credentials:LabCredentials["erp"]):Promise<NativeObservation>{
  let db:Connection|undefined;
  try{
    db=await mariadb.createConnection({
      host:"192.0.2.12",port:3306,database:ERP_INSTANCE,
      user:credentials.username,password:credentials.password,
      ssl:true,rowsAsArray:true,dateStrings:true,multipleStatements:false,
      connectTimeout:5000,queryTimeout:5000,socketTimeout:8000
    });
    const who=await db.query("SELECT CURRENT_USER()");
    const ssl=await db.query("SHOW SESSION STATUS LIKE 'Ssl_version'");
    if(!Array.isArray(who)||who.length!==1||
       who[0]?.[0]!=="mfg_ci_erp_ro@192.0.2.10"||
       !Array.isArray(ssl)||ssl[0]?.[1]!=="TLSv1.3")return fail();
    await db.query("SET SESSION MAX_STATEMENT_TIME=5");
    await db.query("START TRANSACTION READ ONLY");
    const rows:unknown=await db.query(ERP_SQL,[ERP_ORDER_NAME]);
    const source=projectErpRow(rows,new Date().toISOString());
    await db.query("COMMIT");
    return source;
  }catch(error){
    if(error instanceof FdeInputError)throw error;
    return fail();
  }finally{
    if(db){try{await db.query("ROLLBACK");}catch{/* no retry */}try{await db.end();}catch{/* no leak */}}
  }
}
