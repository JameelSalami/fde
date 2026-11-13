/** Host's strict boundary for one installed handwritten Haskell compiler.
 * The returned object is a source-bound DIAGNOSTIC, not authenticated semantic
 * membership, authorization, protected result release or vendor command.
 */
import {bundledSemanticRuntime,type SemanticRuntime} from "./semantic-runtime.js";
import {admitCase,type ReviewCase} from "./model.js";
import {parseStrictJson,object,string,reject,detach} from "./json.js";

export type Classification =
  |"aligned-reports"|"reported-gap"|"plan-disagreement"
  |"plan-and-report-disagreement"|"indeterminate-native-state";

export interface SemanticCandidate {
  readonly family:"WorkPlan"|"SourceReport";
  readonly rootKind:"WorkRequest"|"QuantityReport";
  readonly sourceVendor:"erpnext"|"openmes";
  readonly sourceInstance:string;
  readonly sourceNativeId:string;
  readonly sourceBusinessId:string;
  readonly sourceRevision:string;
  readonly sourceQueryDigest:string;
  readonly property:string;
  readonly quantity:string;
  readonly unit:"Nos"|"pcs";
  readonly status:string;
  readonly authority:"none";
}
export interface CompiledDiagnostic {
  readonly schema:"fde.compiled-diagnostic/v1";
  readonly authority:"none";
  readonly admissionStatus:"candidate-only";
  readonly businessTruthSelected:false;
  readonly classification:Classification;
  readonly plannedDelta:string;
  readonly reportedDelta:string;
  readonly humanReviewRequired:boolean;
  readonly sourceClass:"handwritten-fixture"|"isolated-synthetic-native";
  readonly candidates:readonly SemanticCandidate[];
  readonly bindingGrade:string;
  readonly erpNativeId:string;
  readonly mesNativeId:string;
  readonly erpRevision:string;
  readonly mesRevision:string;
  readonly erpQueryDigest:string;
  readonly mesQueryDigest:string;
  readonly receiptCoverage:"not-covered";
  readonly ledgerCoverage:"not-covered";
  readonly physicalCoverage:"not-covered";
  readonly atomicSnapshot:false;
  readonly postingPermitted:false;
  readonly physicalProductionCertified:false;
  readonly mutationCandidate:{
    readonly kind:"human-discrepancy-review";
    readonly targetSystem:"none";
    readonly evidenceRequired:true;
    readonly executable:false;
  };
}

const outcomeSet=new Set(["aligned-reports","reported-gap","plan-disagreement",
  "plan-and-report-disagreement","indeterminate-native-state"]);
