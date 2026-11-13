import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {buildConnectedCase} from "../src/workspace.js";
import {synthetic} from "./fixtures.js";

test("headless FDE evidence CLI displays source roles independently and prepares a pair only with both",()=>{
  const dir=mkdtempSync(path.join(tmpdir(),"fde-native-pair-"));
  try{
    const source=buildConnectedCase(synthetic());
    const filename=path.join(dir,"observation.json");
    writeFileSync(filename,JSON.stringify(source),{mode:0o600});
    const run=(...args:string[])=>spawnSync(process.execPath,
      ["bin/fde-evidence.mjs",...args],{
        cwd:path.resolve(""),encoding:"utf8",timeout:15000,
        maxBuffer:1024*1024
      });
    const both=run("inspect",filename,"both");
    assert.equal(both.status,0,both.stderr);
    assert.match(both.stdout,/ERP \/ erpnext: PRESENT/);
    assert.match(both.stdout,/MES \/ openmes: PRESENT/);
    assert.match(both.stdout,/reported 2.125 Nos/);
    assert.match(both.stdout,/reported 3.250 pcs/);
    assert.match(both.stdout,/Atomic snapshot: NO/);
    const partial=run("inspect",filename,"erp");
    assert.equal(partial.status,0,partial.stderr);
    assert.match(partial.stdout,/ERP \/ erpnext: PRESENT/);
    assert.match(partial.stdout,/MES \/ openmes: MISSING/);
    assert.doesNotMatch(partial.stdout,/reported 3.250 pcs/);
    assert.match(partial.stdout,/Do not compute or claim an ERP\/MES difference/);
    const json=run("inspect",filename,"mes","--json");
    assert.equal(json.status,0,json.stderr);
    const object=JSON.parse(json.stdout);
    assert.equal(object.status,"incomplete-pair");
    assert.equal(object.sources.erp.evidence,null);
    assert.equal(object.sources.mes.evidence.reported,"3.250");
    const context=run("context",filename);
    assert.equal(context.status,0,context.stderr);
    const envelope=JSON.parse(context.stdout);
    assert.equal(envelope.schema,"fde.native-evidence-model-context/v1");
    assert.equal(envelope.sourceIds.length,2);
    const tampered={...source,observationId:"obs-forged"};
    const bad=path.join(dir,"forged.json");
    writeFileSync(bad,JSON.stringify(tampered),{mode:0o600});
    const denied=run("inspect",bad,"both");
    assert.equal(denied.status,2);
    assert.equal(denied.stdout,"");
    assert.match(denied.stderr,/refused/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
