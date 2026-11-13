import {createHash} from "node:crypto";
import {detach} from "./json.js";
import type {WorkspaceCase} from "./workspace.js";
import {assessSemanticClaim,type SemanticEvidenceClass} from "./semantic-client.js";

export type FdeGarClaimKind=
  "native-reported-values"|"source-coverage-limit"|"physical-production-occurred";

export interface FdeGarEvidence {
  readonly id:string;
  readonly sourcePath:string;
  readonly sourceDigest:string;
  readonly passageDigest:string;
  readonly startByte:number;
  readonly endByte:number;
  readonly text:string;
  readonly rank:number;
  readonly score:number;
  readonly sourceDescriptor:Readonly<{
    kind:"native-observation";
    title:string;
    metadata:Readonly<Record<string,string|ReadonlyArray<string>>>;
  }>;
}
export interface FdeGarClaimProposal {
  readonly claimId:string;
  readonly claim:string;
  readonly retrievedIds:ReadonlyArray<string>;
  readonly relations:ReadonlyArray<{
    readonly evidenceId:string;
    readonly relation:"supports"|"related"|"contradicts"|"irrelevant";
    readonly assessor:Readonly<{id:"fde-haskell-semantic";version:"v1";kind:"deterministic"}>;
    readonly rationale:string;
  }>;
  readonly assessmentComplete:true;
}
export interface FdeGarSupportPanel {
  readonly schema:"fde.gar-support-panel/v1";
  readonly authority:"none";
  readonly observationId:string;
  readonly claimId:string;
  readonly claim:string;
  readonly state:"supported"|"partial"|"conflict"|"no-answer"|"unknown";
  readonly supportingIds:ReadonlyArray<string>;
  readonly relatedIds:ReadonlyArray<string>;
  readonly conflictingIds:ReadonlyArray<string>;
  readonly abstentionRequired:boolean;
  readonly claimSupportEstablished:boolean;
  readonly semanticAdmissionAffected:false;
  readonly reviewAuthority:false;
  readonly businessTruthAdmitted:false;
  readonly sourceWriteAllowed:false;
  readonly humanReviewRequired:true;
}

const hash=(value:string)=>"sha256:"+createHash("sha256").update(value).digest("hex");
const stable=(value:unknown):string=>{
  if(Array.isArray(value))return "["+value.map(stable).join(",")+"]";
  if(value&&typeof value==="object"){
    return "{"+Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b))
      .map(([k,v])=>JSON.stringify(k)+":"+stable(v)).join(",")+"}";
  }
  return JSON.stringify(value);
};
function evidenceText(role:"erp"|"mes",c:WorkspaceCase):string{
  const s=c.sources[role];
  return [
    role==="erp"?"ERPNext native order observation":"OpenMES native order observation",
    `observationId=${c.observationId}`,
    `role=${role}`,
    `vendor=${s.vendor}`,
    `instance=${s.instance}`,
    `nativeId=${s.nativeId}`,
    `businessId=${s.businessId}`,
    `revision=${s.revision}`,
    `nativeState=${s.nativeState}`,
    `planned=${s.planned} ${s.unit}`,
    `reported=${s.reported} ${s.unit}`,
    `coverage.order=${s.coverage.order}`,
    `coverage.receipt=${s.coverage.receipt}`,
    `coverage.ledger=${s.coverage.ledger}`,
    `coverage.physical=${s.coverage.physical}`,
    `capture.mode=${s.capture.mode}`,
    `capture.observedAt=${s.capture.observedAt}`,
    `capture.transport=${s.capture.transport}`,
    `capture.querySha256=${s.capture.querySha256}`
  ].join("\n");
}
export function projectFdeNativeGarEvidence(c:WorkspaceCase):ReadonlyArray<FdeGarEvidence>{
  if(c.schema!=="fde.connected-case/v1"||c.authority!=="none"||
     c.observationScope.sourceWriteAllowed!==false||c.observationScope.businessTruthAdmitted!==false)
    throw Error("fde-gar-native-case-refused");
  return Object.freeze((["erp","mes"] as const).map((role,index)=>{
    const s=c.sources[role],text=evidenceText(role,c);
    const sourceBody={
      observationId:c.observationId,role,vendor:s.vendor,instance:s.instance,
      nativeId:s.nativeId,businessId:s.businessId,revision:s.revision,
      nativeState:s.nativeState,planned:s.planned,reported:s.reported,unit:s.unit,
      coverage:s.coverage,capture:s.capture
    };
    return Object.freeze({
      id:`fde-native:${role}:${c.observationId}`,
      sourcePath:`fde/native/${role}/${s.nativeId}`,
      sourceDigest:hash(stable(sourceBody)),
      passageDigest:hash(text),startByte:0,endByte:Buffer.byteLength(text),
      text,rank:index+1,score:1,
      sourceDescriptor:Object.freeze({
        kind:"native-observation" as const,
        title:role==="erp"?"ERPNext exact native order row":"OpenMES exact native order row",
        metadata:Object.freeze({
          project:"fde",role,vendor:s.vendor,epistemic:"observed",lifecycle:"captured-snapshot",
          source_currentness:"not-verified",authority:"none",data_class:c.dataClass,
          observation_id:c.observationId,source_instance:s.instance,native_id:s.nativeId,
          business_id:s.businessId,source_revision:s.revision,observed_at:s.capture.observedAt,
          query_sha256:s.capture.querySha256,capture_mode:s.capture.mode,unit:s.unit,
          coverage:["order:exact-native-row","receipt:not-covered","ledger:not-covered","physical:not-covered"]
        })
      })
    });
  }));
}