const fields=[
 "schema","authority","businessTruthSelected","admissionStatus",
 "classification","plannedDelta","reportedDelta","humanReviewRequired",
 "sourceClass","candidates","bindingGrade","erpNativeId","mesNativeId",
 "erpRevision","mesRevision","erpQueryDigest","mesQueryDigest",
 "receiptCoverage","ledgerCoverage","physicalCoverage","atomicSnapshot",
 "postingPermitted","physicalProductionCertified","mutationCandidate"
] as const;
const candidateFields=[
  "family","rootKind","sourceVendor","sourceInstance","sourceNativeId",
  "sourceBusinessId","sourceRevision","sourceQueryDigest",
  "property","quantity","unit","status","authority"
] as const;
const candidateProps=[
  ["WorkPlan","WorkRequest","requested-quantity","erp","planned"],
  ["WorkPlan","WorkRequest","requested-quantity","mes","planned"],
  ["SourceReport","QuantityReport","recorded-manufacturing-quantity","erp","reported"],
  ["SourceReport","QuantityReport","reported-execution-quantity","mes","reported"],
] as const;
function required(value:unknown,expected:unknown,name:string){
  if(value!==expected)reject("compiled-receipt-refused",name);
}
function delta(value:unknown,name:string){
  if(typeof value!=="string"||! /^-?(?:0|[1-9][0-9]{0,14})\.[0-9]{1,6}$/.test(value))
    reject("compiled-receipt-refused",name);
}
function candidateCheck(value:unknown,p:ReviewCase,index:number) {
  const x=object(value,candidateFields,"candidate");
  const [family,rootKind,property,sourceKind,quantityKey]=candidateProps[index]!;
  const src=p[sourceKind];
  required(x.family,family,"candidate family");
  required(x.rootKind,rootKind,"candidate root");
  required(x.property,property,"candidate property");
  required(x.sourceVendor,src.vendor,"candidate vendor");
  required(x.sourceInstance,src.instance,"candidate instance");
  required(x.sourceNativeId,src.nativeId,"candidate native identity");
  required(x.sourceBusinessId,src.businessId,"candidate business identity");
  required(x.sourceRevision,src.revision,"candidate source revision");
  required(x.sourceQueryDigest,src.capture.querySha256,"candidate source read");
  required(x.quantity,src[quantityKey],"candidate verbatim quantity");
  required(x.unit,src.unit,"candidate native unit");
  required(x.status,src.nativeState,"candidate state");
  required(x.authority,"none","candidate authority");
}
export function verifyCompilerResponse(raw:unknown,p:ReviewCase):CompiledDiagnostic{
  const env=object(detach(raw),["ok","result"],"compiler reply");
  required(env.ok,true,"compiler success marker");
  const d=object(env.result,fields,"compiled diagnostic");
  required(d.schema,"fde.compiled-diagnostic/v1","schema");
  required(d.authority,"none","authority");
  required(d.businessTruthSelected,false,"truth selection");
  required(d.admissionStatus,"candidate-only","admission");
  if(!outcomeSet.has(d.classification as string))
    reject("compiled-receipt-refused","unknown classification");
  delta(d.plannedDelta,"planned delta");
  delta(d.reportedDelta,"report delta");
  if(typeof d.humanReviewRequired!=="boolean")
    reject("compiled-receipt-refused","review requirement");
  const grade=p.erp.dataClass==="isolated-synthetic-native"&&
    p.mes.dataClass==="isolated-synthetic-native"?
    "isolated-synthetic-native":"handwritten-fixture";
  required(d.sourceClass,grade,"source grade");
  required(d.bindingGrade,p.binding.grade,"mapping grade");
  required(d.erpNativeId,p.erp.nativeId,"ERP id");
  required(d.mesNativeId,p.mes.nativeId,"MES id");
  required(d.erpRevision,p.erp.revision,"ERP revision");
  required(d.mesRevision,p.mes.revision,"MES revision");
  required(d.erpQueryDigest,p.erp.capture.querySha256,"ERP query");
  required(d.mesQueryDigest,p.mes.capture.querySha256,"MES query");
  for(const k of ["receiptCoverage","ledgerCoverage","physicalCoverage"])
    required(d[k],"not-covered",k);
  for(const k of ["atomicSnapshot","postingPermitted","physicalProductionCertified"])
    required(d[k],false,k);
  if(!Array.isArray(d.candidates)||d.candidates.length!==4)
    reject("compiled-receipt-refused","candidate cardinality");
  d.candidates.forEach((c,i)=>candidateCheck(c,p,i));
  const candidate=object(d.mutationCandidate,["kind","targetSystem","evidenceRequired","executable"],
    "repair candidate");
  required(candidate.kind,"human-discrepancy-review","proposal kind");
  required(candidate.targetSystem,"none","no source-target permission");
  required(candidate.evidenceRequired,true,"evidence requirement");
  required(candidate.executable,false,"nonexecutable proposal");
  return d as unknown as CompiledDiagnostic;
}

/** This host calls only a pinned local executable; no shell or legacy binary. */
export function compileSemantic(raw:unknown,runtime:SemanticRuntime=bundledSemanticRuntime()):CompiledDiagnostic {
  const p=admitCase(raw);
  const encoded=JSON.stringify(p);
  if(Buffer.byteLength(encoded)>131072)reject("input-budget","compiler input");
  // Strict JSON-text boundary prevents duplicate keys, executable JS/Proxies and
  // ambient toJSON from reaching the compiler; Haskell validates types again.
  parseStrictJson(encoded);
  const r=runtime.invoke(encoded,131072);
  if(r.error||r.status!==0||!r.stdout||r.stderr.length>0)
    reject("compiler-host-failed","Haskell source unavailable or crashed");
  const returned=parseStrictJson(r.stdout);
  const status=object(returned,Object.keys(returned as Record<string,unknown>),
    "compiler response");
  if(status.ok===false){
    const refused=object(returned,["ok","error"],"compiled refusal");
    const code=string(refused.error,"kernel error",80);
    reject("kernel-refused",code);
  }
  const accepted=object(returned,["ok","result"],"compiler success");
  return verifyCompilerResponse(accepted,p);
}
