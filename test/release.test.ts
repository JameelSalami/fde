import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
import {readRelease} from "../src/web/application.js";
const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
test("A11 release validation binds complete runtime and dependency inventories",t=>{
  const root=mkdtempSync(join(tmpdir(),"fde-release-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const files:Record<string,string>={};
  for(const path of ["dist/src/web/application.js","bin/fde-app.mjs","web/index.html","kernel/bin/fde-semantic","package.json","package-lock.json","node_modules/example/index.js"]){
    mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),"original "+path);
    if(!path.startsWith("node_modules"))files[path]=hash(readFileSync(join(root,path)));
  }
  const dependency="node_modules/example/index.js";
  writeFileSync(join(root,"dependency-manifest.json"),JSON.stringify({schema:"fde.dependencies/v1",files:{[dependency]:hash(readFileSync(join(root,dependency)))}}));
  files["dependency-manifest.json"]=hash(readFileSync(join(root,"dependency-manifest.json")));
  const manifest={schema:"fde.release/v1",releaseId:"",sourceRevision:"a".repeat(40),sourceTreeSha256:"b".repeat(64),
    kernelSha256:files["kernel/bin/fde-semantic"],nodeVersion:process.version,builtAt:"2026-10-30T04:00:00Z",configurationSchema:"fde.private-lab/v1",files};
  function save(){manifest.releaseId="fde-"+hash(JSON.stringify({revision:manifest.sourceRevision,sourceTreeSha256:manifest.sourceTreeSha256,files:manifest.files})).slice(0,16);
    writeFileSync(join(root,"release.json"),JSON.stringify(manifest));}
  save();assert.equal(readRelease(join(root,"release.json")).releaseId,manifest.releaseId);
  const original=files["dist/src/web/application.js"]!;delete files["dist/src/web/application.js"];save();
  assert.throws(()=>readRelease(join(root,"release.json")),/inventory-incomplete/,"A11 omitted executable hash refuses");
  files["dist/src/web/application.js"]=original;save();
  writeFileSync(join(root,"web/index.html"),"altered");
  assert.throws(()=>readRelease(join(root,"release.json")),/file-integrity-refused/,"A11 altered asset refuses");
  writeFileSync(join(root,"web/index.html"),"original web/index.html");
  writeFileSync(join(root,dependency),"altered");
  assert.throws(()=>readRelease(join(root,"release.json")),/dependency-integrity-refused/,"A11 altered dependency refuses");
  writeFileSync(join(root,dependency),"original "+dependency);
  assert.equal(readRelease(join(root,"release.json")).releaseId,manifest.releaseId);
});