function semanticInput(c:WorkspaceCase):unknown{
  const source=(role:"erp"|"mes")=>{
    const s=c.sources[role];
    return {
      schema:"fde.native-observation/v1",dataClass:c.dataClass,role,vendor:s.vendor,
      instance:s.instance,nativeId:s.nativeId,businessId:s.businessId,revision:s.revision,
      nativeState:s.nativeState,planned:s.planned,reported:s.reported,unit:s.unit,
      coverage:s.coverage,capture:s.capture
    };
  };
  return {
    schema:"fde.case/v1",erp:source("erp"),mes:source("mes"),
    binding:{
      schema:"fde.native-binding/v1",grade:c.binding.grade,unit:c.binding.unit,
      erp:c.binding.erp,mes:c.binding.mes
    }
  };
}

export function proposeFdeGarRelations(c:WorkspaceCase,kind:FdeGarClaimKind,
  evidence:ReadonlyArray<{readonly id:string;readonly passageDigest:string;readonly sourceDescriptor?:{readonly kind:string}}>):FdeGarClaimProposal{
  const exact=(item:{readonly id:string;readonly passageDigest:string})=>item.id+":"+item.passageDigest;
  // A plausible ID + passage digest alone never proves the passed role, text,
  // query/revision descriptor or source identity. Verify the exact native FDE
  // projections before accepting Haskell evidence classifications.
  const supplied=detach(evidence) as typeof evidence;
  if(!Array.isArray(supplied)||supplied.length>64)
    throw Error("fde-gar-native-selection-refused");
  const nativeEvidence=projectFdeNativeGarEvidence(c);
  const nativeClassById=new Map<string,SemanticEvidenceClass>([
    [exact(nativeEvidence[0]!),"native-erp"],
    [exact(nativeEvidence[1]!),"native-mes"]
  ]);
  const nativeIds=new Set(nativeEvidence.map(x=>x.id));
  for(const item of supplied){
    if((item.id.startsWith("fde-native:")||item.sourceDescriptor?.kind==="native-observation")&&
       !nativeIds.has(item.id))
      throw Error("fde-gar-foreign-native-evidence-refused");
  }
  for(const ref of nativeEvidence){
    const matches=supplied.filter(x=>x.id===ref.id);
    if(matches.length!==1)throw Error("fde-gar-native-evidence-missing-or-duplicated");
    const item=matches[0]! as typeof matches[number]&Partial<FdeGarEvidence>;
    if(item.passageDigest!==ref.passageDigest||
       item.sourceDigest!==ref.sourceDigest||
       item.sourcePath!==ref.sourcePath||
       item.startByte!==ref.startByte||item.endByte!==ref.endByte||
       item.text!==ref.text||item.sourceDescriptor?.kind!=="native-observation"||
       item.sourceDescriptor.title!==ref.sourceDescriptor.title||
       stable(item.sourceDescriptor.metadata)!==stable(ref.sourceDescriptor.metadata))
      throw Error("fde-gar-native-evidence-substituted");
  }
  const assessment=assessSemanticClaim(semanticInput(c),{kind});
  const byClass=new Map(assessment.relations.map(r=>[r.evidenceClass,r] as const));
  const assessor=Object.freeze({id:"fde-haskell-semantic" as const,version:"v1" as const,kind:"deterministic" as const});
  const relations=supplied.map(item=>{
    const evidenceId=exact(item);
    const evidenceClass=nativeClassById.get(evidenceId)??"other-evidence";
    const semantic=byClass.get(evidenceClass);
    if(!semantic)throw Error("fde-gar-semantic-relation-missing");
    return Object.freeze({
      evidenceId,relation:semantic.relation,assessor,rationale:semantic.rationale
    });
  });
  return Object.freeze({
    claimId:assessment.claimId,claim:assessment.claim,
    retrievedIds:Object.freeze(supplied.map(exact)),
    relations:Object.freeze(relations),assessmentComplete:true as const
  });
}

