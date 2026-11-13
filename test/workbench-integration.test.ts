import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {assessIndustrial,industrialCatalog} from "../src/industrial-client.js";
import {emptyWorkbenchDocument,type WorkbenchDocument} from "../src/workbench-model.js";
import {WorkbenchStore} from "../src/workbench-store.js";
import {ReviewStore} from "../src/review-store.js";
import {kernelFingerprint} from "../src/admission.js";
import {makeAuthUser,admitAuthConfig} from "../src/web/auth.js";
import {createApplicationServer,type ReleaseManifest} from "../src/web/application.js";
import {listenLocal} from "../src/web/server.js";
import type {WorkbenchSourceGrant} from "../src/web/workbench.js";
import {industrialBudgetFixture} from "./industrial-budget-fixture.js";

const password="synthetic-internal-verification-only-20261101";
const basic=(role="reviewer")=>"Basic "+Buffer.from(role+":"+password).toString("base64");
const at="2026-11-01T16:00:00.000Z";
const evidence=(id:string)=>({id,title:id,reference:"synthetic:"+id,revision:"r1",observedAt:at,origin:"synthetic" as const,limitations:""});
const request=(investigation:unknown)=>({schema:"fde.industrial-assessment-request/v1",investigation});
const pdm=request({kind:"pdm",partId:"P-17",configuration:"assembly-red",requiredRevision:"B",observedRevision:"A",identity:"confirmed",release:"released",effectivity:"applicable",approvedAlternate:false,changeApproved:true,changePropagated:false,engineeringQuantity:"2",manufacturingQuantity:"2",engineeringUnit:"piece",manufacturingUnit:"piece",evidenceRefs:["change-record","floor-copy"]});
const worker=request({kind:"worker-benefit",currency:"USD",cashItems:[{id:"avoided-material",amount:"5000",evidenceRef:"finance-record"}],costItems:[{id:"fixture-cost",amount:"1000",evidenceRef:"cost-record"}],cashScope:"nonoverlapping",releasedHours:"20",nonfinancialOutcome:"Less repetitive handling",observation:"observed",allocationPercent:"25",commitment:"authorized",deliveredAmount:"750",deliveryEvidence:["payment-record"],evidenceRefs:["finance-record","cost-record","sharing-agreement","payment-record"]});
function document(input:unknown,refs:string[]):WorkbenchDocument {
  const d=structuredClone(emptyWorkbenchDocument());
  return {...d,title:"P-17 engineering change and worker returns",engagement:{...d.engagement,organization:"Synthetic workshop",sponsor:"Synthetic sponsor",processOwner:"Synthetic production owner",scope:"P-17 fixture and instruction",decision:"Resolve revision propagation before evaluating the intervention",systems:[{id:"pdm",name:"Synthetic PDM",owner:"Engineering",purpose:"Released definition"}],affectedGroups:[{id:"operators",name:"Assembly operators",concern:"Avoid obsolete instructions and repetitive handling"}],localObservationOwner:"Local quality owner",dataHandling:"Synthetic verification only"},investigation:{...d.investigation,kind:"pdm-bom",problem:"Released revision differs from the floor instruction",baseline:"Two versioned references",measurementPlan:"Inspect applicability before comparing output"},semanticInput:input,evidence:refs.map(evidence)};
}
async function application(t:TestContext,sourceGrants?:(()=>readonly WorkbenchSourceGrant[])){
  const directory=mkdtempSync(join(tmpdir(),"fde-workbench-integration-"));
  const store=new ReviewStore(join(directory,"review.sqlite")),workbenchStore=new WorkbenchStore(join(directory,"workbench.sqlite"));
  const auth=admitAuthConfig({schema:"fde.lab-auth/v1",users:await Promise.all([makeAuthUser("reviewer","reviewer",password),makeAuthUser("viewer","viewer",password),makeAuthUser("operator","operator",password)])});
  const release:ReleaseManifest={schema:"fde.release/v1",releaseId:"fde-0123456789abcdef",sourceRevision:"a".repeat(40),sourceTreeSha256:"b".repeat(64),kernelSha256:kernelFingerprint(),nodeVersion:process.version,builtAt:at,configurationSchema:"fde.private-lab/v1",files:{}};
  let sourceReads=0;
  const server=createApplicationServer({auth,store,workbenchStore,release,workbenchSourceGrants:sourceGrants,source:async()=>{sourceReads++;throw Error("No external source in this qualification");}});
  const port=await listenLocal(server,0),url="http://127.0.0.1:"+port;
  t.after(()=>{server.closeAllConnections();server.close();workbenchStore.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const get=(path:string,role="reviewer")=>fetch(url+path,{headers:{Authorization:basic(role)}});
  const post=(path:string,value:unknown,role="reviewer")=>fetch(url+path,{method:"POST",headers:{Authorization:basic(role),"Content-Type":"application/json","X-FDE-Request":"workbench"},body:JSON.stringify(value)});
  return {url,get,post,sourceReads:()=>sourceReads};
}
test("WI01 handwritten semantic fixtures cross the actual compiled boundary",()=>{
  const fixtures=JSON.parse(readFileSync(new URL("../../spec/industrial-examples.json",import.meta.url),"utf8"));
  assert.equal(industrialCatalog().entries.length,8);
  for(const example of fixtures.examples){
    const result=assessIndustrial(example.request);
    assert.equal(result.classification,example.expected.classification,example.id+" classification");
    assert.equal(result.authority,"none");assert.equal(result.vendorWriteAllowed,false);assert.equal(result.physicalAcceptanceCertified,false);
    for(const [id,expected] of Object.entries(example.expected.metrics)){
      const metric=result.metrics.find(m=>m.id===id);assert.ok(metric,example.id+" metric "+id);
      // Independently authored fixtures store exact numerator/denominator strings.
      const e=expected as {numerator:string;denominator:string;unit:string};
      assert.equal(metric.numerator,e.numerator,example.id+" numerator "+id);assert.equal(metric.denominator,e.denominator,example.id+" denominator "+id);assert.equal(metric.unit,e.unit,example.id+" unit "+id);
    }
  }
});
test("WI02 authenticated engagement through PDM, control, worker delivery and pinned replay",async t=>{
  const h=await application(t);
  for(const path of ["/workbench","/workbench.js","/workbench.css","/api/workbench/catalog"])
    assert.equal((await fetch(h.url+path)).status,401,"WI02 unauthenticated "+path);
  assert.match(await(await h.get("/workbench")).text(),/Industrial investigations/);
  assert.equal((await(await h.get("/api/workbench/catalog")).json()).entries.length,8);
  const createdResponse=await h.post("/api/workbench/cases",{actionId:randomUUID(),document:document(pdm,["change-record","floor-copy"])});
  assert.equal(createdResponse.status,200);const created=(await createdResponse.json()).case;
  const firstResponse=await h.post("/api/workbench/evaluate",{actionId:randomUUID(),caseId:created.caseId,expectedVersion:0});
  assert.equal(firstResponse.status,200);const first=(await firstResponse.json()).evaluation;
  assert.equal(first.result.classification,"change-not-propagated");
  assert.equal(first.input.schema,"fde.industrial-case-assessment-request/v1");
  assert.equal(first.input.evidenceInventory.length,2,"WI02 exact evidence context is pinned");
  const changed=document(worker,["finance-record","cost-record","sharing-agreement","payment-record"]);
  const improved={...changed,investigation:{...changed.investigation,phase:"control"},improvement:{...changed.improvement,proposal:"Replace obsolete instruction after owner review",decision:"approved",approver:"Synthetic engineering owner",decisionReference:"synthetic:change-approval",pilotPlan:"Compare same configuration before and after",acceptanceMeasures:"Correct revision, reduced rework, acceptable worker load",implementationRecord:"Synthetic change record",controlPlan:"Check applicability at release",reactionPlan:"Hold and review on mismatch",handoffOwner:"Synthetic process owner"},workerOutcomes:{...changed.workerOutcomes,proposedBenefits:"Share verified avoided material cash",commitmentAuthority:"Synthetic authorized sponsor",commitmentReference:"synthetic:sharing-agreement",deliveryEvidence:"synthetic:payment-record",disputes:"None recorded in synthetic case"}};
  assert.equal((await h.post("/api/workbench/case",{actionId:randomUUID(),caseId:created.caseId,expectedVersion:0,document:improved})).status,200);
  const secondResponse=await h.post("/api/workbench/evaluate",{actionId:randomUUID(),caseId:created.caseId,expectedVersion:1});
  assert.equal(secondResponse.status,200);const second=(await secondResponse.json()).evaluation;
  assert.equal(second.result.classification,"delivery-partial");
  const metrics=new Map<string,{numerator:string;denominator:string;unit:string}>(second.result.metrics.map((m:{id:string;numerator:string;denominator:string;unit:string})=>[m.id,m]));
  assert.equal(metrics.get("net-observed-cash")?.numerator,"4000");
  assert.equal(metrics.get("authorized-allocation")?.numerator,"1000");
  assert.equal(metrics.get("remaining-allocation")?.numerator,"250");
  assert.equal(metrics.get("released-capacity")?.unit,"h","WI02 capacity remains hours");
  const replay=await(await h.get("/api/workbench/replay?evaluationId="+first.evaluationId)).json();
  assert.equal(replay.matched,true);assert.equal(replay.evaluatedCaseVersion,0);assert.equal(replay.currentCaseVersion,1);assert.equal(replay.readsFreshSources,false);
  const history=await(await h.get("/api/workbench/history?caseId="+created.caseId)).json();assert.equal(history.revisions.length,2);
  assert.equal((await h.post("/api/workbench/case",{actionId:randomUUID(),caseId:created.caseId,expectedVersion:1,document:improved},"viewer")).status,403);
  assert.equal(h.sourceReads(),0,"WI02 complete workbench flow never acquires W1 sources");
});
test("WI03 missing case evidence cannot support an otherwise consistent interpretation",async t=>{
  const h=await application(t),d=document(pdm,[]);
  const created=(await(await h.post("/api/workbench/cases",{actionId:randomUUID(),document:d})).json()).case;
  const response=await h.post("/api/workbench/evaluate",{actionId:randomUUID(),caseId:created.caseId,expectedVersion:0});
  assert.equal(response.status,200);const result=(await response.json()).evaluation.result;
  assert.equal(result.classification,"evidence-linkage-unresolved");assert.equal(result.metrics.length,0);
  assert.equal(result.findings.some((f:{status:string;evidenceRefs:string[]})=>f.status==="supported"&&f.evidenceRefs.length>0),false);
  assert.equal(h.sourceReads(),0);
});
test("WI04 source permission cannot be bypassed through legacy W1 routes",async t=>{
  let revoked=false;
  const h=await application(t,()=>[{sourceId:"w1-observations",principals:["operator"],action:"read-pinned-w1",validFrom:"2020-01-01T00:00:00Z",validUntil:"2099-01-01T00:00:00Z",revoked}]);
  const id="obs-"+"0".repeat(64);
  assert.equal((await h.get("/api/cases","viewer")).status,403,"WI04 source gate /api/cases");
  for(const path of ["/api/case","/api/source-status","/api/export.json?observationId="+id,"/api/export.csv?observationId="+id,"/api/handoff.json?observationId="+id,"/api/replay?observationId="+id,"/api/investigation?observationId="+id])
    assert.equal((await h.get(path,"viewer")).status,403,"WI04 source gate "+path);
  assert.equal((await h.get("/api/cases","operator")).status,200,"WI04 valid grant reads existing pins");
  assert.equal((await h.get("/api/case","operator")).status,403,"WI04 read-pinned grant cannot authorize fresh acquisition");
  revoked=true;assert.equal((await h.get("/api/cases","operator")).status,403,"WI04 current revocation applies on every route");
  assert.equal((await h.get("/api/workbench/catalog","viewer")).status,200,"WI04 synthetic/manual workbench remains available");
  assert.equal(h.sourceReads(),0,"WI04 all denied routes stop before acquisition");
});
test("WI06 the Haskell industry set produces a saved-case deliverable, not vendor evidence",async t=>{
 const h=await application(t);
 assert.equal((await fetch(h.url+"/api/workbench/industry-set")).status,401);
 const setResponse=await h.get("/api/workbench/industry-set","viewer");
 assert.equal(setResponse.status,200);
 const set=await setResponse.json();
 assert.equal(set.families.length,8);
 assert.equal(set.knowledge.state,"not-assessed");
 assert.equal(set.knowledge.sources.length,0);
 const catalog=await(await h.get("/api/workbench/catalog")).json();
 assert.equal(catalog.industrySet.families.length,8);
 const d=document(pdm,["change-record","floor-copy"]);
 const created=await (await h.post("/api/workbench/cases",{actionId:randomUUID(),document:d})).json();
 const id=created.case.caseId,uri="/api/workbench/industry-brief?caseId="+id;
 const first=await h.get(uri+"&format=json","viewer");
 assert.equal(first.status,200);
 const packet=await first.json();
 assert.equal(packet.schema,"fde.industry-brief/v1");
 assert.equal(packet.family.id,"pdm-bom");
 assert.equal(packet.assessmentState,"not-assessed");
 assert.equal(packet.knowledge.sources.length,0);
 assert.equal(packet.sourceWriteAllowed,false);
 assert.equal(packet.businessTruthAdmitted,false);
 assert.equal((await h.get(uri+"&format=unsupported")).status,400);
 assert.equal((await h.get(uri+"&caseId="+id)).status,400);
 assert.equal((await h.get("/api/workbench/industry-brief?caseId=other")).status,400);
 const evaluated=await h.post("/api/workbench/evaluate",{
   actionId:randomUUID(),caseId:id,expectedVersion:0});
 assert.equal(evaluated.status,200);
 const withResult=await (await h.get(uri)).json();
 assert.equal(withResult.assessmentState,"current-diagnostic");
 assert.equal(withResult.assessment?.classification,"change-not-propagated");
 const markdown=await h.get(uri+"&format=markdown","viewer");
 assert.equal(markdown.status,200);
 assert.match(markdown.headers.get("content-type")||"",/text\/markdown/);
 assert.equal(markdown.headers.get("x-fde-case-version"),"0");
 const text=await markdown.text();
 assert.match(text,/Engineering revision/);
 assert.match(text,/Haskell result/);
 assert.match(text,/Knowledge references/);
 assert.match(text,/HUMAN REVIEW REQUIRED/);
 const updated=await h.post("/api/workbench/case",{
  actionId:randomUUID(),caseId:id,expectedVersion:0,
  document:{...d,title:"Changed after assessment"}});
 assert.equal(updated.status,200);
 const stale=await (await h.get(uri)).json();
 assert.equal(stale.assessmentState,"historical-only");
 assert.equal(stale.assessment,null);
 assert.equal(h.sourceReads(),0,"industry packet never acquires ERP/MES or W1 source");
});
test("WI05 supported BOM volume survives assessment persistence and replay without truncation",async t=>{
  const h=await application(t),fixture=industrialBudgetFixture();
  const d=document(fixture.semanticInput,fixture.evidenceInventory.map(e=>e.id));
  assert.ok(Buffer.byteLength(JSON.stringify(d))<98304,"WI05 supported fixture fits application request contract");
  const createdResponse=await h.post("/api/workbench/cases",{actionId:randomUUID(),document:d});
  assert.equal(createdResponse.status,200);const created=(await createdResponse.json()).case;
  const assessed=await h.post("/api/workbench/evaluate",{actionId:randomUUID(),caseId:created.caseId,expectedVersion:0});
  assert.equal(assessed.status,200);const pin=(await assessed.json()).evaluation;
  assert.equal(pin.result.classification,fixture.expected.classification);
  assert.equal(pin.result.findings.length,fixture.expected.findings,"WI05 all642 finite findings persist");
  const metric=pin.result.metrics.find((m:{id:string})=>m.id==="supplied-where-used-ancestor-count");
  assert.equal(metric.numerator,"128");assert.equal(metric.denominator,"1");
  const reopened=await(await h.get("/api/workbench/case?id="+created.caseId)).json();
  assert.equal(reopened.evaluations[0].result.findings.length,642);
  const replay=await h.get("/api/workbench/replay?evaluationId="+pin.evaluationId);assert.equal(replay.status,200);assert.equal((await replay.json()).matched,true);
  const exported=await h.get("/api/workbench/export?caseId="+created.caseId),records=(await exported.text()).trimEnd().split("\n").map(line=>JSON.parse(line));
  assert.equal(records.find(r=>r.recordType==="evaluation").evaluation.result.findings.length,642);
  assert.equal(records.at(-1).complete,true);assert.equal(h.sourceReads(),0);
});
