import test from "node:test";
import assert from "node:assert/strict";
import {assessIndustrial,industrialCatalog} from "../src/industrial-client.js";
import type {SemanticRuntime} from "../src/semantic-runtime.js";

const result={schema:"fde.industrial-assessment/v1",kind:"triage",classification:"evidence-needed",findings:[{code:"missing:record",status:"unresolved",detail:"Acquire the required record",evidenceRefs:[]}],metrics:[],nextInvestigations:["Obtain scoped records"],limitations:["Synthetic diagnostic"],authority:"none",vendorWriteAllowed:false,physicalAcceptanceCertified:false};
const runtime=(value:unknown)=>({invoke:()=>({status:0,stdout:JSON.stringify({ok:true,result:value}),stderr:""})}) as unknown as SemanticRuntime;
test("IT01 industrial transport refuses malformed or authoritative semantic replies",()=>{
  assert.equal(assessIndustrial({},runtime(result)).classification,"evidence-needed");
  assert.throws(()=>assessIndustrial({},runtime({...result,findings:[{...result.findings[0],status:["supported"]}]})),/industrial-receipt-refused/,"IT01 status must be a string");
  assert.throws(()=>assessIndustrial({},runtime({...result,vendorWriteAllowed:true})),/industrial-receipt-refused/,"IT01 reply cannot add execution authority");
  assert.throws(()=>assessIndustrial({},runtime({...result,metrics:[{id:"bad",numerator:"1",denominator:"0",unit:"s"}]})),/industrial-receipt-refused/,"IT01 rational denominator must be positive");
  assert.throws(()=>assessIndustrial({},runtime({...result,extra:true})),/closed-object/,"IT01 unknown reply fields refuse");
});
test("IT02 industrial transport preserves exact metrics and catalog identity",()=>{
  const exact=assessIndustrial({},runtime({...result,metrics:[{id:"mean",numerator:"1",denominator:"3",unit:"s"}]}));
  assert.equal(exact.metrics[0]?.numerator,"1");assert.equal(exact.metrics[0]?.denominator,"3");
  const entry={id:"pdm",title:"PDM",concern:"pdm-bom",question:"Which definition applies?",requiredInputs:["revision"],prerequisites:[],possibleFindings:["unresolved"],limits:["Supplied context"]};
  const c={schema:"fde.industrial-catalog/v1",authority:"none",entries:[entry]};
  assert.equal(industrialCatalog(runtime(c)).entries[0]?.id,"pdm");
  assert.throws(()=>industrialCatalog(runtime({...c,entries:[entry,entry]})),/industrial-receipt-refused/,"IT02 duplicate catalog identity refuses");
});
test("IT03 larger finite BOM response budget does not widen request admission",()=>{
  const many={...result,findings:Array.from({length:129},(_,i)=>({...result.findings[0],code:"line-"+i}))};
  assert.doesNotThrow(()=>assessIndustrial({},runtime(many)),"IT03 complete multi-line findings survive output transport");
  assert.equal(assessIndustrial({},runtime(many)).findings.length,129);
  assert.throws(()=>assessIndustrial({rows:Array.from({length:129},()=>"input")},runtime(result)),/invalid-array/,"IT03 input arrays retain original boundary");
  assert.throws(()=>assessIndustrial({},runtime({...many,findings:Array.from({length:2049},(_,i)=>({...result.findings[0],code:"line-"+i}))})),/invalid-array/,"IT03 response budget remains finite");
});
test("IT04 bounded identifiers and multiline evidence prose survive transport",()=>{
  const reply={...result,findings:[{...result.findings[0],code:"where-used:"+"A".repeat(500),detail:"Reduced repetitive handling.\nMore predictable breaks.\tReported by affected group."}],metrics:[{id:"quantity:"+"P".repeat(240),numerator:"2",denominator:"1",unit:"u".repeat(240)}]};
  assert.doesNotThrow(()=>assessIndustrial({},runtime(reply)),"IT04 valid multiline evidence prose survives transport");
  assert.equal(assessIndustrial({},runtime(reply)).findings[0]?.detail,reply.findings[0]!.detail);
  assert.throws(()=>assessIndustrial({},runtime({...reply,findings:[{...reply.findings[0],detail:"Invalid\u0001control"}]})),/industrial-receipt-refused/,"IT04 invalid prose controls refuse");
});