type R=Record<string,unknown>;
const obj=(x:unknown,label:string):R=>{
  if(!x||typeof x!=="object"||Array.isArray(x))throw Error(label+"-refused");
  return x as R;
};
const strings=(x:unknown,label:string):ReadonlyArray<string>=>{
  if(!Array.isArray(x)||x.some(v=>typeof v!=="string"))throw Error(label+"-refused");
  return Object.freeze([...x] as string[]);
};
export function projectFdeGarSupport(c:WorkspaceCase,raw:unknown,
  expected:FdeGarClaimProposal):FdeGarSupportPanel{
  const top=obj(raw,"fde-gar-support");
  if(top.schema!=="gar.claim-support/v1"||top.authority!=="none"||
     top.claimId!==expected.claimId||top.claim!==expected.claim||
     top.semanticWinnerSelected!==false||typeof top.abstentionRequired!=="boolean")
    throw Error("fde-gar-support-envelope-refused");
  const retrieved=strings(top.retrievedIds,"fde-gar-support-retrieved");
  if(JSON.stringify(retrieved)!==JSON.stringify(expected.retrievedIds))
    throw Error("fde-gar-support-evidence-refused");
  const assessment=obj(top.assessment,"fde-gar-support-assessment");
  if(assessment.schema!=="gar.evidence-assessment/v1"||assessment.authority!=="none"||
     !["supported","partial","conflict","no-answer","unknown"].includes(String(assessment.state))||
     assessment.assessmentComplete!==true)
    throw Error("fde-gar-support-assessment-refused");
  const supportingIds=strings(assessment.supportingIds,"fde-gar-supporting");
  const relatedIds=strings(assessment.relatedIds,"fde-gar-related");
  const conflictingIds=strings(assessment.conflictingIds,"fde-gar-conflicting");
  const state=assessment.state as FdeGarSupportPanel["state"];
  if(top.abstentionRequired!==(state!=="supported"))
    throw Error("fde-gar-support-abstention-refused");
  const allowed=new Set(expected.retrievedIds);
  if([...supportingIds,...relatedIds,...conflictingIds].some(id=>!allowed.has(id)))
    throw Error("fde-gar-support-evidence-refused");
  return Object.freeze({
    schema:"fde.gar-support-panel/v1",authority:"none",observationId:c.observationId,
    claimId:expected.claimId,claim:expected.claim,state,
    supportingIds,relatedIds,conflictingIds,
    abstentionRequired:top.abstentionRequired as boolean,
    claimSupportEstablished:state==="supported",
    semanticAdmissionAffected:false,reviewAuthority:false,businessTruthAdmitted:false,
    sourceWriteAllowed:false,humanReviewRequired:true
  });
}
