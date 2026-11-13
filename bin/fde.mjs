#!/usr/bin/env node
/** Direct operational probe. The CLI never calls a vendor write endpoint. */
import {compileSemantic,formatDiagnostic} from "../dist/src/index.js";
function fixture(){
 const observation=(role,instance,id,business,state,planned,reported,unit)=>({
   schema:"fde.native-observation/v1",dataClass:"handwritten-fixture",
   role,vendor:role==="erp"?"erpnext":"openmes",instance,nativeId:id,
   businessId:business,revision:"fictional-v1",nativeState:state,
   planned,reported,unit,
   coverage:{order:"exact-native-row",receipt:"not-covered",
     ledger:"not-covered",physical:"not-covered"},
   capture:{observedAt:"2026-10-29T00:00:00.000Z",
     querySha256:"a".repeat(64),mode:"fixture",transport:"not-applicable"}
 });
 return {
   schema:"fde.case/v1",
   erp:observation("erp","fictional-erp","ORDER-17","ORDER-17",
     "Not Started","3.000000000","0.0","Nos"),
   mes:observation("mes","fictional-mes","17","ORDER-17",
     "DONE","3.0","3.000","pcs"),
   binding:{schema:"fde.native-binding/v1",
     grade:"synthetic-native-import-reviewed",
     erp:{instance:"fictional-erp",nativeId:"ORDER-17"},
     mes:{instance:"fictional-mes",nativeId:"17"},
     unit:"synthetic-pcs-equals-Nos"}
 };
}
async function main(){
 if(process.argv.length!==3||!["help","demo","probe:lab"].includes(process.argv[2]))
   throw Error("usage");
 if(process.argv[2]==="help"){
   console.log("fde help | demo | probe:lab (live read-only lab)");
   return;
 }
 const source=process.argv[2]==="demo"?fixture():
   await (await import("../dist/src/enterprise/probe.js")).readExistingLab();
 const d=compileSemantic(source);
 console.log(formatDiagnostic(d));
 console.log(JSON.stringify({
   schema:d.schema,classification:d.classification,
   plannedDelta:d.plannedDelta,reportedDelta:d.reportedDelta,
   candidates:d.candidates.length,authority:d.authority,
   businessTruthSelected:d.businessTruthSelected,
   postingPermitted:d.postingPermitted
 }));
}
main().catch(error=>{
  console.error("fde: refused — "+(
    error instanceof Error&&"code" in error?String(error.code):"unavailable"));
  process.exitCode=2;
});
