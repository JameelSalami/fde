import {bundledSemanticRuntime,type SemanticRuntime} from "./semantic-runtime.js";
import {admitCase} from "./model.js";
import {detach,object,parseStrictJson,reject,string} from "./json.js";

function invokeKernel(request:unknown,runtime:SemanticRuntime):unknown{
  const encoded=JSON.stringify(request);
  if(Buffer.byteLength(encoded)>131072)reject("input-budget","semantic request");
  parseStrictJson(encoded);
  const r=runtime.invoke(encoded,262144);
  if(r.error||r.status!==0||!r.stdout||r.stderr.length>0)
    reject("compiler-host-failed","Haskell semantic package unavailable or crashed");
  const returned=parseStrictJson(r.stdout);
  const top=object(returned,Object.keys(returned as Record<string,unknown>),"semantic compiler response");
  if(top.ok===false){
    const refused=object(returned,["ok","error"],"semantic refusal");
    reject("kernel-refused",string(refused.error,"semantic refusal",120));
  }
  return object(returned,["ok","result"],"semantic success").result;
}

function strings(raw:unknown,label:string):readonly string[]{
  if(!Array.isArray(raw)||raw.some(v=>typeof v!=="string")||
     new Set(raw as string[]).size!==raw.length)reject("semantic-receipt-refused",label);
  return Object.freeze([...(raw as string[])]);
}
function exactSet(actual:readonly string[],expected:readonly string[],label:string):void{
  if(JSON.stringify([...actual].sort())!==JSON.stringify([...expected].sort()))
    reject("semantic-receipt-refused",label);
}

export interface SemanticCatalog{
  readonly schema:"fde.semantic-catalog/v1";
  readonly authority:"none";
  readonly modelId:"fde.w1.production-order";
  readonly modelVersion:"v1";
  readonly factIds:readonly string[];
  readonly constraintIds:readonly string[];
  readonly claimKinds:readonly string[];
  readonly mappingId:"fde.w1.synthetic-pcs-Nos/v1";
}
const expectedFacts=[
 "fact:erp-planned-quantity","fact:mes-planned-quantity",
 "fact:erp-reported-quantity","fact:mes-reported-quantity",
 "fact:receipt-evidence","fact:ledger-evidence","fact:physical-production"
] as const;
const expectedConstraints=[
 "constraint:erp-report-known","constraint:mes-report-known",
 "constraint:plan-alignment","constraint:reported-alignment",
 "constraint:physical-production-known"
] as const;
const expectedClaims=[
 "native-reported-values","source-coverage-limit",
 "physical-production-occurred","reported-quantity"
] as const;

export function compileSemanticCatalog(runtime:SemanticRuntime=bundledSemanticRuntime()):SemanticCatalog{
  const c=object(detach(invokeKernel({schema:"fde.semantic-catalog-request/v1"},runtime)),
    ["schema","authority","modelId","modelVersion","factIds","constraintIds","claimKinds","mappingId"],
    "semantic catalog");
  if(c.schema!=="fde.semantic-catalog/v1"||c.authority!=="none"||
     c.modelId!=="fde.w1.production-order"||c.modelVersion!=="v1"||
     c.mappingId!=="fde.w1.synthetic-pcs-Nos/v1")
    reject("semantic-receipt-refused","semantic catalog identity");
  const factIds=strings(c.factIds,"semantic fact IDs");
  const constraintIds=strings(c.constraintIds,"semantic constraint IDs");
  const claimKinds=strings(c.claimKinds,"semantic claim kinds");
  exactSet(factIds,expectedFacts,"semantic fact catalog");
  exactSet(constraintIds,expectedConstraints,"semantic constraint catalog");
  exactSet(claimKinds,expectedClaims,"semantic claim catalog");
  return Object.freeze({...c,factIds,constraintIds,claimKinds}) as unknown as SemanticCatalog;
}

export interface SemanticEvidenceBinding{
  readonly id:string;readonly role:"erp"|"mes";readonly instance:string;
  readonly nativeId:string;readonly revision:string;readonly querySha256:string;
}
export type SemanticKnowledge=
  |Readonly<{kind:"known";value:Readonly<{kind:"quantity";value:string;unit:"synthetic-count"}>}>
  |Readonly<{kind:"unknown";reason:string}>
  |Readonly<{kind:"conflicting";observations:readonly unknown[]}>;
