/** Read-only industry deliverables, derived from the selected Haskell catalog. */
import {investigationKinds,type InvestigationKind} from "./workbench-model.js";
import type {IndustrialCatalog,IndustrialAssessment} from "./industrial-client.js";
import type {WorkbenchCase,WorkbenchEvaluation} from "./workbench-store.js";

const names:Record<InvestigationKind,string>={
 reporting:"ERP/MES reporting reconciliation brief",
 "pdm-bom":"Engineering revision and BOM propagation review",
 "flow-setup":"Process flow and setup baseline",
 "quality-measurement":"Quality and measurement readiness brief",
 tooling:"Tooling and fixture review",
 layout:"Movement and layout investigation",
 maintenance:"Maintenance evidence and failure-history brief",
 "reporting-signage":"Metric-definition and signage governance brief"
};
export function buildIndustrySet(c:IndustrialCatalog){
 if(c?.schema!=="fde.industrial-catalog/v1"||c.authority!=="none"||
    !Array.isArray(c.entries)||c.entries.length!==investigationKinds.length)
   throw new TypeError("exact Haskell industrial catalog required");
 const known=new Set<string>(investigationKinds),seen=new Set<string>();
 for(const e of c.entries){
  if(!e||!known.has(e.id)||seen.has(e.id)||typeof e.question!=="string"||
     !Array.isArray(e.requiredInputs)||!Array.isArray(e.prerequisites)||
     !Array.isArray(e.possibleFindings)||!Array.isArray(e.limits))
   throw new TypeError("Haskell catalog family refused");
  seen.add(e.id);
 }
 return {schema:"fde.industry-set/v1" as const,authority:"none" as const,
  effects:[] as const,sourceWriteAllowed:false as const,owner:"haskell-industrial-catalog",
  families:c.entries.map(e=>({...e,deliverable:names[e.id as InvestigationKind]})),
  knowledge:{project:"fde",lane:"grounding-reference",state:"not-assessed" as const,
   sources:[] as readonly string[],next:"Owner-review FDE-specific procedures and vendor field definitions for the Knowledge grounding lane."},
  methodology:{title:"ASQ DMAIC",url:"https://asq.org/quality-resources/dmaic",
   authority:"public-method-reference-only" as const},
  note:"This industry set is a presentation of Haskell's catalog, not a second industrial classifier or approved company reference."};
}
export function buildIndustryBrief(saved:WorkbenchCase,catalog:IndustrialCatalog,
 evaluations:readonly WorkbenchEvaluation[],kernel:string){
 if(saved?.schema!=="fde.workbench-case/v1"||saved.authority!=="application-record-only"||
  saved.sourceWriteAllowed!==false||saved.document?.schema!=="fde.workbench-document/v1"||
  !Number.isSafeInteger(saved.version)||!Array.isArray(evaluations)||
  !/^[a-f0-9]{64}$/.test(kernel))throw new TypeError("exact saved FDE case and kernel required");
 const set=buildIndustrySet(catalog),doc=saved.document;
 const family=set.families.find(e=>e.id===doc.investigation.kind);
 if(!family)throw new TypeError("unsupported Haskell investigation family");
 for(const e of evaluations)if(e?.schema!=="fde.workbench-evaluation/v1"||
  e.caseId!==saved.caseId||e.authority!=="non-authoritative-diagnostic"||
  e.sourceWriteAllowed!==false)throw new TypeError("unqualified FDE assessment history");
 const pin=[...evaluations].reverse().find(e=>e.caseVersion===saved.version);
 let assessmentState="not-assessed",assessment:null|{
  evaluationId:string;kind:string;classification:string;totalFindings:number;
  findings:IndustrialAssessment["findings"];next:readonly string[];limitations:readonly string[]
 }=null;
 if(pin){
  if(pin.kernelSha256!==kernel)assessmentState="kernel-unverified";
  else{
   const r=pin.result as IndustrialAssessment;
   if(r?.schema!=="fde.industrial-assessment/v1"||r.authority!=="none"||
    r.vendorWriteAllowed!==false||r.physicalAcceptanceCertified!==false||
    !Array.isArray(r.findings)||!Array.isArray(r.nextInvestigations)||
    !Array.isArray(r.limitations))throw new TypeError("unqualified Haskell assessment");
   assessmentState="current-diagnostic";
   assessment={evaluationId:pin.evaluationId,kind:r.kind,classification:r.classification,
    totalFindings:r.findings.length,findings:r.findings.slice(0,6),
    next:r.nextInvestigations.slice(0,8),limitations:r.limitations.slice(0,6)};
  }
 }else if(evaluations.length)assessmentState="historical-only";
 return {schema:"fde.industry-brief/v1" as const,authority:"none" as const,
  effects:[] as const,sourceWriteAllowed:false as const,businessTruthAdmitted:false as const,
  physicalAcceptanceCertified:false as const,caseId:saved.caseId,caseVersion:saved.version,
  title:doc.title,phase:doc.investigation.phase,
  ownerAsRecorded:doc.engagement.processOwner,family,
  investigation:{problem:doc.investigation.problem,baseline:doc.investigation.baseline,
   measurementPlan:doc.investigation.measurementPlan,
   actions:doc.investigation.nextActions.map(a=>({...a}))},
  evidence:{status:"supplied-not-authenticated" as const,
   items:doc.evidence.map(e=>({...e,qualification:"unverified" as const})),
   count:doc.evidence.length},
  assessmentState,assessment,knowledge:set.knowledge,methodology:set.methodology,
  limitations:[
   "No live ERP/MES, PDM, equipment or other enterprise source was queried.",
   "Compiled Haskell results are bounded diagnostic candidates, not physical, business, or causal truth.",
   "No Knowledge source was queried, approved, or adopted for this case by the export.",
   "This method reference is not a company SOP, case evidence, or owner decision.",
   "No vendor write, release, employee payment, or machine effect is authorized."
  ]};
}
export type IndustryBrief=ReturnType<typeof buildIndustryBrief>;
const safe=(v:unknown):string=>String(v??"not recorded").replace(/[\x00-\x1f\x7f]+/g," ")
 .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
 .replace(/[\[\]()*_\x60]/g,(c:string)=>"\\"+c).slice(0,2000);
