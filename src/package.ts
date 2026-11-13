import {parseStrictJson,object,reject} from "./json.js";
import {compileSemanticCatalog,type SemanticCatalog} from "./semantic-client.js";
import {bundledSemanticRuntime,type SemanticRuntime} from "./semantic-runtime.js";

export type FieldOwnership="source-owned"|"workflow-owned"|"derived";
export type Classification="organization-owned"|"organization-confidential"|"derived";
export type Portability="portable"|"restricted"|"non-portable";

export interface PackageField{
  readonly id:string;readonly label:string;readonly ownership:FieldOwnership;
  readonly ownerId:string;readonly classification:Classification;readonly portability:Portability;
  readonly semanticFactId:string|null;
}
export interface PackageProjection{
  readonly id:string;readonly kind:"web"|"csv"|"json";readonly fieldIds:readonly string[];
  readonly editableFieldIds:readonly string[];
}
export interface OperationalPackageIR{
  readonly schema:"fde.operational-projection-ir/v1";
  readonly authority:"none";
  readonly package:Readonly<{id:"fde.w1.erp-mes-review";version:"1.0.0";status:"reference"}>;
  readonly sourceAdapters:readonly Readonly<{
    id:string;role:"erp"|"mes";vendor:"erpnext"|"openmes";
    coverage:Readonly<{order:"exact-native-row";receipt:"not-covered";ledger:"not-covered";physical:"not-covered"}>;
  }>[];
  readonly semantic:Readonly<{modelId:string;modelVersion:string;mappingId:string;factIds:readonly string[];constraintIds:readonly string[];claimKinds:readonly string[]}>;
  readonly gar:Readonly<{project:"fde";corpusLane:"grounding-reference";knowledgeAnswerability:"not-verified";knowledgeGroundingStatus:"candidate-only";requiredClaimState:"supported"}>;
  readonly application:Readonly<{
    roles:readonly ("viewer"|"reviewer"|"operator")[];
    fields:readonly PackageField[];
    workflow:Readonly<{id:"fde.w1.review";version:"1.0.0";initial:"open";states:readonly ("open"|"needs-investigation"|"reviewed")[];transitions:readonly Readonly<{id:string;from:"any";to:"open"|"needs-investigation"|"reviewed";actorRoles:readonly ("reviewer"|"operator")[]}>[]}>;
    captures:readonly Readonly<{id:"review-update";mode:"workflow-update";fieldIds:readonly string[]}>[];
    projections:readonly PackageProjection[];
    exportPolicy:Readonly<{id:"w1-evidence-handoff";allow:readonly string[];deny:readonly string[]}>;
    effectBoundary:Readonly<{vendorEffects:"none";proposalOnly:true}>;
  }>;
  readonly implementation:Readonly<{targets:readonly string[];generatedDir:"generated/w1-package"}>;
  readonly artifacts:Readonly<{packageIr:string;jsonSchema:string;conformanceFixtures:string;documentation:string}>;
  readonly conformance:Readonly<{scenarioIds:readonly string[]}>;
  readonly groundAuthorityGranted:false;
  readonly vendorEffectAuthority:false;
}
export interface RenderedPackageArtifacts{
  readonly schema:"fde.rendered-operational-package/v1";
  readonly files:readonly Readonly<{path:string;content:string}>[];
}

const topFields=["schema","package","sources","semantics","application","implementation","outputs","conformance"] as const;
const id=/^[a-z][a-z0-9.:_-]{0,119}$/;
const fieldId=/^[a-z][A-Za-z0-9_-]{0,79}$/;
const pathPattern=/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/;

