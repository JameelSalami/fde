import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {runInNewContext} from "node:vm";
import {buildConnectedCase} from "../src/workspace.js";
import {csvCell,exportExcelCsv,exportEvidenceJson} from "../src/export.js";
import {synthetic,changed} from "./fixtures.js";

test("W01 host case retains original source identities and Haskell candidates",()=>{
  const input=synthetic(),v=buildConnectedCase(input);
  assert.equal(v.schema,"fde.connected-case/v1");
  assert.equal(v.authority,"none");
  assert.equal(v.diagnostic.classification,"reported-gap");
  assert.equal(v.diagnostic.reportedDelta,"1.125");
  assert.equal(v.sources.mes.nativeId,input.mes.nativeId);
  assert.equal(v.sources.erp.revision,input.erp.revision);
  assert.deepEqual(v.diagnostic.candidates.map(x=>x.family),
    ["WorkPlan","WorkPlan","SourceReport","SourceReport"]);
  assert.ok(Object.isFrozen(v.why));
  assert.match(v.observationId,/^obs-[a-f0-9]{64}$/);
});
test("W02 Why? points to exact source candidates, not inferred causation",()=>{
  const input=synthetic(),v=buildConnectedCase(input);
  assert.equal(v.why.length,2);
  assert.deepEqual(v.why[0]?.inputCandidates,[0,1]);
  assert.deepEqual(v.why[1]?.inputCandidates,[2,3]);
  assert.deepEqual(v.why[1]?.sourceNativeIds,[input.erp.nativeId,input.mes.nativeId]);
  assert.deepEqual(v.why[1]?.sourceQueries,[
    input.erp.capture.querySha256,input.mes.capture.querySha256
  ]);
  assert.equal(v.why[1]?.compilerValue,"1.125");
  assert.equal(v.why[1]?.interpretation,"compiled-diagnostic-not-cause");
});
test("W03 a diagnostic can never grant vendor writes or business truth",()=>{
  const input=changed(synthetic());
  (input.mes as unknown as {nativeState:string}).nativeState="DONE";
  const v=buildConnectedCase(input);
  assert.equal(v.observationScope.sourceWriteAllowed,false);
  assert.equal(v.observationScope.distributedAtomicSnapshot,false);
  assert.equal(v.observationScope.businessTruthAdmitted,false);
  assert.equal(v.diagnostic.mutationCandidate.executable,false);
  assert.equal(v.diagnostic.businessTruthSelected,false);
  assert.equal(v.diagnostic.physicalProductionCertified,false);
});
test("W08 browser-local workspace does not mutate the host's source interpretation",()=>{
  const script=readFileSync(resolve(process.cwd(),"web/app.js"),"utf8");
  assert.match(script,/localStorage/);
  assert.match(script,/textContent/);
  assert.match(script,/state.settings.note/);
  assert.doesNotMatch(script,/[.]innerHTML[ ]*=|eval[(]|new Function[(]/);
  // W1 now has explicit authenticated shared-review POSTs. Personal layout and
  // scratch notes retain their independent browser-local ownership contract.
  const saver=script.match(/function save\(\)\{[\s\S]*?\n  \}/)?.[0];
  assert.ok(saver,"personal settings save function exists");
  let sent=0,stored="";
  runInNewContext("("+saver+")()",{state:{settings:{note:"personal-only",question:"next step"}},storageKey:"fde.w1.local-surface.v1",
    localStorage:{setItem:(_key:string,value:string)=>{stored=value;}},fetch:()=>{sent++;},toast:()=>{}},{timeout:1000});
  assert.equal(sent,0,"W08 personal settings never sent to a host");
  assert.equal(JSON.parse(stored).note,"personal-only");
  const v=buildConnectedCase(synthetic());
  assert.equal(JSON.stringify(v).includes("working-note"),false);
});
test("W09 native status is not proof of posted receipt or physical execution",()=>{
  const v=buildConnectedCase(synthetic());
  assert.equal(v.sources.erp.coverage.receipt,"not-covered");
  assert.equal(v.sources.mes.coverage.physical,"not-covered");
  assert.equal(v.observationScope.physicalProductionCertified,false);
  assert.equal(v.diagnostic.admissionStatus,"candidate-only");
});
test("W21 CSV is Excel-compatible, formula-safe and keeps exact source data",()=>{
  for(const input of ["=SUM(1,2)","+SUM(1,2)","-2.00","@cmd","\t=4"]){
    const result=csvCell(input);
    assert.equal(result[0],'"');
    assert.equal(result[1],"'");
    assert.ok(!result.startsWith('"='));
  }
  assert.equal(csvCell("00123",true).slice(0,2),String.fromCharCode(34,39));
  assert.equal(csvCell('a,b"c'),'"a,b""c"');
  const v=buildConnectedCase(synthetic());
  const csv=exportExcelCsv(v);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes("Native record ID"));
  assert.ok(csv.includes("419"));
  assert.ok(csv.includes("\u0027"+"3.250"),"Quantity text must not be auto-coerced into an Excel number");
  assert.equal(csv.split("\r\n").filter(Boolean).length,5);
  assert.throws(()=>exportExcelCsv({...v,authority:"allow"} as never),
    /unverified-workspace-export/);
  assert.equal(JSON.parse(exportEvidenceJson(v)).observationId,v.observationId);
});
