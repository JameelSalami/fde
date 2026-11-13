/** Finite application-owned investigation records. They do not establish source or domain truth. */
import {detach,object} from "./json.js";
import {ReviewError} from "./review-store.js";

export const investigationKinds=["reporting","pdm-bom","flow-setup","quality-measurement","tooling","layout","maintenance","reporting-signage"] as const;
export type InvestigationKind=typeof investigationKinds[number];
export type DmaicPhase="define"|"measure"|"analyze"|"improve"|"control";
export interface WorkbenchDocument {
  readonly schema:"fde.workbench-document/v1";
  readonly title:string;
  readonly engagement:{readonly organization:string;readonly sponsor:string;readonly processOwner:string;
    readonly scope:string;readonly decision:string;
    readonly systems:readonly {readonly id:string;readonly name:string;readonly owner:string;readonly purpose:string}[];
    readonly affectedGroups:readonly {readonly id:string;readonly name:string;readonly concern:string}[];
    readonly permissionRecords:readonly {readonly sourceId:string;readonly approver:string;readonly reference:string;readonly validUntil:string;readonly notes:string}[];
    readonly localObservationOwner:string;readonly dataHandling:string};
  readonly investigation:{readonly kind:InvestigationKind;readonly phase:DmaicPhase;
    readonly problem:string;readonly baseline:string;readonly measurementPlan:string;
    readonly hypotheses:readonly {readonly id:string;readonly explanation:string;readonly supportingEvidence:readonly string[];
      readonly contradictingEvidence:readonly string[];readonly status:"open"|"supported"|"contradicted"|"unresolved"}[];
    readonly nextActions:readonly {readonly id:string;readonly action:string;readonly owner:string;readonly dueDate:string;readonly status:"pending"|"done"|"blocked"}[]};
  readonly evidence:readonly {readonly id:string;readonly title:string;readonly reference:string;readonly revision:string;
    readonly observedAt:string;readonly origin:"synthetic"|"manual-reference";readonly limitations:string}[];
  readonly engineering:{readonly requirements:string;readonly designReferences:string;readonly inspectionPlan:string;
    readonly localChecks:string;readonly alternatives:string;readonly reviewOwner:string;readonly disposition:"pending"|"reviewed"|"needs-investigation"};
  readonly improvement:{readonly alternatives:string;readonly proposal:string;readonly approver:string;
    readonly decision:"pending"|"approved"|"rejected"|"revise"|"abandoned";readonly decisionReference:string;
    readonly pilotPlan:string;readonly acceptanceMeasures:string;readonly implementationRecord:string;readonly adverseEffects:string;
    readonly controlPlan:string;readonly reactionPlan:string;readonly handoffOwner:string};
  readonly workerOutcomes:{readonly requests:string;readonly affectedGroups:string;readonly contributionEvidence:string;
    readonly workloadImplications:string;readonly earningsImplications:string;readonly proposedBenefits:string;
    readonly commitmentAuthority:string;readonly commitmentReference:string;readonly deliveryEvidence:string;readonly disputes:string};
  /** Opaque transport to the compiled Haskell owner; this module does not interpret its meaning. */
  readonly semanticInput:unknown;
}

