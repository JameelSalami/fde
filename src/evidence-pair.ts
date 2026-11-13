/**
 * Source-role separation for FDE native evidence handed to GAR, Knowledge, or a model host.
 * This is a read-only projection/admission gate, NOT a second Haskell semantic evaluator.
 * Caller must pass a verified, host-owned WorkspaceCase (e.g. buildConnectedCase).
 */
import {detach} from "./json.js";
import {projectFdeNativeGarEvidence,type FdeGarEvidence} from "./gar-support.js";
import type {WorkspaceCase} from "./workspace.js";

type Role="erp"|"mes";
type R=Record<string,unknown>;
const roles=["erp","mes"] as const;
const isObject=(v:unknown):v is R=>
  !!v&&typeof v==="object"&&!Array.isArray(v);
const canonical=(v:unknown):string=>{
  if(Array.isArray(v))return "["+v.map(canonical).join(",")+"]";
  if(isObject(v))return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+canonical(v[k])).join(",")+"}";
  return JSON.stringify(v);
};
export interface FdeNativeEvidenceSlot {
  readonly role:Role;
  readonly vendor:"erpnext"|"openmes";
  readonly presence:"present"|"missing";
  readonly evidence:null|Readonly<{
    id:string;sourcePath:string;sourceDigest:string;passageDigest:string;
    revision:string;instance:string;nativeId:string;businessId:string;
    observedAt:string;sourceQuerySha256:string;captureMode:string;
    planned:string;reported:string;unit:string;
    coverage:WorkspaceCase["sources"]["erp"]["coverage"];
    text:string;
  }>;
}
export interface FdeNativeEvidencePair {
  readonly schema:"fde.native-evidence-pair/v1";
  readonly authority:"none";
  readonly observationId:string;
  readonly status:"complete-pair"|"incomplete-pair";
  readonly missingRoles:readonly Role[];
  readonly sources:Readonly<{erp:FdeNativeEvidenceSlot;mes:FdeNativeEvidenceSlot}>;
  readonly binding:null|Readonly<{
    schema:"fde.native-binding/v1";grade:string;unit:string;
    erp:Readonly<{instance:string;nativeId:string}>;
    mes:Readonly<{instance:string;nativeId:string}>;
  }>;
  readonly canCompareReportedQuantities:boolean;
  readonly actualComparisonPerformed:false;
  readonly distributedAtomicSnapshot:false;
  readonly physicalProductionCertified:false;
  readonly stockReceiptCovered:false;
  readonly inventoryLedgerCovered:false;
  readonly sourceWriteAllowed:false;
  readonly limitations:readonly string[];
}
function validCase(c:WorkspaceCase):void {
  if(c?.schema!=="fde.connected-case/v1"||c.authority!=="none"||
     c.observationScope?.readPattern!=="two-independent-source-transactions"||
     c.observationScope.distributedAtomicSnapshot!==false||
     c.observationScope.sourceWriteAllowed!==false||
     c.observationScope.businessTruthAdmitted!==false||
     c.observationScope.physicalProductionCertified!==false)
    throw Error("fde-pair-unqualified-observation");
  for(const role of roles){
    const source=c.sources?.[role],binding=c.binding?.[role];
    if(!source||!binding||
       source.vendor!==(role==="erp"?"erpnext":"openmes")||
       source.instance!==binding.instance||source.nativeId!==binding.nativeId||
       source.coverage?.order!=="exact-native-row"||
       source.coverage.receipt!=="not-covered"||
       source.coverage.ledger!=="not-covered"||
       source.coverage.physical!=="not-covered"||
       !source.capture?.observedAt||!source.capture.querySha256)
      throw Error("fde-pair-source-role-or-binding-refused");
  }
  if(typeof c.binding?.unit!=="string"||!c.binding.unit||
     typeof c.binding?.grade!=="string"||!c.binding.grade)
    throw Error("fde-pair-unit-binding-missing");
}
function validateExactCandidate(item:unknown,reference:FdeGarEvidence):void {
  const v=detach(item);
  if(!isObject(v)||!isObject(v.sourceDescriptor)||
     !isObject(v.sourceDescriptor.metadata)||
     v.sourceDescriptor.kind!=="native-observation")
    throw Error("fde-pair-invalid-native-evidence");
  for(const k of ["id","sourcePath","sourceDigest","passageDigest","startByte","endByte","text"] as const)
    if(v[k]!==reference[k])throw Error("fde-pair-native-evidence-substituted:"+k);
  if(canonical(v.sourceDescriptor.metadata)!==canonical(reference.sourceDescriptor.metadata)||
     v.sourceDescriptor.title!==reference.sourceDescriptor.title)
    throw Error("fde-pair-native-source-descriptor-substituted");
}
function slot(c:WorkspaceCase,role:Role,ref:FdeGarEvidence,found:boolean):FdeNativeEvidenceSlot {
  if(!found)return Object.freeze({role,vendor:role==="erp"?"erpnext":"openmes",
    presence:"missing" as const,evidence:null});
  const s=c.sources[role];
  return Object.freeze({role,vendor:role==="erp"?"erpnext":"openmes",
    presence:"present" as const,
    evidence:Object.freeze({
      id:ref.id,sourcePath:ref.sourcePath,
      sourceDigest:ref.sourceDigest,passageDigest:ref.passageDigest,
      revision:s.revision,instance:s.instance,nativeId:s.nativeId,
      businessId:s.businessId,observedAt:s.capture.observedAt,
      sourceQuerySha256:s.capture.querySha256,captureMode:s.capture.mode,
      planned:s.planned,reported:s.reported,unit:s.unit,
      coverage:s.coverage,text:ref.text
    })});
}
export function projectFdeNativeEvidencePair(
  c:WorkspaceCase,selected:readonly unknown[]):FdeNativeEvidencePair {
  validCase(c);
  if(!Array.isArray(selected)||selected.length>16)
    throw Error("fde-pair-invalid-selection");
  const refs=projectFdeNativeGarEvidence(c);
  const byId=new Map(refs.map((ref,i)=>[ref.id,{ref,role:roles[i]!}]));
  const present=new Set<Role>();
  for(const item of selected){
    const v=detach(item);
    if(!isObject(v)||typeof v.id!=="string")throw Error("fde-pair-invalid-selection");
    const expected=byId.get(v.id);
    if(!expected)throw Error("fde-pair-foreign-native-evidence-refused");
    if(present.has(expected.role))throw Error("fde-pair-duplicate-source-role");
    validateExactCandidate(v,expected.ref);
    present.add(expected.role);
  }
  const missingRoles=roles.filter(r=>!present.has(r));
  const complete=missingRoles.length===0;
  const sources=Object.freeze({
    erp:slot(c,"erp",refs[0]!,present.has("erp")),
    mes:slot(c,"mes",refs[1]!,present.has("mes"))
  });
  return Object.freeze({
    schema:"fde.native-evidence-pair/v1",authority:"none",observationId:c.observationId,
    status:complete?"complete-pair":"incomplete-pair",
    missingRoles:Object.freeze(missingRoles),
    sources,
    binding:complete?Object.freeze({schema:"fde.native-binding/v1" as const,
      grade:c.binding.grade,unit:c.binding.unit,
      erp:Object.freeze({...c.binding.erp}),mes:Object.freeze({...c.binding.mes})}):null,
    canCompareReportedQuantities:complete,
    actualComparisonPerformed:false as const,
    distributedAtomicSnapshot:false as const,
    physicalProductionCertified:false as const,
    stockReceiptCovered:false as const,
    inventoryLedgerCovered:false as const,
    sourceWriteAllowed:false as const,
    limitations:Object.freeze([
      "ERPNext and OpenMES are separate native source identities and independent read-only observations.",
      "This pair checks source identity and completeness only; Haskell owns actual quantity comparison and meaning.",
      "FDE local evidence projection SHA values do not independently authenticate vendor databases or establish currentness.",
      "No distributed atomic snapshot, stock receipt, inventory ledger or physical production is established.",
      "No source write, approval or business truth admission follows from a complete pair."
    ])
  });
}
/** A human can inspect a partial pair; it must never masquerade as a valid comparison. */
export function formatFdeNativeEvidencePair(pair:FdeNativeEvidencePair):string {
  if(pair.schema!=="fde.native-evidence-pair/v1")throw Error("fde-pair-invalid-presentation");
  const lines=["FDE source separation | authority:none",
    "Pair "+pair.status+" | observation "+pair.observationId];
  for(const role of roles){
    const v=pair.sources[role];
    if(v.presence!=="present"||!v.evidence){
      lines.push(role.toUpperCase()+" / "+v.vendor+": MISSING — no source-derived quantities available");
      continue;
    }
    const s=v.evidence;
    lines.push(role.toUpperCase()+" / "+v.vendor+": PRESENT",
      "  native "+s.instance+" / "+s.nativeId+" | revision "+s.revision,
      "  captured "+s.observedAt+" | query "+s.sourceQuerySha256,
      "  planned "+s.planned+" "+s.unit+" | reported "+s.reported+" "+s.unit,
      "  source "+s.id+" | projection "+s.sourceDigest,
      "  receipt/ledger/physical: "+s.coverage.receipt+"/"+s.coverage.ledger+"/"+s.coverage.physical);
  }
  lines.push(pair.canCompareReportedQuantities?
    "Comparison evidence: complete native pair; Haskell must still interpret quantities/mapping.":
    "Comparison evidence: INCOMPLETE. Do not compute or claim an ERP/MES difference.");
  lines.push("Atomic snapshot: NO | Physical production: NOT CERTIFIED | Source effects: NONE");
  return lines.join("\n");
}
/** Model context is impossible from a partial or substituted pair. No inference is invoked here. */
export function prepareFdeNativePairContext(c:WorkspaceCase,selected:readonly unknown[]):Readonly<{
  schema:"fde.native-evidence-model-context/v1";authority:"none";
  observationId:string;sourceIds:readonly string[];text:string;
}> {
  // Rebind every selected witness to the exact current FDE WorkspaceCase here.
  // A caller cannot create model context by forging a serialized "complete" pair.
  const pair=projectFdeNativeEvidencePair(c,selected);
  if(pair.schema!=="fde.native-evidence-pair/v1"||
     pair.status!=="complete-pair"||!pair.canCompareReportedQuantities||
     pair.missingRoles.length!==0||!pair.binding)
    throw Error("fde-pair-incomplete-context-refused");
  const e=pair.sources.erp.evidence,m=pair.sources.mes.evidence;
  if(!e||!m||pair.sources.erp.vendor!=="erpnext"||
     pair.sources.mes.vendor!=="openmes"||e.id===m.id)
    throw Error("fde-pair-source-role-refused");
  const text=[
    "FDE candidate evidence: sources are separate, individually recorded, and never merged.",
    "[ERPNext source role=erp | "+e.id+" | sha="+e.sourceDigest+"]",e.text,"[/ERPNext]",
    "[OpenMES source role=mes | "+m.id+" | sha="+m.sourceDigest+"]",m.text,"[/OpenMES]",
    "[DECLARED SYNTHETIC BINDING]",
    "binding.grade="+pair.binding.grade,
    "binding.unit="+pair.binding.unit,
    "mapping is a declared comparison condition, not a vendor transaction or physical-production witness.",
    "[/DECLARED SYNTHETIC BINDING]",
    "Two independent reads; NOT a simultaneous distributed atomic snapshot.",
    "No source covers stock receipt, ledger postings or physical production.",
    "No model answer can create an omitted source; any derived comparison must use FDE's admitted Haskell semantics."
  ].join("\n");
  return Object.freeze({schema:"fde.native-evidence-model-context/v1",
    authority:"none",observationId:pair.observationId,
    sourceIds:Object.freeze([e.id,m.id]),text});
}
