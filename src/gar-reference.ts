/** Experimental FDE -> GAR reference projection.
 * GAR may supply source-bound reference candidates. It cannot change FDE semantic
 * admission, source truth, review authority, or vendor effect permissions.
 */
import type {WorkspaceCase} from "./workspace.js";

export const fdeGarReferenceQuery =
  "ERP MES reported quantities physical production inventory posting source evidence";

const HEX=/^sha256:[a-f0-9]{64}$/;
const REFERENCE_KINDS=new Set(["source","observation","principle","decision","project-rule"]);

type RecordValue=Record<string,unknown>;
function record(value:unknown,label:string):RecordValue{
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error(label+"-refused");
  return value as RecordValue;
}
function closed(value:RecordValue,keys:readonly string[],label:string):void{
  if(Object.keys(value).some(key=>!keys.includes(key)))throw Error(label+"-extra-field-refused");
}
function text(value:unknown,label:string,max=16384):string{
  if(typeof value!=="string"||!value||value.length>max||value.includes("\0"))throw Error(label+"-refused");
  return value;
}
function integer(value:unknown,label:string,min=0,max=Number.MAX_SAFE_INTEGER):number{
  if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw Error(label+"-refused");
  return Number(value);
}
function metadata(value:unknown):Readonly<Record<string,string|readonly string[]>>{
  const raw=record(value,"gar-source-metadata");
  if(Object.keys(raw).length>80)throw Error("gar-source-metadata-refused");
  const out:Record<string,string|readonly string[]>={};
  for(const [key,item] of Object.entries(raw)){
    if(!/^[a-z][a-z0-9_-]*$/.test(key))throw Error("gar-source-metadata-refused");
    if(typeof item==="string"&&item.length<=1024)out[key]=item;
    else if(Array.isArray(item)&&item.length<=64&&item.every(v=>typeof v==="string"&&v.length<=256))
      out[key]=Object.freeze([...item] as string[]);
    else throw Error("gar-source-metadata-refused");
  }
  return Object.freeze(out);
}

export interface FdeGarReferenceCandidate{
  readonly id:string;
  readonly title:string;
  readonly kind:string;
  readonly sourcePath:string;
  readonly sourceDigest:string;
  readonly passageDigest:string;
  readonly startByte:number;
  readonly endByte:number;
  readonly text:string;
  readonly rank:number;
  readonly score:number;
  readonly epistemic:string;
  readonly lifecycle:string;
  readonly sourceAuthorityLabel:string;
}
export interface FdeGarWithheldReference{
  readonly id:string;
  readonly passageDigest:string;
  readonly reasons:readonly string[];
}
export interface FdeGarReferencePanel{
  readonly schema:"fde.gar-reference-panel/v1";
  readonly authority:"none";
  readonly observationId:string;
  readonly query:string;
  readonly sourceIndexDigest:string;
  readonly answerability:"not-verified";
  readonly groundingStatus:"candidate-only";
  readonly referenceCandidates:readonly FdeGarReferenceCandidate[];
  readonly withheld:readonly FdeGarWithheldReference[];
  readonly claimSupportEstablished:false;
  readonly semanticAdmissionAffected:false;
  readonly reviewAuthority:false;
  readonly businessTruthAdmitted:false;
  readonly sourceWriteAllowed:false;
  readonly humanReviewRequired:true;
}

function candidate(raw:unknown):FdeGarReferenceCandidate{
  const e=record(raw,"gar-evidence");
  closed(e,["id","sourcePath","sourceDigest","passageDigest","startByte","endByte","text","rank","score","sourceDescriptor"],"gar-evidence");
  const d=record(e.sourceDescriptor,"gar-source-descriptor");
  closed(d,["kind","title","metadata"],"gar-source-descriptor");
  const m=metadata(d.metadata);
  const sourceDigest=text(e.sourceDigest,"gar-source-digest",80);
  const passageDigest=text(e.passageDigest,"gar-passage-digest",80);
  if(!HEX.test(sourceDigest)||!HEX.test(passageDigest))throw Error("gar-digest-refused");
  const score=Number(e.score);
  if(!Number.isFinite(score))throw Error("gar-score-refused");
  return Object.freeze({
    id:text(e.id,"gar-evidence-id",128),
    title:text(d.title,"gar-source-title",1024),
    kind:text(d.kind,"gar-source-kind",80),
    sourcePath:text(e.sourcePath,"gar-source-path",4096),
    sourceDigest,passageDigest,
    startByte:integer(e.startByte,"gar-start-byte"),
    endByte:integer(e.endByte,"gar-end-byte"),
    text:text(e.text,"gar-evidence-text",65536),
    rank:integer(e.rank,"gar-rank",1,20),
    score,
    epistemic:typeof m.epistemic==="string"?m.epistemic:"unknown",
    lifecycle:typeof m.lifecycle==="string"?m.lifecycle:"unknown",
    sourceAuthorityLabel:typeof m.authority==="string"?m.authority:"unknown"
  });
}

