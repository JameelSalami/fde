import test from "node:test";
import assert from "node:assert/strict";
import {projectFdeSteps} from "../dist/src/step-readout.js";
import {synthetic} from "../dist/test/fixtures.js";
import {buildConnectedCase} from "../dist/src/workspace.js";
import {prepareAdmission,admitForReview,kernelFingerprint} from "../dist/src/admission.js";
const p=synthetic(),view=buildConnectedCase(p),admission=prepareAdmission(p,view);
const stored={schema:"fde.stored-observation/v1",view,admission,
  snapshot:admitForReview(admission),releaseId:"fde-0123456789abcdef",
  kernelSha256:kernelFingerprint(),acquiredAt:"2026-10-30T04:00:00.000Z"};
const review={schema:"fde.review-state/v1",caseId:view.caseId,observationId:view.observationId,
  version:0,assignee:null,disposition:"open",currentness:"latest-observed",
  latestObservationId:view.observationId,headTieCount:1,observationAgeMs:0,
  audit:[],auditTotal:0,auditTruncated:false,authority:"human-review-only",sourceWriteAllowed:false};
test("ST01 summary retains source/semantics/review boundaries",()=>{
 const r=projectFdeSteps(stored,review);
 assert.equal(r.decision,"HUMAN REVIEW PENDING");
 assert.deepEqual(r.steps.map(x=>x.id),["sources","semantics","review","vendor-effects"]);
 assert.deepEqual(r.ptq.map(x=>x.evidence),["known","known","unverified"]);
 assert.deepEqual(r.effects,[]);
 assert.equal(r.expanded,null);
 assert.equal(r.steps.at(-1).evidence,"unknown");
});
test("ST02 source, Haskell, review details expand independently",()=>{
 const source=projectFdeSteps(stored,review,"sources");
 assert.equal(source.expanded.distributedAtomicSnapshot,false);
 assert.equal(source.expanded.erp.revision,p.erp.revision);
 assert.equal(source.expanded.classification,undefined);
 const sem=projectFdeSteps(stored,review,"semantics");
 assert.equal(sem.expanded.classification,view.diagnostic.classification);
 assert.equal(sem.expanded.businessTruthAdmitted,false);
 assert.equal(sem.expanded.disposition,undefined);
 const human=projectFdeSteps(stored,review,"review");
 assert.equal(human.expanded.disposition,"open");
 assert.equal(human.expanded.classification,undefined);
});
test("ST03 tied and historical source cannot become qualified by local review",()=>{
 const v=projectFdeSteps(stored,{...review,currentness:"unresolved-tie",headTieCount:2,disposition:"reviewed"});
 assert.equal(v.decision,"SOURCE ORDER UNRESOLVED");
 assert.equal(v.ptq[0].evidence,"unverified");
 assert.equal(v.steps[0].evidence,"unverified");
 assert.equal(projectFdeSteps(stored,{...review,currentness:"stale"}).decision,"HISTORICAL OR STALE EVIDENCE");
 assert.throws(()=>projectFdeSteps(stored,{...review,authority:"owner"}),/exact FDE/);
 assert.throws(()=>projectFdeSteps(stored,review,"publish"),/exact FDE/);
});
