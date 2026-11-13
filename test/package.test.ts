import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {compileOperationalPackage,renderOperationalPackageArtifacts} from "../src/package.js";
import {compileSemanticCatalog,compileSemanticPackage,assessSemanticClaim} from "../src/semantic-client.js";
import {synthetic} from "./fixtures.js";

const source=()=>readFileSync(resolve(process.cwd(),"spec/w1-review.ec.yaml"),"utf8");
const mutate=(fn:(x:any)=>void)=>{const x=JSON.parse(source());fn(x);return JSON.stringify(x);};

test("PK01 package resolves only Haskell-owned semantic catalog identities",()=>{
  const ir=compileOperationalPackage(source()),catalog=compileSemanticCatalog();
  assert.equal(ir.semantic.modelId,catalog.modelId);
  assert.deepEqual(ir.semantic.factIds,catalog.factIds);
  assert.equal(ir.groundAuthorityGranted,false);
  assert.equal(ir.vendorEffectAuthority,false);
  assert.throws(()=>compileOperationalPackage(mutate(x=>x.sources.semantic.modelId="typescript-semantic-model")),/package-refused/);
});
test("PK02 package fixes GAR to FDE grounding-reference and supported claim state",()=>{
  const ir=compileOperationalPackage(source());
  assert.deepEqual(ir.gar,{project:"fde",corpusLane:"grounding-reference",knowledgeAnswerability:"not-verified",knowledgeGroundingStatus:"candidate-only",requiredClaimState:"supported"});
  assert.throws(()=>compileOperationalPackage(mutate(x=>x.sources.gar.corpusLane="working-memory")),/package-refused/);
});
test("PK03 capture and editable projections are workflow-owned only",()=>{
  const ir=compileOperationalPackage(source()),byId=new Map(ir.application.fields.map(f=>[f.id,f]));
  for(const capture of ir.application.captures)for(const id of capture.fieldIds)assert.equal(byId.get(id)?.ownership,"workflow-owned");
  assert.throws(()=>compileOperationalPackage(mutate(x=>x.application.captures[0].fieldIds.push("erpReportedQuantity"))),/package-refused/);
});
test("PK04 operational package cannot mint vendor effects or Ground authority",()=>{
  const ir=compileOperationalPackage(source());
  assert.equal(ir.application.effectBoundary.vendorEffects,"none");
  assert.equal(ir.groundAuthorityGranted,false);
  assert.throws(()=>compileOperationalPackage(mutate(x=>x.application.effectBoundary.vendorEffects="write")),/package-refused/);
  assert.throws(()=>compileOperationalPackage(mutate(x=>x.groundPolicy={writeRoots:["src"]})),/unexpected|package-refused|closed/i);
});
test("PK05 projection editability cannot include source-owned fields",()=>{
  const ir=compileOperationalPackage(source());
  assert.equal(ir.application.projections.length,3);
  assert.throws(()=>compileOperationalPackage(mutate(x=>x.application.projections[0].editableFieldIds.push("mesReportedQuantity"))),/package-refused/);
});
test("PK06 generated package artifacts are deterministic and bounded",()=>{
  const ir=compileOperationalPackage(source());
  const a=renderOperationalPackageArtifacts(ir),b=renderOperationalPackageArtifacts(ir);
  assert.deepEqual(a,b);
  assert.deepEqual(a.files.map(f=>f.path),["package-ir.json","review-contract.schema.json","conformance-fixtures.json","package-contract.md"]);
  assert.ok(a.files.every(f=>Buffer.byteLength(f.content)<65536));
});
test("PK07 Haskell semantic package emits explicit unknown and source-bound receipts",()=>{
  const pkg=compileSemanticPackage(synthetic());
  assert.equal(pkg.facts.find(f=>f.id==="fact:physical-production")?.knowledge.kind,"unknown");
  assert.equal(pkg.facts.find(f=>f.id==="fact:erp-reported-quantity")?.evidence[0]?.role,"erp");
  assert.equal(pkg.mapping.fidelity.kind,"projection-only");
});
test("PK08 Haskell owns support and contradiction relation semantics",()=>{
  const sourceCase=synthetic();
  const expected=sourceCase.erp.reported;
  const good=assessSemanticClaim(sourceCase,{kind:"reported-quantity",role:"erp",quantity:expected});
  const bad=assessSemanticClaim(sourceCase,{kind:"reported-quantity",role:"erp",quantity:"9"});
  assert.equal(good.relations.find(r=>r.evidenceClass==="native-erp")?.relation,"supports");
  assert.equal(bad.relations.find(r=>r.evidenceClass==="native-erp")?.relation,"contradicts");
});
