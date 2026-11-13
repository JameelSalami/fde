import test from "node:test";
import assert from "node:assert/strict";
import {buildConnectedCase} from "../src/workspace.js";
import {projectFdeNativeGarEvidence} from "../src/gar-support.js";
import {projectFdeNativeEvidencePair,formatFdeNativeEvidencePair,
  prepareFdeNativePairContext} from "../src/evidence-pair.js";
import {synthetic,changed} from "./fixtures.js";

const setup=()=>{
  const c=buildConnectedCase(synthetic());
  const evidence=projectFdeNativeGarEvidence(c);
  return {c,evidence};
};

test("ERP/MES typed evidence preserves independent native identity, units, revisions, query and capture",()=>{
  const {c,evidence}=setup();
  const pair=projectFdeNativeEvidencePair(c,[evidence[1],evidence[0]]);
  assert.equal(pair.schema,"fde.native-evidence-pair/v1");
  assert.equal(pair.status,"complete-pair");
  assert.deepEqual(pair.missingRoles,[]);
  assert.equal(pair.canCompareReportedQuantities,true);
  assert.equal(pair.actualComparisonPerformed,false);
  assert.equal(pair.sources.erp.vendor,"erpnext");
  assert.equal(pair.sources.mes.vendor,"openmes");
  assert.equal(pair.sources.erp.evidence?.reported,c.sources.erp.reported);
  assert.equal(pair.sources.mes.evidence?.reported,c.sources.mes.reported);
  assert.equal(pair.sources.erp.evidence?.unit,"Nos");
  assert.equal(pair.sources.mes.evidence?.unit,"pcs");
  assert.equal(pair.sources.erp.evidence?.revision,c.sources.erp.revision);
  assert.equal(pair.sources.mes.evidence?.sourceQuerySha256,c.sources.mes.capture.querySha256);
  assert.equal(pair.sources.erp.evidence?.observedAt,c.sources.erp.capture.observedAt);
  assert.equal(evidence[0]?.sourceDescriptor.metadata.lifecycle,"captured-snapshot");
  assert.equal(evidence[1]?.sourceDescriptor.metadata.source_currentness,"not-verified");
  assert.equal(pair.sources.mes.evidence?.observedAt,c.sources.mes.capture.observedAt);
  assert.equal(pair.distributedAtomicSnapshot,false);
  assert.equal(pair.stockReceiptCovered,false);
  assert.equal(pair.inventoryLedgerCovered,false);
  assert.equal(pair.physicalProductionCertified,false);
  assert.equal(pair.sourceWriteAllowed,false);
  assert.ok(pair.binding?.unit.includes("synthetic"));
  assert.match(formatFdeNativeEvidencePair(pair),/ERP \/ erpnext: PRESENT/);
  assert.match(formatFdeNativeEvidencePair(pair),/MES \/ openmes: PRESENT/);
  const context=prepareFdeNativePairContext(c,evidence);
  assert.equal(context.schema,"fde.native-evidence-model-context/v1");
  assert.equal(context.sourceIds.length,2);
  assert.ok(context.text.includes("[ERPNext source role=erp"));
  assert.ok(context.text.includes("[OpenMES source role=mes"));
  assert.ok(context.text.includes(c.sources.erp.capture.observedAt));
  assert.ok(context.text.includes(c.sources.mes.capture.observedAt));
  assert.ok(context.text.includes("NOT a simultaneous distributed atomic snapshot"));
});

test("missing ERP or MES stays visibly missing with no missing-source values or model comparison",()=>{
  const {c,evidence}=setup();
  for(const chosen of [[evidence[0]],[evidence[1]],[]]){
    const pair=projectFdeNativeEvidencePair(c,chosen);
    assert.equal(pair.status,"incomplete-pair");
    assert.equal(pair.canCompareReportedQuantities,false);
    assert.equal(pair.binding,null);
    assert.ok(pair.missingRoles.length>=1);
    for(const role of pair.missingRoles){
      assert.equal(pair.sources[role].presence,"missing");
      assert.equal(pair.sources[role].evidence,null);
      assert.match(formatFdeNativeEvidencePair(pair),new RegExp(role.toUpperCase()+" \/ .+: MISSING"));
    }
    assert.match(formatFdeNativeEvidencePair(pair),/Do not compute or claim an ERP\/MES difference/);
    assert.throws(()=>prepareFdeNativePairContext(c,chosen),/incomplete-context-refused/);
  }
});

test("substituted identity, payload, observed time, role descriptor, and source from another observation are refused",()=>{
  const {c,evidence}=setup();
  const e=evidence[0]!;
  const bad=[
    {...e,sourceDigest:"sha256:"+"0".repeat(64)},
    {...e,passageDigest:"sha256:"+"0".repeat(64)},
    {...e,sourcePath:"fde/native/mes/foreign"},
    {...e,text:e.text.replace("role=erp","role=mes")},
    {...e,startByte:1},
    {...e,sourceDescriptor:{...e.sourceDescriptor,
      metadata:{...e.sourceDescriptor.metadata,role:"mes"}}},
    {...e,sourceDescriptor:{...e.sourceDescriptor,
      metadata:{...e.sourceDescriptor.metadata,observed_at:"2026-11-01T00:00:00Z"}}}
  ];
  for(const item of bad)
    assert.throws(()=>projectFdeNativeEvidencePair(c,[item,evidence[1]]),/substituted/);
  assert.throws(()=>projectFdeNativeEvidencePair(c,[e,e]),/duplicate-source-role/);
  const later=changed(synthetic());
  (later.mes as unknown as {revision:string}).revision="native-v8";
  const foreign=projectFdeNativeGarEvidence(buildConnectedCase(later));
  assert.throws(()=>projectFdeNativeEvidencePair(c,[e,foreign[1]]),/foreign-native-evidence-refused/);
});

test("owner mapping mismatch, forged atomicity and false physical coverage are not pair-admitted",()=>{
  const {c,evidence}=setup();
  assert.throws(()=>projectFdeNativeEvidencePair({
    ...c,binding:{...c.binding,erp:{...c.binding.erp,nativeId:"foreign"}}
  },evidence),/role-or-binding-refused/);
  assert.throws(()=>projectFdeNativeEvidencePair({...c,
    observationScope:{...c.observationScope,distributedAtomicSnapshot:true as false}
  },evidence),/unqualified-observation/);
  assert.throws(()=>projectFdeNativeEvidencePair({...c,
    sources:{...c.sources,mes:{...c.sources.mes,coverage:{...c.sources.mes.coverage,physical:"proved" as "not-covered"}}}
  },evidence),/role-or-binding-refused/);
});

test("inert reference material and fake second-source labels cannot complete a native pair",()=>{
  const {c,evidence}=setup();
  assert.throws(()=>projectFdeNativeEvidencePair(c,[evidence[0],{
    id:"knowledge:mes-review",sourceDigest:evidence[1]!.sourceDigest,
    passageDigest:evidence[1]!.passageDigest,text:evidence[1]!.text
  }]),/foreign-native-evidence-refused/);
  assert.throws(()=>projectFdeNativeEvidencePair(c,[evidence[0],{
    ...evidence[1],sourceDescriptor:{...evidence[1]!.sourceDescriptor,
      metadata:{...evidence[1]!.sourceDescriptor.metadata,role:"erp"}}
  }]),/substituted/);
});