export interface SemanticFactReceipt{
  readonly id:string;readonly subjectId:string;readonly property:string;
  readonly knowledge:SemanticKnowledge;readonly evidence:readonly SemanticEvidenceBinding[];
}
export interface SemanticConstraintReceipt{
  readonly constraintId:string;
  readonly status:"satisfied"|"violated"|"indeterminate";
  readonly reason:string;
}
export interface SemanticPackageReceipt{
  readonly schema:"fde.semantic-package/v1";readonly authority:"none";
  readonly modelId:"fde.w1.production-order";readonly modelVersion:"v1";
  readonly facts:readonly SemanticFactReceipt[];
  readonly constraints:readonly Record<string,unknown>[];
  readonly receipts:readonly SemanticConstraintReceipt[];
  readonly mapping:Readonly<{
    id:"fde.w1.synthetic-pcs-Nos/v1";bindingGrade:string;unitPolicy:string;
    fidelity:Readonly<{kind:"projection-only";reason:string}>;
  }>;
}
export function compileSemanticPackage(raw:unknown,runtime:SemanticRuntime=bundledSemanticRuntime()):SemanticPackageReceipt{
  const p=admitCase(raw),catalog=compileSemanticCatalog(runtime);
  const result=object(detach(invokeKernel({schema:"fde.semantic-package-request/v1",case:p},runtime)),
    ["schema","authority","modelId","modelVersion","facts","constraints","receipts","mapping"],
    "semantic package");
  if(result.schema!=="fde.semantic-package/v1"||result.authority!=="none"||
     result.modelId!==catalog.modelId||result.modelVersion!==catalog.modelVersion)
    reject("semantic-receipt-refused","semantic package identity");
  if(!Array.isArray(result.facts)||!Array.isArray(result.constraints)||!Array.isArray(result.receipts))
    reject("semantic-receipt-refused","semantic package arrays");
  const facts=result.facts.map(rawFact=>{
    const f=object(rawFact,["id","subjectId","property","knowledge","evidence"],"semantic fact");
    if(typeof f.id!=="string"||typeof f.subjectId!=="string"||!f.subjectId||
       typeof f.property!=="string"||!f.property||!Array.isArray(f.evidence)||f.evidence.length<1)
      reject("semantic-receipt-refused","semantic fact fields");
    const evidence=f.evidence.map(rawEvidence=>{
      const e=object(rawEvidence,["id","role","instance","nativeId","revision","querySha256"],"semantic evidence");
      if(typeof e.id!=="string"||!["erp","mes"].includes(String(e.role))||
         typeof e.instance!=="string"||typeof e.nativeId!=="string"||
         typeof e.revision!=="string"||typeof e.querySha256!=="string")
        reject("semantic-receipt-refused","semantic evidence fields");
      const src=e.role==="erp"?p.erp:p.mes;
      if(e.instance!==src.instance||e.nativeId!==src.nativeId||e.revision!==src.revision||
         e.querySha256!==src.capture.querySha256)
        reject("semantic-receipt-refused","semantic evidence source binding");
      return Object.freeze(e) as unknown as SemanticEvidenceBinding;
    });
    const k=object(f.knowledge,Object.keys(f.knowledge as object),"semantic knowledge");
    if(k.kind==="known"){
      const value=object(k.value,["kind","value","unit"],"semantic known value");
      if(value.kind!=="quantity"||typeof value.value!=="string"||value.unit!=="synthetic-count")
        reject("semantic-receipt-refused","semantic known quantity");
    }else if(k.kind==="unknown"){
      object(k,["kind","reason"],"semantic unknown");
      if(typeof k.reason!=="string"||!k.reason)reject("semantic-receipt-refused","semantic unknown reason");
    }else if(k.kind==="conflicting"){
      object(k,["kind","observations"],"semantic conflict");
      if(!Array.isArray(k.observations))reject("semantic-receipt-refused","semantic conflict observations");
    }else reject("semantic-receipt-refused","semantic knowledge kind");
    return Object.freeze({id:f.id,subjectId:f.subjectId,property:f.property,
      knowledge:k,evidence:Object.freeze(evidence)}) as unknown as SemanticFactReceipt;
  });
  exactSet(facts.map(f=>f.id),catalog.factIds,"semantic package fact membership");
  const receipts=result.receipts.map(rawReceipt=>{
    const r=object(rawReceipt,["constraintId","status","reason"],"constraint receipt");
    if(typeof r.constraintId!=="string"||
       !["satisfied","violated","indeterminate"].includes(String(r.status))||
       typeof r.reason!=="string"||!r.reason)
      reject("semantic-receipt-refused","constraint receipt fields");
    return Object.freeze(r) as unknown as SemanticConstraintReceipt;
  });
  exactSet(receipts.map(r=>r.constraintId),catalog.constraintIds,"semantic receipt membership");
  const mapping=object(result.mapping,["id","bindingGrade","unitPolicy","fidelity"],"semantic mapping");
  const fidelity=object(mapping.fidelity,["kind","reason"],"semantic fidelity");
  if(mapping.id!==catalog.mappingId||mapping.bindingGrade!==p.binding.grade||
     mapping.unitPolicy!==p.binding.unit||fidelity.kind!=="projection-only"||
     typeof fidelity.reason!=="string"||!fidelity.reason)
    reject("semantic-receipt-refused","semantic mapping fidelity");
  return Object.freeze({...result,facts:Object.freeze(facts),receipts:Object.freeze(receipts),
    mapping:Object.freeze({...mapping,fidelity:Object.freeze(fidelity)})}) as unknown as SemanticPackageReceipt;
}

