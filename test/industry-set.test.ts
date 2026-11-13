import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {industrialCatalog,assessIndustrial} from "../src/industrial-client.js";
import {buildIndustrySet,buildIndustryBrief,formatIndustryBriefMarkdown} from "../src/industry-set.js";
import {emptyWorkbenchDocument,investigationKinds,workbenchAssessmentRequest,
 type WorkbenchDocument} from "../src/workbench-model.js";
import {WorkbenchStore} from "../src/workbench-store.js";
import {kernelFingerprint} from "../src/admission.js";
const actor={id:"reviewer",role:"reviewer" as const};
function sample(t:TestContext){
 const store=new WorkbenchStore(":memory:");t.after(()=>store.close());
 const d=emptyWorkbenchDocument(),doc:WorkbenchDocument={...d,title:"Synthetic review",
  evidence:[{id:"e1",title:"Source report",reference:"synthetic:source",revision:"r1",
   observedAt:"2026-11-04T04:00:00Z",origin:"synthetic",limitations:"No physical check"}]};
 return {store,saved:store.create(actor,randomUUID(),doc).case};
}
test("IS01 industrial set exactly matches the compiled Haskell eight families",()=>{
 const catalog=industrialCatalog(),set=buildIndustrySet(catalog);
 assert.equal(set.families.length,8);
 assert.deepEqual(new Set(set.families.map(x=>x.id)),new Set(investigationKinds));
 assert.equal(set.knowledge.state,"not-assessed");
 assert.deepEqual(set.knowledge.sources,[]);
 assert.throws(()=>buildIndustrySet({...catalog,entries:catalog.entries.slice(1)}),/catalog/);
});
test("IS02 the brief describes a saved diagnostic but makes no independent truth claim",t=>{
 const {store,saved}=sample(t),catalog=industrialCatalog(),kernel=kernelFingerprint();
 const input=workbenchAssessmentRequest(saved.document),result=assessIndustrial(input);
 const e=store.recordEvaluation(actor,{actionId:randomUUID(),caseId:saved.caseId,expectedVersion:0},
  input,result,kernel).evaluation;
 const b=buildIndustryBrief(store.get(saved.caseId),catalog,[e],kernel);
 assert.equal(b.family.id,"reporting");
 assert.equal(b.assessmentState,"current-diagnostic");
 assert.equal(b.assessment?.classification,result.classification);
 assert.equal(b.evidence.items[0]?.qualification,"unverified");
 assert.equal(b.knowledge.state,"not-assessed");
 assert.equal(b.sourceWriteAllowed,false);assert.equal(b.businessTruthAdmitted,false);
 const md=formatIndustryBriefMarkdown(b);
 assert.match(md,/Haskell result/);assert.match(md,/HUMAN REVIEW REQUIRED/);
 assert.match(md,/No live ERP/);assert.ok(Buffer.byteLength(md)<60000);
 const updated=store.update(actor,{actionId:randomUUID(),caseId:saved.caseId,expectedVersion:0},
  {...saved.document,title:"A later case version"}).case;
 assert.equal(buildIndustryBrief(updated,catalog,[e],kernel).assessmentState,"historical-only");
 assert.equal(buildIndustryBrief(saved,catalog,[e],"f".repeat(64)).assessmentState,"kernel-unverified");
});
test("IS03 no evaluation or untrusted candidate never becomes accepted",t=>{
 const {saved}=sample(t),catalog=industrialCatalog(),kernel=kernelFingerprint();
 const b=buildIndustryBrief(saved,catalog,[],kernel);
 assert.equal(b.assessmentState,"not-assessed");
 assert.equal(b.assessment,null);
 assert.throws(()=>buildIndustryBrief({...saved,authority:"owner"} as never,catalog,[],kernel),/saved FDE case/);
});
test("IS04 source strings remain escaped data in Markdown",t=>{
 const {saved}=sample(t),catalog=industrialCatalog();
 const attacker={...saved,document:{...saved.document,title:"<script>evil</script>",
  investigation:{...saved.document.investigation,problem:"[click](javascript:alert(1))"}}};
 const md=formatIndustryBriefMarkdown(buildIndustryBrief(attacker,catalog,[],kernelFingerprint()));
 assert.doesNotMatch(md,/<script>/);
 assert.doesNotMatch(md,/\[click\]\(javascript:/);
});
