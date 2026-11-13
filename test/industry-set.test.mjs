import test from "node:test";
import assert from "node:assert/strict";
import {industrialCatalog,assessIndustrial} from "../dist/src/industrial-client.js";
import {buildIndustrySet,buildIndustryBrief,formatIndustryBriefMarkdown} from "../dist/src/industry-set.js";
import {emptyWorkbenchDocument,investigationKinds} from "../dist/src/workbench-model.js";
const kernel="a".repeat(64),catalog=industrialCatalog(),d=emptyWorkbenchDocument();
const saved={schema:"fde.workbench-case/v1",authority:"application-record-only",
 sourceWriteAllowed:false,caseId:"case-"+"1".repeat(36),version:2,createdAt:"2026-11-04",updatedAt:"2026-11-04",
 document:{...d,title:"Revision mismatch",
  engagement:{...d.engagement,processOwner:"Engineering owner"},
  investigation:{...d.investigation,kind:"pdm-bom",phase:"analyze",problem:"Different revisions"},
  evidence:[{id:"one",title:"Floor copy",reference:"synthetic:r2",revision:"r2",
   observedAt:"2026-11-04",origin:"synthetic",limitations:"unverified source"}]}};
const result=assessIndustrial({schema:"fde.industrial-assessment-request/v1",
 investigation:{kind:"triage",concern:"pdm-bom",availableEvidence:[],measurementReady:false,workerConcern:false}});
const evalRecord={schema:"fde.workbench-evaluation/v1",authority:"non-authoritative-diagnostic",
 sourceWriteAllowed:false,evaluationId:"eval-"+"2".repeat(36),caseId:saved.caseId,
 caseVersion:2,actor:"reviewer",createdAt:"2026-11-04",kernelSha256:kernel,input:{},result};
test("IS01 Haskell catalog owns the exact eight-category set",()=>{
 const set=buildIndustrySet(catalog);
 assert.equal(set.families.length,8);
 assert.deepEqual(new Set(set.families.map(x=>x.id)),new Set(investigationKinds));
 assert.ok(set.families.every(x=>x.requiredInputs.length>0));
 assert.equal(set.knowledge.sources.length,0);
 assert.throws(()=>buildIndustrySet({...catalog,entries:catalog.entries.slice(1)}),/catalog/);
});
test("IS02 current saved assessment is a candidate, not verified Knowledge",()=>{
 const b=buildIndustryBrief(saved,catalog,[evalRecord],kernel);
 assert.equal(b.assessmentState,"current-diagnostic");
 assert.equal(b.assessment?.classification,result.classification);
 assert.equal(b.evidence.items[0].qualification,"unverified");
 assert.equal(b.knowledge.state,"not-assessed");
 assert.equal(b.sourceWriteAllowed,false);
 assert.equal(b.businessTruthAdmitted,false);
 const text=formatIndustryBriefMarkdown(b);
 assert.match(text,/Engineering revision/);
 assert.match(text,/Haskell catalog prerequisites/);
 assert.match(text,/HUMAN REVIEW REQUIRED/);
 assert.match(text,/ASQ/);
});
test("IS03 historical versions and changed kernel do not promote assessment",()=>{
 assert.equal(buildIndustryBrief({...saved,version:3},catalog,[evalRecord],kernel).assessmentState,"historical-only");
 const mismatch=buildIndustryBrief(saved,catalog,[evalRecord],"b".repeat(64));
 assert.equal(mismatch.assessmentState,"kernel-unverified");
 assert.equal(mismatch.assessment,null);
 assert.equal(buildIndustryBrief(saved,catalog,[],kernel).assessmentState,"not-assessed");
});
test("IS04 hostile text escapes; forged catalog and case authority refuse",()=>{
 const hostile={...saved,document:{...saved.document,title:"<script>alert(1)</script>",
  investigation:{...saved.document.investigation,problem:"[click](javascript:alert(1))"}}};
 const text=formatIndustryBriefMarkdown(buildIndustryBrief(hostile,catalog,[],kernel));
 assert.doesNotMatch(text,/<script>/);
 assert.doesNotMatch(text,/\[click\]\(javascript:/);
 assert.throws(()=>buildIndustryBrief(saved,{...catalog,authority:"owner"},[],kernel),/catalog/);
 assert.throws(()=>buildIndustryBrief({...saved,authority:"owner"},catalog,[],kernel),/case/);
});