export type SemanticClaimRequest=
  |Readonly<{kind:"native-reported-values"}>
  |Readonly<{kind:"source-coverage-limit"}>
  |Readonly<{kind:"physical-production-occurred"}>
  |Readonly<{kind:"reported-quantity";role:"erp"|"mes";quantity:string}>;
export type SemanticEvidenceClass="native-erp"|"native-mes"|"other-evidence";
export type SemanticRelation="supports"|"contradicts"|"related"|"irrelevant";
export interface SemanticClaimAssessment{
  readonly schema:"fde.semantic-claim-assessment/v1";readonly authority:"none";
  readonly claimId:string;readonly claim:string;
  readonly relations:readonly Readonly<{
    evidenceClass:SemanticEvidenceClass;relation:SemanticRelation;rationale:string;
  }>[];
}
export function assessSemanticClaim(raw:unknown,claim:SemanticClaimRequest,runtime:SemanticRuntime=bundledSemanticRuntime()):SemanticClaimAssessment{
  const p=admitCase(raw);
  const result=object(detach(invokeKernel({schema:"fde.claim-relation-request/v1",case:p,claim},runtime)),
    ["schema","authority","claimId","claim","relations"],"semantic claim assessment");
  if(result.schema!=="fde.semantic-claim-assessment/v1"||result.authority!=="none"||
     typeof result.claimId!=="string"||!result.claimId||
     typeof result.claim!=="string"||!result.claim||!Array.isArray(result.relations))
    reject("semantic-receipt-refused","semantic claim envelope");
  const allowedClasses=new Set<SemanticEvidenceClass>(["native-erp","native-mes","other-evidence"]);
  const allowedRelations=new Set<SemanticRelation>(["supports","contradicts","related","irrelevant"]);
  const seen=new Set<string>();
  const relations=result.relations.map(rawRelation=>{
    const r=object(rawRelation,["evidenceClass","relation","rationale"],"semantic relation");
    if(typeof r.evidenceClass!=="string"||!allowedClasses.has(r.evidenceClass as SemanticEvidenceClass)||
       seen.has(r.evidenceClass)||typeof r.relation!=="string"||
       !allowedRelations.has(r.relation as SemanticRelation)||
       typeof r.rationale!=="string"||!r.rationale)
      reject("semantic-receipt-refused","semantic relation fields");
    seen.add(r.evidenceClass);
    return Object.freeze(r) as unknown as SemanticClaimAssessment["relations"][number];
  });
  if(seen.size!==3)reject("semantic-receipt-refused","semantic relation completeness");
  return Object.freeze({...result,relations:Object.freeze(relations)}) as unknown as SemanticClaimAssessment;
}