export function formatIndustryBriefMarkdown(b:IndustryBrief):string{
 if(b?.schema!=="fde.industry-brief/v1"||b.authority!=="none"||
  b.sourceWriteAllowed!==false||b.businessTruthAdmitted!==false)
  throw new TypeError("qualified industry brief required");
 const lines=[
  "# "+safe(b.family.deliverable),"",
  "Case: "+safe(b.title)+" · "+safe(b.caseId)+" · version "+b.caseVersion,
  "Industry: "+safe(b.family.title)+" · DMAIC phase "+safe(b.phase),
  "Process owner (recorded only): "+safe(b.ownerAsRecorded),"",
  "## Bounded question",safe(b.family.question),"",
  "Problem: "+safe(b.investigation.problem||"not recorded"),
  "Baseline: "+safe(b.investigation.baseline||"not recorded"),
  "Measurement: "+safe(b.investigation.measurementPlan||"not recorded"),"",
  "## Haskell catalog prerequisites",
  ...b.family.requiredInputs.map((x:string)=>"- [ ] "+safe(x)),"",
  "## Supplied evidence (not independently authenticated)",
  ...(b.evidence.items.length?b.evidence.items.map(e=>"- "+safe(e.id)+": "+
    safe(e.title)+" · "+safe(e.reference)+" · revision "+safe(e.revision)+
    " · "+safe(e.origin)+" · limits: "+safe(e.limitations||"none recorded")):
    ["- None supplied"]),"",
  "## Haskell result", "State: "+safe(b.assessmentState),
  ...(b.assessment?[
   "Assessment: "+safe(b.assessment.kind)+" · "+safe(b.assessment.classification),
   "Findings: "+b.assessment.totalFindings+" (up to six shown)",
   ...b.assessment.findings.map(f=>"- "+safe(f.status)+": "+safe(f.detail)),
   ...b.assessment.next.map((x:string)=>"- Investigate: "+safe(x))
  ]:["No same-version, same-kernel diagnostic is qualified for this packet."]),"",
  "## Owner actions",
  ...(b.investigation.actions.length?b.investigation.actions.map(a=>"- "+safe(a.status)+
    ": "+safe(a.action)+" · owner "+safe(a.owner)):["- Assign owner and next action"]),"",
  "## Knowledge references",
  "FDE-specific Knowledge source: "+safe(b.knowledge.state)+" (none adopted).",
  "Next: "+safe(b.knowledge.next),
  "General methodology, not case evidence: "+b.methodology.title+" — "+b.methodology.url,"",
  "## Limits",...b.limitations.map((x:string)=>"- "+safe(x)),"",
  "Result: CANDIDATE — HUMAN REVIEW REQUIRED. No external effects.",""
 ];
 const content=lines.join("\n");
 if(Buffer.byteLength(content)>60000)throw new TypeError("industry brief over budget");
 return content;
}
