import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {ReviewStore} from "../src/review-store.js";
import {buildConnectedCase} from "../src/workspace.js";
import {prepareAdmission,admitForReview,kernelFingerprint,type StoredObservation} from "../src/admission.js";
import {fingerprint} from "../src/model.js";
import {synthetic} from "./fixtures.js";

test("WB20 a valid observation cannot be returned under another observation identity",t=>{
  const now=Date.parse("2026-11-01T14:00:00Z"),dir=mkdtempSync(join(tmpdir(),"fde-source-binding-")),path=join(dir,"reviews.sqlite");
  const store=new ReviewStore(path,()=>now);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const release={releaseId:"fde-0123456789abcdef",sourceRevision:"a".repeat(40),kernelSha256:kernelFingerprint()};store.registerRelease(release);
  const pin=(reported:string):StoredObservation=>{
    const fixture=synthetic(),observedAt=new Date(now).toISOString();
    const input={...fixture,erp:{...fixture.erp,reported,capture:{...fixture.erp.capture,observedAt}},mes:{...fixture.mes,capture:{...fixture.mes.capture,observedAt}}};
    const view=buildConnectedCase(input),admission=prepareAdmission(input,view),snapshot=admitForReview(admission);
    return {schema:"fde.stored-observation/v1",view,admission,snapshot,releaseId:release.releaseId,kernelSha256:release.kernelSha256,acquiredAt:observedAt};
  };
  const first=pin("2.125"),second=pin("4.500");assert.notEqual(first.view.observationId,second.view.observationId);
  store.put(first);store.put(second);
  assert.deepEqual(store.get(first.view.observationId),first,"WB20 first valid pin is independently replayable");
  assert.deepEqual(store.get(second.view.observationId),second,"WB20 second valid pin is independently replayable");
  const corrupt=new DatabaseSync(path);
  corrupt.prepare("UPDATE observations SET body=?,digest=? WHERE id=?").run(JSON.stringify(second),fingerprint(second),first.view.observationId);corrupt.close();
  assert.throws(()=>store.get(first.view.observationId),/stored-observation-id-mismatch/,"WB20 valid body under another row identity refuses");
  assert.deepEqual(store.get(second.view.observationId),second);
});
