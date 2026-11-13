import test from "node:test";
import assert from "node:assert/strict";
import {buildConnectedCase} from "../src/workspace.js";
import {
  projectFdeNativeGarEvidence,proposeFdeGarRelations,projectFdeGarSupport,
  type FdeGarClaimProposal
} from "../src/gar-support.js";
import {synthetic} from "./fixtures.js";

type State="supported"|"partial"|"conflict"|"no-answer"|"unknown";
function receipt(proposal:FdeGarClaimProposal,state:State,sets:{
  supporting?:ReadonlyArray<string>;
  related?:ReadonlyArray<string>;
  conflicting?:ReadonlyArray<string>;
}={}){
 const supporting=[...(sets.supporting??[])],related=[...(sets.related??[])],conflicting=[...(sets.conflicting??[])];
 return {schema:"gar.claim-support/v1",authority:"none",claimId:proposal.claimId,claim:proposal.claim,
  retrievedIds:[...proposal.retrievedIds],relations:[...proposal.relations],
  assessment:{schema:"gar.evidence-assessment/v1",authority:"none",state,
   retrievedIds:[...proposal.retrievedIds],supportingIds:supporting,relatedIds:related,
   conflictingIds:conflicting,assessmentComplete:true},
  abstentionRequired:state!=="supported",semanticWinnerSelected:false};
}
test("FDE projects exact native ERP/MES facts as authority-none GAR evidence",()=>{
 const c=buildConnectedCase(synthetic()),e=projectFdeNativeGarEvidence(c);
 assert.deepEqual(e.map(x=>x.id),[`fde-native:erp:${c.observationId}`,`fde-native:mes:${c.observationId}`]);
 assert.ok(e[0]!.text.includes(`reported=${c.sources.erp.reported} ${c.sources.erp.unit}`));
 assert.ok(e[1]!.text.includes(`reported=${c.sources.mes.reported} ${c.sources.mes.unit}`));
 assert.match(e[0]!.text,/coverage\.physical=not-covered/);
 assert.equal(e[0]!.sourceDescriptor.metadata.authority,"none");
});
test("FDE proposes structural support relations but GAR owns final support state",()=>{
 const c=buildConnectedCase(synthetic()),e=projectFdeNativeGarEvidence(c);
 const p=proposeFdeGarRelations(c,"source-coverage-limit",e);
 assert.ok(p.relations.every(x=>x.relation==="supports"));
 const panel=projectFdeGarSupport(c,receipt(p,"supported",{supporting:p.retrievedIds}),p);
 assert.equal(panel.claimSupportEstablished,true);
 assert.equal(panel.businessTruthAdmitted,false);
 assert.equal(panel.reviewAuthority,false);
 assert.equal(panel.sourceWriteAllowed,false);
});
test("physical-production claim remains partial because native rows explicitly do not cover physical evidence",()=>{
 const c=buildConnectedCase(synthetic()),e=projectFdeNativeGarEvidence(c);
 const p=proposeFdeGarRelations(c,"physical-production-occurred",e);
 assert.ok(p.relations.every(x=>x.relation==="related"));
 const panel=projectFdeGarSupport(c,receipt(p,"partial",{related:p.retrievedIds}),p);
 assert.equal(panel.claimSupportEstablished,false);
 assert.equal(panel.abstentionRequired,true);
 assert.equal(panel.businessTruthAdmitted,false);
});
test("Knowledge references in the same context cannot substitute for native fact support",()=>{
 const c=buildConnectedCase(synthetic()),native=projectFdeNativeGarEvidence(c);
 const K="sha256:"+"d".repeat(64);
 const evidence=[...native,{id:"kp-0035",passageDigest:K,sourceDescriptor:{kind:"principle"}}];
 const p=proposeFdeGarRelations(c,"native-reported-values",evidence);
 assert.equal(p.relations.at(-1)!.relation,"irrelevant");
 assert.deepEqual(p.retrievedIds.map(String),[
   ...native.map(x=>x.id+":"+x.passageDigest),"kp-0035:"+K
 ]);
});
test("FDE refuses GAR support receipt evidence/state inflation",()=>{
 const c=buildConnectedCase(synthetic()),e=projectFdeNativeGarEvidence(c);
 const p=proposeFdeGarRelations(c,"source-coverage-limit",e);
 const wrong=receipt(p,"supported",{supporting:[...p.retrievedIds,"invented"]});
 assert.throws(()=>projectFdeGarSupport(c,wrong,p),/support-evidence-refused/);
 const promoted={...receipt(p,"partial",{related:p.retrievedIds}),abstentionRequired:false};
 assert.throws(()=>projectFdeGarSupport(c,promoted,p),/abstention-refused/);
});


test("native ERP/MES GAR relations refuse a correct-looking ID with substituted source bytes or role",()=>{
  const c=buildConnectedCase(synthetic()),e=projectFdeNativeGarEvidence(c);
  const good=proposeFdeGarRelations(c,"native-reported-values",e);
  assert.equal(good.relations.length,2);
  const bad=[
    {...e[0]!,text:e[0]!.text+"\nreported=999 Nos"},
    {...e[0]!,sourceDigest:"sha256:"+"0".repeat(64)},
    {...e[0]!,sourceDescriptor:{...e[0]!.sourceDescriptor,
      metadata:{...e[0]!.sourceDescriptor.metadata,role:"mes"}}},
    {...e[0]!,sourceDescriptor:{...e[0]!.sourceDescriptor,
      metadata:{...e[0]!.sourceDescriptor.metadata,observed_at:"2026-11-01T00:00:00Z"}}}
  ];
  for(const variant of bad)
    assert.throws(()=>proposeFdeGarRelations(c,"native-reported-values",[variant,e[1]!]),
      /native-evidence-substituted/);
  assert.throws(()=>proposeFdeGarRelations(c,"native-reported-values",[e[0]!]),
    /native-evidence-missing/);
  assert.throws(()=>proposeFdeGarRelations(c,"native-reported-values",[e[0]!,e[0]!,e[1]!]),
    /native-evidence-missing-or-duplicated/);
  assert.throws(()=>proposeFdeGarRelations(c,"native-reported-values",[
    e[0]!,{...e[1]!,id:"fde-native:mes:foreign-observation"}]),
    /foreign-native-evidence-refused/);
});