function uniqueStrings(raw:unknown,label:string,min=0):readonly string[]{
  if(!Array.isArray(raw)||raw.length<min||raw.some(x=>typeof x!=="string"||!x)||new Set(raw as string[]).size!==raw.length)
    reject("package-refused",label);
  return Object.freeze([...(raw as string[])]);
}
function sameSet(a:readonly string[],b:readonly string[]):boolean{
  return JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
}
function idsAreKnown(ids:readonly string[],known:readonly string[],label:string):void{
  const allowed=new Set(known);
  if(ids.some(x=>!allowed.has(x)))reject("package-refused",label);
}
function exactCoverage(raw:unknown,label:string){
  const c=object(raw,["order","receipt","ledger","physical"],label);
  if(c.order!=="exact-native-row"||c.receipt!=="not-covered"||c.ledger!=="not-covered"||c.physical!=="not-covered")
    reject("package-refused",label);
  return Object.freeze({order:"exact-native-row" as const,receipt:"not-covered" as const,ledger:"not-covered" as const,physical:"not-covered" as const});
}
function compileSourceAdapters(raw:unknown){
  if(!Array.isArray(raw)||raw.length!==2)reject("package-refused","source adapters");
  const seen=new Set<string>();
  const adapters=raw.map(value=>{
    const a=object(value,["id","role","vendor","coverage"],"source adapter");
    if(typeof a.id!=="string"||!id.test(a.id)||seen.has(a.id)||!["erp","mes"].includes(String(a.role))||
       !["erpnext","openmes"].includes(String(a.vendor))||(a.role==="erp"&&a.vendor!=="erpnext")||(a.role==="mes"&&a.vendor!=="openmes"))
      reject("package-refused","source adapter identity");
    seen.add(a.id);
    return Object.freeze({id:a.id,role:a.role as "erp"|"mes",vendor:a.vendor as "erpnext"|"openmes",coverage:exactCoverage(a.coverage,"source adapter coverage")});
  });
  if(!sameSet(adapters.map(a=>a.role),["erp","mes"]))reject("package-refused","source adapter roles");
  return Object.freeze(adapters);
}
function compileFields(raw:unknown,catalog:SemanticCatalog):readonly PackageField[]{
  if(!Array.isArray(raw)||raw.length<6||raw.length>32)reject("package-refused","application fields");
  const seen=new Set<string>();
  return Object.freeze(raw.map(value=>{
    const f=object(value,["id","label","ownership","ownerId","classification","portability","semanticFactId"],"application field");
    if(typeof f.id!=="string"||!fieldId.test(f.id)||seen.has(f.id)||typeof f.label!=="string"||!f.label||
       typeof f.ownerId!=="string"||!id.test(f.ownerId)||!["source-owned","workflow-owned","derived"].includes(String(f.ownership))||
       !["organization-owned","organization-confidential","derived"].includes(String(f.classification))||
       !["portable","restricted","non-portable"].includes(String(f.portability))||
       !(f.semanticFactId===null||typeof f.semanticFactId==="string"))
      reject("package-refused","application field shape");
    seen.add(f.id);
    const ownership=f.ownership as FieldOwnership;
    if(ownership==="workflow-owned"&&f.semanticFactId!==null)reject("package-refused","workflow field cannot claim semantic fact");
    if(ownership==="source-owned"&&(typeof f.semanticFactId!=="string"||!catalog.factIds.includes(f.semanticFactId)))
      reject("package-refused","source field semantic binding");
    if(ownership==="derived"&&f.semanticFactId!==null&&!catalog.factIds.includes(f.semanticFactId as string))
      reject("package-refused","derived field semantic binding");
    return Object.freeze({id:f.id,label:f.label,ownership,ownerId:f.ownerId,classification:f.classification as Classification,
      portability:f.portability as Portability,semanticFactId:f.semanticFactId as string|null});
  }));
}
function compileWorkflow(raw:unknown,roles:readonly string[]){
  const w=object(raw,["id","version","initial","states","transitions"],"review workflow");
  if(w.id!=="fde.w1.review"||w.version!=="1.0.0"||w.initial!=="open")reject("package-refused","review workflow identity");
  const states=uniqueStrings(w.states,"review states",3);
  if(!sameSet(states,["open","needs-investigation","reviewed"]))reject("package-refused","review workflow states");
  if(!Array.isArray(w.transitions)||w.transitions.length!==3)reject("package-refused","review transitions");
  const transitions=w.transitions.map(rawTransition=>{
    const t=object(rawTransition,["id","from","to","actorRoles"],"review transition");
    const actorRoles=uniqueStrings(t.actorRoles,"transition actor roles",1);
    if(typeof t.id!=="string"||!id.test(t.id)||t.from!=="any"||!states.includes(String(t.to))||
       actorRoles.some(r=>!roles.includes(r))||actorRoles.some(r=>r!=="reviewer"&&r!=="operator"))
      reject("package-refused","review transition");
    return Object.freeze({id:t.id,from:"any" as const,to:t.to as "open"|"needs-investigation"|"reviewed",
      actorRoles:Object.freeze(actorRoles as ("reviewer"|"operator")[])});
  });
  if(!sameSet(transitions.map(t=>t.to),states))reject("package-refused","review transition coverage");
  return Object.freeze({id:"fde.w1.review" as const,version:"1.0.0" as const,initial:"open" as const,
    states:Object.freeze(states as ("open"|"needs-investigation"|"reviewed")[]),transitions:Object.freeze(transitions)});
}
function compileCaptures(raw:unknown,fields:readonly PackageField[]){
  if(!Array.isArray(raw)||raw.length!==1)reject("package-refused","capture contracts");
  const c=object(raw[0],["id","mode","fieldIds"],"capture contract");
  const fieldIds=uniqueStrings(c.fieldIds,"capture field IDs",1);
  const byId=new Map(fields.map(f=>[f.id,f]));
  if(c.id!=="review-update"||c.mode!=="workflow-update"||fieldIds.some(fid=>byId.get(fid)?.ownership!=="workflow-owned"))
    reject("package-refused","capture ownership");
  return Object.freeze([Object.freeze({id:"review-update" as const,mode:"workflow-update" as const,fieldIds})]);
}
function compileProjections(raw:unknown,fields:readonly PackageField[]){
  if(!Array.isArray(raw)||raw.length!==3)reject("package-refused","projection intents");
  const byId=new Map(fields.map(f=>[f.id,f])),seen=new Set<string>();
  const values=raw.map(value=>{
    const p=object(value,["id","kind","fieldIds","editableFieldIds"],"projection intent");
    const fieldIds=uniqueStrings(p.fieldIds,"projection field IDs",1);
    const editable=uniqueStrings(p.editableFieldIds,"projection editable fields");
    if(typeof p.id!=="string"||!id.test(p.id)||seen.has(p.id)||!["web","csv","json"].includes(String(p.kind))||
       fieldIds.some(x=>!byId.has(x))||editable.some(x=>!fieldIds.includes(x))||
       editable.some(x=>byId.get(x)?.ownership!=="workflow-owned"))
      reject("package-refused","projection intent");
    seen.add(p.id);
    return Object.freeze({id:p.id,kind:p.kind as "web"|"csv"|"json",fieldIds,editableFieldIds:editable});
  });
  if(!sameSet(values.map(v=>v.kind),["web","csv","json"]))reject("package-refused","projection kinds");
  return Object.freeze(values);
}
function compileExport(raw:unknown,fields:readonly PackageField[]){
  const e=object(raw,["id","allow","deny"],"export policy");
  const allow=uniqueStrings(e.allow,"export allow"),deny=uniqueStrings(e.deny,"export deny");
  const known=new Set(fields.map(f=>f.id));
  if(e.id!=="w1-evidence-handoff"||allow.some(x=>!known.has(x))||deny.some(x=>!known.has(x))||allow.some(x=>deny.includes(x)))
    reject("package-refused","export policy");
  return Object.freeze({id:"w1-evidence-handoff" as const,allow,deny});
}