export function emptyWorkbenchDocument():WorkbenchDocument {
  return {schema:"fde.workbench-document/v1",title:"New investigation",
    engagement:{organization:"",sponsor:"",processOwner:"",scope:"",decision:"",systems:[],affectedGroups:[],permissionRecords:[],localObservationOwner:"",dataHandling:""},
    investigation:{kind:"reporting",phase:"define",problem:"",baseline:"",measurementPlan:"",hypotheses:[],nextActions:[]},evidence:[],
    engineering:{requirements:"",designReferences:"",inspectionPlan:"",localChecks:"",alternatives:"",reviewOwner:"",disposition:"pending"},
    improvement:{alternatives:"",proposal:"",approver:"",decision:"pending",decisionReference:"",pilotPlan:"",acceptanceMeasures:"",implementationRecord:"",adverseEffects:"",controlPlan:"",reactionPlan:"",handoffOwner:""},
    workerOutcomes:{requests:"",affectedGroups:"",contributionEvidence:"",workloadImplications:"",earningsImplications:"",proposedBenefits:"",commitmentAuthority:"",commitmentReference:"",deliveryEvidence:"",disputes:""},
    semanticInput:{schema:"fde.industrial-assessment-request/v1",investigation:{kind:"triage",concern:"reporting-discrepancy",availableEvidence:[],measurementReady:false,workerConcern:true}}};
}
/** Transport assembly only. Haskell resolves evidence references and their meaning. */
export function workbenchAssessmentRequest(document:WorkbenchDocument):unknown{
  return {schema:"fde.industrial-case-assessment-request/v1",request:document.semanticInput,
    evidenceInventory:document.evidence.map(({id,origin,revision,observedAt,limitations,reference})=>({id,origin,revision,observedAt,limitations,reference}))};
}
function bad():never{throw new ReviewError(400,"invalid-workbench-document");}
function text(value:unknown,max=2000):string{if(typeof value!=="string"||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))bad();return value;}
function id(value:unknown):string{const s=text(value,96);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s))bad();return s;}
function choice<T extends string>(value:unknown,choices:readonly T[]):T{if(typeof value!=="string"||!choices.includes(value as T))bad();return value as T;}
function array(value:unknown,max=32):readonly unknown[]{if(!Array.isArray(value)||value.length>max)bad();return value;}
function rows(value:unknown,keys:readonly string[],check:(row:Record<string,unknown>)=>void):void{
  const seen=new Set<string>();for(const raw of array(value)){const row=object(raw,keys,"workbench row");if(keys.includes("id")){const v=id(row.id);if(seen.has(v))bad();seen.add(v);}check(row);}
}
function texts(row:Record<string,unknown>,keys:readonly string[]):void{for(const key of keys)text(row[key]);}
export function parseWorkbenchDocument(raw:unknown):WorkbenchDocument{
  try{
    const value=detach(raw),d=object(value,["schema","title","engagement","investigation","evidence","engineering","improvement","workerOutcomes","semanticInput"],"workbench document");
    if(d.schema!=="fde.workbench-document/v1"||!text(d.title,160).trim())bad();
    const e=object(d.engagement,["organization","sponsor","processOwner","scope","decision","systems","affectedGroups","permissionRecords","localObservationOwner","dataHandling"],"engagement");
    texts(e,["organization","sponsor","processOwner","scope","decision","localObservationOwner","dataHandling"]);
    rows(e.systems,["id","name","owner","purpose"],r=>texts(r,["name","owner","purpose"]));
    rows(e.affectedGroups,["id","name","concern"],r=>texts(r,["name","concern"]));
    rows(e.permissionRecords,["sourceId","approver","reference","validUntil","notes"],r=>{id(r.sourceId);texts(r,["approver","reference","validUntil","notes"]);});
    const i=object(d.investigation,["kind","phase","problem","baseline","measurementPlan","hypotheses","nextActions"],"investigation");
    choice(i.kind,investigationKinds);choice(i.phase,["define","measure","analyze","improve","control"]);texts(i,["problem","baseline","measurementPlan"]);
    rows(i.hypotheses,["id","explanation","supportingEvidence","contradictingEvidence","status"],r=>{text(r.explanation);choice(r.status,["open","supported","contradicted","unresolved"]);for(const key of ["supportingEvidence","contradictingEvidence"])for(const ref of array(r[key]))text(ref,500);});
    rows(i.nextActions,["id","action","owner","dueDate","status"],r=>{texts(r,["action","owner","dueDate"]);choice(r.status,["pending","done","blocked"]);});
    rows(d.evidence,["id","title","reference","revision","observedAt","origin","limitations"],r=>{texts(r,["title","reference","revision","observedAt","limitations"]);choice(r.origin,["synthetic","manual-reference"]);});
    const eng=object(d.engineering,["requirements","designReferences","inspectionPlan","localChecks","alternatives","reviewOwner","disposition"],"engineering");
    texts(eng,["requirements","designReferences","inspectionPlan","localChecks","alternatives","reviewOwner"]);choice(eng.disposition,["pending","reviewed","needs-investigation"]);
    const im=object(d.improvement,["alternatives","proposal","approver","decision","decisionReference","pilotPlan","acceptanceMeasures","implementationRecord","adverseEffects","controlPlan","reactionPlan","handoffOwner"],"improvement");
    texts(im,["alternatives","proposal","approver","decisionReference","pilotPlan","acceptanceMeasures","implementationRecord","adverseEffects","controlPlan","reactionPlan","handoffOwner"]);choice(im.decision,["pending","approved","rejected","revise","abandoned"]);
    const w=object(d.workerOutcomes,["requests","affectedGroups","contributionEvidence","workloadImplications","earningsImplications","proposedBenefits","commitmentAuthority","commitmentReference","deliveryEvidence","disputes"],"worker outcomes");
    texts(w,Object.keys(w));
    if(!d.semanticInput||typeof d.semanticInput!=="object"||Array.isArray(d.semanticInput))bad();
    if(Buffer.byteLength(JSON.stringify(value))>98304)bad();
    return value as unknown as WorkbenchDocument;
  }catch(error){if(error instanceof ReviewError)throw error;return bad();}
}
export function parseActionId(raw:unknown):string{if(typeof raw!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(raw))throw new ReviewError(400,"invalid-workbench-action-id");return raw;}
export function parseCaseId(raw:unknown):string{if(typeof raw!=="string"||!/^case-[a-f0-9-]{36}$/.test(raw))throw new ReviewError(400,"invalid-workbench-case-id");return raw;}
export function parseExpectedVersion(raw:unknown):number{if(!Number.isSafeInteger(raw)||Number(raw)<0)throw new ReviewError(400,"invalid-workbench-version");return Number(raw);}
export function parsePrivateNote(raw:unknown):string{return text(raw,8000);}
