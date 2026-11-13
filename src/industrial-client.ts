/** Bounded transport for the selected pure industrial semantic owner. No domain inference lives here. */
import {bundledSemanticRuntime,type SemanticRuntime} from "./semantic-runtime.js";
import {detach,detachIndustrialResponse,object,parseIndustrialResponseJson,reject,string} from "./json.js";

export interface IndustrialAssessment {
  readonly schema:"fde.industrial-assessment/v1";
  readonly kind:string;readonly classification:string;
  readonly findings:readonly {readonly code:string;readonly status:"supported"|"unresolved"|"contradicted";
    readonly detail:string;readonly evidenceRefs:readonly string[]}[];
  readonly metrics:readonly {readonly id:string;readonly numerator:string;readonly denominator:string;readonly unit:string}[];
  readonly nextInvestigations:readonly string[];readonly limitations:readonly string[];
  readonly authority:"none";readonly vendorWriteAllowed:false;readonly physicalAcceptanceCertified:false;
}
export interface IndustrialCatalog {
  readonly schema:"fde.industrial-catalog/v1";readonly authority:"none";
  readonly entries:readonly {readonly id:string;readonly title:string;readonly concern:string;readonly question:string;
    readonly requiredInputs:readonly string[];readonly prerequisites:readonly string[];
    readonly possibleFindings:readonly string[];readonly limits:readonly string[]}[];
}
function invoke(request:unknown,runtime:SemanticRuntime):unknown {
  const input=JSON.stringify(detach(request));
  if(Buffer.byteLength(input)>131072)reject("industrial-input-budget","industrial request");
  const run=runtime.invoke(input,2097152);
  if(run.error||run.status!==0||!run.stdout||run.stderr.length>0)
    reject("industrial-kernel-unavailable","selected compiled semantic owner failed");
  const raw=parseIndustrialResponseJson(run.stdout);
  if(raw&&typeof raw==="object"&&!Array.isArray(raw)&&(raw as Record<string,unknown>).ok===false){
    const failure=object(raw,["ok","error"],"industrial refusal");
    reject("industrial-input-refused",string(failure.error,"industrial error",200));
  }
  const success=object(raw,["ok","result"],"industrial envelope");
  if(success.ok!==true)reject("industrial-receipt-refused","missing success result");
  return success.result;
}
function texts(value:unknown,label:string):readonly string[]{
  if(!Array.isArray(value)||value.length>128)reject("industrial-receipt-refused",label);
  return Object.freeze(value.map(v=>string(v,label,8192)));
}
function unique(values:readonly string[],label:string):void {
  if(new Set(values).size!==values.length)reject("industrial-receipt-refused",label);
}
function prose(value:unknown,label:string):string {
  if(typeof value!=="string"||!value||value.length>8192||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    reject("industrial-receipt-refused",label);
  return value;
}
export function assessIndustrial(request:unknown,runtime:SemanticRuntime=bundledSemanticRuntime()):IndustrialAssessment {
  const result=object(invoke(request,runtime),["schema","kind","classification","findings","metrics","nextInvestigations","limitations","authority","vendorWriteAllowed","physicalAcceptanceCertified"],"industrial assessment");
  if(result.schema!=="fde.industrial-assessment/v1"||result.authority!=="none"||result.vendorWriteAllowed!==false||result.physicalAcceptanceCertified!==false||!Array.isArray(result.findings)||!Array.isArray(result.metrics))
    reject("industrial-receipt-refused","industrial authority boundary");
  const findings=result.findings.map(raw=>{
    const f=object(raw,["code","status","detail","evidenceRefs"],"industrial finding");
    if(typeof f.status!=="string"||!["supported","unresolved","contradicted"].includes(f.status))reject("industrial-receipt-refused","finding status");
    return {code:string(f.code,"finding code",1024),status:f.status,detail:prose(f.detail,"finding detail"),evidenceRefs:texts(f.evidenceRefs,"evidence references")};
  });
  const metrics=result.metrics.map(raw=>{
    const m=object(raw,["id","numerator","denominator","unit"],"industrial metric");
    if(typeof m.numerator!=="string"||!(/^-?(0|[1-9][0-9]*)$/).test(m.numerator)||typeof m.denominator!=="string"||!(/^[1-9][0-9]*$/).test(m.denominator))
      reject("industrial-receipt-refused","exact metric encoding");
    return {id:string(m.id,"metric id",1024),numerator:m.numerator,denominator:m.denominator,unit:string(m.unit,"metric unit",512)};
  });
  unique(findings.map(f=>f.code),"finding identity");unique(metrics.map(m=>m.id),"metric identity");
  const value={...result,kind:string(result.kind,"assessment kind"),classification:string(result.classification,"assessment classification"),
    findings,metrics,nextInvestigations:texts(result.nextInvestigations,"next investigations"),limitations:texts(result.limitations,"assessment limits")};
  return detachIndustrialResponse(value) as unknown as IndustrialAssessment;
}
export function industrialCatalog(runtime:SemanticRuntime=bundledSemanticRuntime()):IndustrialCatalog {
  const result=object(invoke({schema:"fde.industrial-catalog-request/v1"},runtime),["schema","entries","authority"],"industrial catalog");
  if(result.schema!=="fde.industrial-catalog/v1"||result.authority!=="none"||!Array.isArray(result.entries)||!result.entries.length)
    reject("industrial-receipt-refused","industrial catalog envelope");
  const entries=result.entries.map(raw=>{
    const e=object(raw,["id","title","concern","question","requiredInputs","prerequisites","possibleFindings","limits"],"catalog entry");
    return {id:string(e.id,"catalog id"),title:string(e.title,"catalog title",500),concern:string(e.concern,"catalog concern"),question:string(e.question,"catalog question",2000),
      requiredInputs:texts(e.requiredInputs,"required inputs"),prerequisites:texts(e.prerequisites,"prerequisites"),possibleFindings:texts(e.possibleFindings,"possible findings"),limits:texts(e.limits,"catalog limits")};
  });
  unique(entries.map(e=>e.id),"catalog identity");
  return detach({...result,entries}) as unknown as IndustrialCatalog;
}