export function compileOperationalPackage(source:unknown,runtime:SemanticRuntime=bundledSemanticRuntime()):OperationalPackageIR{
  if(typeof source!=="string"||!source.trim()||Buffer.byteLength(source)>65536)reject("package-refused","package source");
  const parsed=parseStrictJson(source);
  const top=object(parsed,[...topFields],"operational package");
  if(top.schema!=="fde.operational-projection-package/v1")reject("package-refused","package schema");
  const pkg=object(top.package,["id","version","status"],"package identity");
  if(pkg.id!=="fde.w1.erp-mes-review"||pkg.version!=="1.0.0"||pkg.status!=="reference")reject("package-refused","package identity");
  const catalog=compileSemanticCatalog(runtime);

  const sources=object(top.sources,["adapters","semantic","gar"],"package sources");
  const adapters=compileSourceAdapters(sources.adapters);
  const semantic=object(sources.semantic,["modelId","modelVersion","mappingId"],"semantic source");
  if(semantic.modelId!==catalog.modelId||semantic.modelVersion!==catalog.modelVersion||semantic.mappingId!==catalog.mappingId)
    reject("package-refused","semantic source identity");
  const gar=object(sources.gar,["project","corpusLane","knowledgeAnswerability","knowledgeGroundingStatus","requiredClaimState"],"GAR source");
  if(gar.project!=="fde"||gar.corpusLane!=="grounding-reference"||gar.knowledgeAnswerability!=="not-verified"||
     gar.knowledgeGroundingStatus!=="candidate-only"||gar.requiredClaimState!=="supported")
    reject("package-refused","GAR grounding boundary");

  const semantics=object(top.semantics,["factIds","constraintIds","claimKinds"],"semantic selection");
  const factIds=uniqueStrings(semantics.factIds,"selected fact IDs",1);
  const constraintIds=uniqueStrings(semantics.constraintIds,"selected constraint IDs",1);
  const claimKinds=uniqueStrings(semantics.claimKinds,"selected claim kinds",1);
  idsAreKnown(factIds,catalog.factIds,"unknown semantic fact");
  idsAreKnown(constraintIds,catalog.constraintIds,"unknown semantic constraint");
  idsAreKnown(claimKinds,catalog.claimKinds,"unknown semantic claim kind");

  const app=object(top.application,["roles","fields","workflow","captures","projections","exportPolicy","effectBoundary"],"application package");
  const roles=uniqueStrings(app.roles,"application roles",3);
  if(!sameSet(roles,["viewer","reviewer","operator"]))reject("package-refused","application roles");
  const fields=compileFields(app.fields,catalog);
  const workflow=compileWorkflow(app.workflow,roles);
  const captures=compileCaptures(app.captures,fields);
  const projections=compileProjections(app.projections,fields);
  const exportPolicy=compileExport(app.exportPolicy,fields);
  const effect=object(app.effectBoundary,["vendorEffects","proposalOnly"],"effect boundary");
  if(effect.vendorEffects!=="none"||effect.proposalOnly!==true)reject("package-refused","vendor effect boundary");

  const implementation=object(top.implementation,["targets","generatedDir"],"implementation package");
  const targets=uniqueStrings(implementation.targets,"implementation targets",1);
  if(implementation.generatedDir!=="generated/w1-package"||targets.some(x=>!pathPattern.test(x)||x.startsWith("generated/")))
    reject("package-refused","implementation targets");

  const outputs=uniqueStrings(top.outputs,"package outputs",4);
  if(!sameSet(outputs,["package-ir","json-schema","conformance-fixtures","documentation"]))
    reject("package-refused","package outputs");
  const conformance=object(top.conformance,["scenarioIds"],"conformance package");
  const scenarioIds=uniqueStrings(conformance.scenarioIds,"conformance scenarios",5);
  if(scenarioIds.some(x=>!id.test(x)))reject("package-refused","conformance scenario ID");

  return Object.freeze({
    schema:"fde.operational-projection-ir/v1",authority:"none",
    package:Object.freeze({id:"fde.w1.erp-mes-review",version:"1.0.0",status:"reference"}),
    sourceAdapters:adapters,
    semantic:Object.freeze({modelId:catalog.modelId,modelVersion:catalog.modelVersion,mappingId:catalog.mappingId,factIds,constraintIds,claimKinds}),
    gar:Object.freeze({project:"fde",corpusLane:"grounding-reference",knowledgeAnswerability:"not-verified",
      knowledgeGroundingStatus:"candidate-only",requiredClaimState:"supported"}),
    application:Object.freeze({roles:Object.freeze(roles as ("viewer"|"reviewer"|"operator")[]),fields,workflow,captures,
      projections,exportPolicy,effectBoundary:Object.freeze({vendorEffects:"none",proposalOnly:true})}),
    implementation:Object.freeze({targets,generatedDir:"generated/w1-package"}),
    artifacts:Object.freeze({packageIr:"generated/w1-package/package-ir.json",jsonSchema:"generated/w1-package/review-contract.schema.json",
      conformanceFixtures:"generated/w1-package/conformance-fixtures.json",documentation:"generated/w1-package/package-contract.md"}),
    conformance:Object.freeze({scenarioIds}),
    groundAuthorityGranted:false,vendorEffectAuthority:false
  });
}

