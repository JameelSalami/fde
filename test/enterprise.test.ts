import test from "node:test";
import assert from "node:assert/strict";
import {admitLabCredentials} from "../src/enterprise/config.js";
import {ERP_SQL,projectErpRow} from "../src/enterprise/erpnext.js";
import {MES_SQL,projectMesRow} from "../src/enterprise/openmes.js";
import {compileSemantic} from "../src/index.js";
import {disclosure} from "../src/disclosure.js";

const auth=()=>({
 schema:"manufacturing.cn-sql-least-privilege/v1",
 source:"isolated-synthetic-lab",tlsRequired:true,
 erp:{username:"mfg_ci_erp_ro",host:"192.0.2.10",database:"cn_reference_20261016",
   password:"z".repeat(48)},
 mes:{username:"mfg_ci_mes_ro",clientSubnet:"198.51.100.33/32",
   database:"cn_reference_mes",password:"y".repeat(48)}
});
const time="2026-10-29T12:00:00Z";
const erpRow=()=>["MFG-WO-2026-00001","Not Started",1,"3.000000000",
 "0.000000000","Nos","2026-10-29 12:01:00"];
const mesRow=()=>["1","CNDEMO-ERP-MFG-WO-2026-00001","DONE",
 "3.00","3.00","2026-10-29 12:00:30"];

test("H11 only scoped source accounts and roles admitted by IT host",()=>{
 assert.equal(admitLabCredentials(auth()).erp.username,"mfg_ci_erp_ro");
 const root=auth();root.erp.username="root";
 assert.throws(()=>admitLabCredentials(root),/lab-auth-refused/);
 const plaintext=auth();plaintext.tlsRequired=false;
 assert.throws(()=>admitLabCredentials(plaintext),/lab-auth-refused/);
 const foreign=auth();foreign.mes.clientSubnet="0.0.0.0/0";
 assert.throws(()=>admitLabCredentials(foreign),/lab-auth-refused/);
});
test("H12 vendor-native row bounds and fixed SELECT-only SQL",()=>{
 const e=projectErpRow([erpRow()],time),m=projectMesRow([mesRow()],time);
 assert.equal(e.planned,"3.000000000");
 assert.equal(m.reported,"3.00");
 assert.throws(()=>projectErpRow([],time),/erp-source-refused/);
 assert.throws(()=>projectErpRow([erpRow(),erpRow()],time),/erp-source-refused/);
 assert.throws(()=>projectMesRow([],time),/mes-source-refused/);
 assert.throws(()=>projectMesRow([mesRow(),mesRow()],time),/mes-source-refused/);
 const foreign=erpRow();foreign[0]="OTHER";
 assert.throws(()=>projectErpRow([foreign],time),/erp-source-refused/);
 assert.match(ERP_SQL,/^SELECT /);
 assert.match(MES_SQL,/^SELECT /);
 assert.ok(!/\b(?:INSERT|DELETE|UPDATE|DROP|GRANT|POST|ACK)\b/i.test(ERP_SQL));
 assert.ok(!/\b(?:INSERT|DELETE|UPDATE|DROP|GRANT|POST|ACK)\b/i.test(MES_SQL));
});
test("H13 a native source projection is not an approval to post stock",()=>{
 const erp=projectErpRow([erpRow()],time),mes=projectMesRow([mesRow()],time);
 const report=compileSemantic({schema:"fde.case/v1",erp,mes,binding:{
   schema:"fde.native-binding/v1",grade:"synthetic-native-import-reviewed",
   erp:{instance:erp.instance,nativeId:erp.nativeId},
   mes:{instance:mes.instance,nativeId:mes.nativeId},
   unit:"synthetic-pcs-equals-Nos"
 }});
 assert.equal(report.classification,"reported-gap");
 assert.equal(report.reportedDelta,"3.0");
 assert.equal(report.sourceClass,"isolated-synthetic-native");
 assert.equal(report.physicalProductionCertified,false);
 assert.equal(report.receiptCoverage,"not-covered");
 assert.equal(report.mutationCandidate.executable,false);
});
test("H14 separate disclosure and external release remain human decisions",()=>{
 const r=disclosure();
 assert.equal(r.authority,"none");
 assert.equal(r.state,"owner-review-required");
 assert.equal(r.reasons.length,4);
});