export function projectGarReferenceContext(c:WorkspaceCase,raw:unknown):FdeGarReferencePanel{
  if(c.schema!=="fde.connected-case/v1"||c.authority!=="none"||
     c.observationScope.sourceWriteAllowed!==false||c.observationScope.businessTruthAdmitted!==false)
    throw Error("fde-gar-case-refused");
  const top=record(raw,"gar-context");
  closed(top,["schema","authority","retrieval","context","groundingStatus","answerability"],"gar-context");
  if(top.schema!=="gar.knowledge-context/v1"||top.authority!=="none"||
     top.answerability!=="not-verified"||top.groundingStatus!=="candidate-only")
    throw Error("fde-gar-envelope-refused");
  const retrieval=record(top.retrieval,"gar-retrieval");
  closed(retrieval,["schema","authority","source","sourceToolState","query","asOf","limit","answerability","groundingStatus","evidence","omissions"],"gar-retrieval");
  if(retrieval.schema!=="gar.knowledge-retrieval/v1"||retrieval.authority!=="none"||
     retrieval.answerability!=="not-verified"||retrieval.groundingStatus!=="candidate-only"||
     retrieval.query!==fdeGarReferenceQuery)throw Error("fde-gar-retrieval-refused");
  const source=record(retrieval.source,"gar-source");
  closed(source,["kind","indexDigest","corpusLane","project"],"gar-source");
  const indexDigest=text(source.indexDigest,"gar-index-digest",80);
  if(source.kind!=="knowledge-next"||source.corpusLane!=="grounding-reference"||
     source.project!=="fde"||!HEX.test(indexDigest))throw Error("fde-gar-source-refused");
  const sourceTool=record(retrieval.sourceToolState,"gar-source-tool-state");
  if(sourceTool.schema!=="knowledge-next.tool-state/v1"||sourceTool.authority!=="none")
    throw Error("fde-gar-source-tool-state-refused");
  const toolInfo=record(sourceTool.information,"gar-source-tool-information");
  const toolEvidence=record(sourceTool.evidence,"gar-source-tool-evidence");
  const toolComposition=record(sourceTool.composition,"gar-source-tool-composition");
  if(toolInfo.corpusLane!=="grounding-reference"||toolInfo.project!=="fde"||
     toolEvidence.sourceIndexDigest!==indexDigest||toolEvidence.storeState!=="current"||
     toolComposition.grantsAuthority!==false||
     toolComposition.establishesAnswerability!==false||
     toolComposition.selectsSemanticWinner!==false)
    throw Error("fde-gar-source-tool-state-refused");
  const context=record(top.context,"gar-bounded-context");
  closed(context,["schema","authority","maxItems","maxBytes","usedBytes","included","omitted"],"gar-bounded-context");
  if(context.schema!=="gar.context/v1"||context.authority!=="none"||
     !Array.isArray(context.included)||context.included.length>8)
    throw Error("fde-gar-bounded-context-refused");
  integer(context.maxItems,"gar-max-items",1,20);
  const maxBytes=integer(context.maxBytes,"gar-max-bytes",256,65536);
  const usedBytes=integer(context.usedBytes,"gar-used-bytes",0,maxBytes);
  void usedBytes;

  const references:FdeGarReferenceCandidate[]=[];
  const withheld:FdeGarWithheldReference[]=[];
  for(const item of context.included){
    const ref=candidate(item),reasons:string[]=[];
    if(ref.epistemic!=="supported")reasons.push("knowledge-epistemic-not-supported");
    if(ref.lifecycle!=="active")reasons.push("knowledge-lifecycle-not-active");
    if(!REFERENCE_KINDS.has(ref.kind))reasons.push("knowledge-kind-not-reference");
    if(reasons.length)withheld.push(Object.freeze({id:ref.id,passageDigest:ref.passageDigest,reasons:Object.freeze(reasons)}));
    else references.push(ref);
  }
  return Object.freeze({
    schema:"fde.gar-reference-panel/v1",authority:"none",observationId:c.observationId,
    query:fdeGarReferenceQuery,sourceIndexDigest:indexDigest,
    answerability:"not-verified",groundingStatus:"candidate-only",
    referenceCandidates:Object.freeze(references),withheld:Object.freeze(withheld),
    claimSupportEstablished:false,semanticAdmissionAffected:false,reviewAuthority:false,
    businessTruthAdmitted:false,sourceWriteAllowed:false,humanReviewRequired:true
  });
}