function json(v:unknown):string{return JSON.stringify(v,null,2)+"\n";}
export function renderOperationalPackageArtifacts(ir:OperationalPackageIR):RenderedPackageArtifacts{
  const schema={
    $schema:"https://json-schema.org/draft/2020-12/schema",
    $id:"urn:fde:w1:review-update:1.0.0",
    title:"FDE W1 review update",
    type:"object",additionalProperties:false,
    required:["assignee","disposition","note"],
    properties:{
      assignee:{oneOf:[{type:"null"},{type:"string",pattern:"^[a-z][a-z0-9_-]{0,47}$"}]},
      disposition:{type:"string",enum:[...ir.application.workflow.states]},
      note:{type:"string",maxLength:2000}
    },
    "x-fde-authority":"workflow-only",
    "x-fde-source-write-allowed":false
  };
  const fixtures=[
    {id:"pkg-current",expect:"accepted",law:"Haskell catalog + GAR lane + ownership + effect boundary"},
    {id:"pkg-unknown-semantic-fact",expect:"refused",law:"semantic references must exist in Haskell catalog"},
    {id:"pkg-working-memory-gar",expect:"refused",law:"GAR must use fde grounding-reference lane"},
    {id:"pkg-source-field-capture",expect:"refused",law:"capture may edit workflow-owned fields only"},
    {id:"pkg-vendor-effect",expect:"refused",law:"package cannot grant vendor effects"},
    {id:"pkg-projection-source-edit",expect:"refused",law:"projection editability cannot include source-owned fields"}
  ];
  const tick=String.fromCharCode(96);
  const lines=[
    "# FDE W1 operational/projection package","",
    "> Generated from the compiled FDE W1 package IR. Do not edit generated artifacts by hand.","",
    "## Semantic source","",
    "- Haskell model: "+tick+ir.semantic.modelId+tick+" / "+tick+ir.semantic.modelVersion+tick,
    "- Mapping: "+tick+ir.semantic.mappingId+tick,
    "- GAR: project "+tick+ir.gar.project+tick+", lane "+tick+ir.gar.corpusLane+tick+", answer only at claim state "+tick+ir.gar.requiredClaimState+tick,
    "","## Application ownership","",
    "| Field | Ownership | Owner | Semantic fact |","| --- | --- | --- | --- |"
  ];
  for(const f of ir.application.fields)lines.push("| "+tick+f.id+tick+" | "+f.ownership+" | "+tick+f.ownerId+tick+" | "+(f.semanticFactId?tick+f.semanticFactId+tick:"—")+" |");
  lines.push("","## Workflow","", "Workflow "+tick+ir.application.workflow.id+tick+" accepts the declared review dispositions under reviewer/operator roles. It never changes vendor source facts.","","## Projections","");
  for(const p of ir.application.projections)lines.push("- "+tick+p.id+tick+" ("+p.kind+"): "+p.fieldIds.join(", ")+(p.editableFieldIds.length?"; editable workflow fields: "+p.editableFieldIds.join(", "):""));
  lines.push("","## Effect boundary","","**Vendor effects: NONE.** Package output, workflow capture and projections cannot grant Ground, ERPNext or OpenMES authority.","","## Conformance scenarios","");
  for(const scenario of ir.conformance.scenarioIds)lines.push("- "+tick+scenario+tick);
  lines.push("");
  const files=[
    {path:"package-ir.json",content:json(ir)},
    {path:"review-contract.schema.json",content:json(schema)},
    {path:"conformance-fixtures.json",content:json({schema:"fde.package-conformance-fixtures/v1",packageId:ir.package.id,fixtures})},
    {path:"package-contract.md",content:lines.join("\n")}
  ];
  return Object.freeze({schema:"fde.rendered-operational-package/v1",files:Object.freeze(files.map(f=>Object.freeze(f)))});
}
