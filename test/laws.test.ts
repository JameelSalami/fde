import test from "node:test";
import assert from "node:assert/strict";
import {
  admitCase,admitSource,compileSemantic,verifyCompilerResponse,
  compareReadObservations,formatDiagnostic,
  parseStrictJson,FdeInputError
} from "../src/index.js";
import {synthetic,changed} from "./fixtures.js";

test("H01 strict inert envelope, owner isolation and prototype refusal",()=>{
  const a=synthetic(),snapshot=admitCase(a);
  assert.equal(snapshot.erp.nativeId,"QA-WO-41");
  assert.ok(Object.isFrozen(snapshot.erp));
  assert.throws(()=>admitCase({...a,extra:"not an FDE field"}),/closed-object/);
  let invoked=0;
  const obj=changed(a) as unknown as Record<string,unknown>;
  Object.defineProperty(obj,"mes",{enumerable:true,get(){invoked++;return a.mes;}});
  assert.throws(()=>admitCase(obj),/invalid-accessor/);
  assert.equal(invoked,0);
  assert.throws(()=>parseStrictJson('{"x":1,"x":2}'),/duplicate-key/);
});
test("H02 source-vendor and transport claims are strict host observations",()=>{
  const x=changed(synthetic());
  (x.mes as unknown as {vendor:string}).vendor="erpnext";
  assert.throws(()=>admitCase(x),/wrong-vendor/);
  const y=changed(synthetic());
  (y.erp.capture as unknown as {mode:string}).mode="source-read-only";
  assert.throws(()=>admitCase(y),/invalid-transport|invalid-source-grade/);
  const z=changed(synthetic());
  (z.mes.coverage as unknown as {physical:string}).physical="fully-proven";
  assert.throws(()=>admitCase(z),/unsupported-coverage/);
});
test("H03 Haskell owns the actual source comparison and source candidate meaning",()=>{
  const input=synthetic();
  const result=compileSemantic(input);
  assert.equal(result.schema,"fde.compiled-diagnostic/v1");
  assert.equal(result.classification,"reported-gap");
  assert.equal(result.plannedDelta,"0.0");
  assert.equal(result.reportedDelta,"1.125");
  assert.equal(result.candidates.length,4);
  assert.equal(result.candidates[0]?.family,"WorkPlan");
  assert.equal(result.candidates[2]?.family,"SourceReport");
  assert.equal(result.candidates[2]?.rootKind,"QuantityReport");
  assert.equal(result.candidates[3]?.sourceNativeId,input.mes.nativeId);
  assert.equal(result.businessTruthSelected,false);
  assert.equal(result.admissionStatus,"candidate-only");
  assert.equal(result.atomicSnapshot,false);
});
test("H04 guessed mapping is refused by Haskell, not rescued in TypeScript",()=>{
  const x=changed(synthetic());
  (x.binding.mes as unknown as {nativeId:string}).nativeId="991";
  assert.equal(admitCase(x).binding.mes.nativeId,"991");
  assert.throws(()=>compileSemantic(x),/kernel-refused/);
  const y=changed(synthetic());
  (y.binding as unknown as {grade:string}).grade="similar-name";
  assert.throws(()=>compileSemantic(y),/kernel-refused/);
});
test("H05 only Haskell calculates decimals; incomplete precision refuses",()=>{
  const x=changed(synthetic());
  (x.mes as unknown as {reported:string}).reported="3.250000001";
  assert.equal(admitSource(x.mes).reported,"3.250000001");
  assert.throws(()=>compileSemantic(x),/kernel-refused/);
  const y=changed(synthetic());
  (y.mes as unknown as {reported:string}).reported="3.250000000";
  assert.equal(compileSemantic(y).reportedDelta,"1.125");
});
test("H06 output verifier rejects forged source, extra fields and mutated facts",()=>{
  const input=synthetic(),candidate=compileSemantic(input);
  const env={ok:true,result:candidate};
  assert.equal(verifyCompilerResponse(env,input).erpNativeId,input.erp.nativeId);
  const swapped=structuredClone(env);
  (swapped.result as unknown as {mesNativeId:string}).mesNativeId="FAKE-MES-8";
  assert.throws(()=>verifyCompilerResponse(swapped,input),/compiled-receipt-refused/);
  const appended={ok:true,result:{...candidate,unreviewedActor:"admin"}};
  assert.throws(()=>verifyCompilerResponse(appended,input),/closed-object/);
  const forged=structuredClone(env);
  (forged.result.candidates[0] as unknown as {quantity:string}).quantity="90000";
  assert.throws(()=>verifyCompilerResponse(forged,input),/compiled-receipt-refused/);
});
test("H07 no compiled value may grant action, approval or trusted semantic admission",()=>{
  const input=synthetic(),out=compileSemantic(input);
  assert.equal(out.mutationCandidate.executable,false);
  const forged={ok:true,result:{
    ...out,mutationCandidate:{...out.mutationCandidate,executable:true}
  }};
  assert.throws(()=>verifyCompilerResponse(forged,input),/compiled-receipt-refused/);
  assert.throws(()=>verifyCompilerResponse({ok:true,result:{
    ...out,businessTruthSelected:true
  }},input),/compiled-receipt-refused/);
  assert.throws(()=>verifyCompilerResponse({ok:true,result:{
    ...out,atomicSnapshot:true
  }},input),/compiled-receipt-refused/);
});
test("H08 source observation currentness belongs to the host, not semantics",()=>{
  const before=synthetic();
  const later=changed(before);
  (later.mes.capture as unknown as {observedAt:string}).observedAt="2026-10-29T13:00:00Z";
  assert.equal(compareReadObservations(before,later).result,"same-observed-inputs");
  const revision=changed(before);
  (revision.erp as unknown as {revision:string}).revision="native-v10";
  const newResult=compareReadObservations(before,revision);
  assert.equal(newResult.result,"changed-observed-inputs");
  assert.equal(newResult.vendorSideCAS,false);
  assert.equal(newResult.distributedAtomicSnapshot,false);
});
test("H09 honest presentation consumes only compiled verified semantics",()=>{
  const output=compileSemantic(synthetic());
  const message=formatDiagnostic(output);
  assert.match(message,/compiled Haskell/);
  assert.match(message,/admitted truth: NO/);
  assert.match(message,/executable: false/i);
  assert.match(message,/not an atomic pair/);
  assert.equal(output.physicalProductionCertified,false);
});
test("H10 parsed untrusted JSON with an unknown key fails before compiler execution",()=>{
  assert.throws(()=>parseStrictJson('{"schema":"fde.case/v1","schema":"not v1"}'),
    FdeInputError);
  const forged=changed(synthetic());
  (forged.erp as unknown as {reported:string}).reported="8e5";
  assert.throws(()=>compileSemantic(forged),/invalid-decimal/);
});