#!/usr/bin/env node
// Finite host-law mutations. A setup/compile/crash failure is blocked, never a kill.
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,lstatSync,rmSync,symlinkSync,writeFileSync,readlinkSync,realpathSync,openSync,closeSync,fstatSync,constants} from "node:fs";
import {join,resolve,dirname,relative,isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {createRequire} from "node:module";
const root=resolve(import.meta.dirname,".."),evidence=process.argv[2];
if(!evidence||!isAbsolute(evidence))throw Error("new-absolute-evidence-directory-required");
const allSpecs=[
  {id:"WB01",file:"src/workbench-model.ts",old:'choice(r.origin,["synthetic","manual-reference"])',next:'choice(r.origin,["synthetic","manual-reference","host-pinned-w1"])',marker:"WB01 user cannot forge host provenance"},
  {id:"WB02-role",test:"WB02",file:"src/workbench-store.ts",old:'if(p.role!=="reviewer"&&p.role!=="operator")',next:'if(p.id.length<0)',marker:"WB02 viewer cannot create"},
  {id:"WB02-version",test:"WB02",file:"src/workbench-store.ts",old:'const before=this.get(action.caseId);if(before.version!==action.expectedVersion)',next:'const before=this.get(action.caseId);if(false&&before.version!==action.expectedVersion)',extra:{old:'body,docDigest,action.caseId,action.expectedVersion);',next:'body,docDigest,action.caseId,before.version);'},marker:"WB02 stale concurrent revision refuses"},
  {id:"WB03",file:"src/workbench-store.ts",old:'if(prior&&prior.request_digest!==digest)',next:'if(prior&&prior.request_digest!==digest&&Boolean(0))',marker:"WB03 altered retry refuses"},
  {id:"WB04",file:"src/workbench-store.ts",old:'await backup(this.db,destination);chmodSync(destination,0o600);',next:'await backup(this.db,destination);const broken=new DatabaseSync(destination);broken.exec("DELETE FROM workbench_revisions");broken.close();chmodSync(destination,0o600);',marker:"WB04 backup retains revision history"},
  {id:"WB05-access",test:"WB05",file:"src/workbench-store.ts",old:'if(p.role!=="operator")',next:'if(p.id.length<0)',marker:"WB05 reviewer cannot read private note"},
  {id:"WB05-export",test:"WB05",file:"src/workbench-store.ts",old:'privateWorkerNotesIncluded:false,generatedAt:',next:'privateWorkerNotesIncluded:false,privateNote:this.db.prepare("SELECT note FROM workbench_private_notes WHERE case_id=?").get(caseId),generatedAt:',marker:"WB05 ordinary handoff excludes private notes"},
  {id:"WB06",file:"src/web/workbench.ts",old:'matching.some(g=>g.revoked)',next:'(false&&matching.some(g=>g.revoked))',marker:"WB06 revocation defeats overlapping grant"},
  {id:"WB08",file:"src/web/workbench.ts",old:'req.headers["x-fde-request"]!=="workbench"',next:'(false&&req.headers["x-fde-request"]!=="workbench")',marker:"WB08 request header required"},
  {id:"WB09",file:"src/web/workbench.ts",old:'if(pin.kernelSha256!==options.kernelSha256())throw new ReviewError(409,"workbench-pinned-kernel-unavailable");',next:'if(false&&pin.kernelSha256!==options.kernelSha256())throw new ReviewError(409,"workbench-pinned-kernel-unavailable");',extra:{old:'if(pin.kernelSha256!==options.kernelSha256())throw new ReviewError(409,"workbench-kernel-changed-during-replay");',next:'if(false&&pin.kernelSha256!==options.kernelSha256())throw new ReviewError(409,"workbench-kernel-changed-during-replay");'},marker:"WB09 changed kernel cannot replay old pin"},
  {id:"WB10",file:"src/web/workbench.ts",old:'const receipt=await options.importPinnedW1(v.sourceId,v.observationId);\n          assertWorkbenchSourceGrant(principal,v.sourceId,options.sourceGrants?.()??[],now());',next:'const receipt=await options.importPinnedW1(v.sourceId,v.observationId);',marker:"WB10 authorization rechecked after acquisition"},
  {id:"WB11",file:"src/web/workbench.ts",old:'if(workbenchDigest(result)!==workbenchDigest(pin.result))',next:'if(false&&workbenchDigest(result)!==workbenchDigest(pin.result))',marker:"WB11 rehashed false result fails replay"},
  {id:"WB12",file:"src/workbench-store.ts",old:'if(current.version!==action.expectedVersion||canonical(workbenchAssessmentRequest(current.document))!==canonical(input))',next:'if(canonical(workbenchAssessmentRequest(current.document))!==canonical(input))',marker:"WB12 concurrent edit prevents stale evaluation commit"},
  {id:"WB13",file:"src/workbench-store.ts",old:'if(row.binding!==encoded)',next:'if(row.binding!==encoded&&Boolean(0))',marker:"WB13 same binary different approval cannot inherit state"},
  {id:"WB14",file:"src/web/workbench.ts",old:'assertWorkbenchSourceGrant(principal,pin.sourceId,options.sourceGrants?.()??[],now());',next:'if(Boolean(0))assertWorkbenchSourceGrant(principal,pin.sourceId,options.sourceGrants?.()??[],now());',marker:"WB14 unauthorized reader receives no imported receipt"},
  {id:"WB15-complete",test:"WB15",file:"src/workbench-store.ts",old:'"SELECT evaluation_id FROM workbench_evaluations WHERE case_id=? ORDER BY rowid").iterate',next:'"SELECT evaluation_id FROM workbench_evaluations WHERE case_id=? ORDER BY rowid LIMIT 128").iterate',marker:"WB15 complete snapshot exceeds display cap"},
  {id:"WB15-snapshot",test:"WB15",file:"src/workbench-store.ts",old:'this.db.exec("PRAGMA busy_timeout=2000; BEGIN DEFERRED;");',next:'this.db.exec("PRAGMA busy_timeout=2000;");',marker:"WB15 snapshot keeps revision boundary"},
  {id:"WB16",file:"src/workbench-store.ts",old:'const hasMore=offset+cases.length<total;',next:'const hasMore=false&&offset+cases.length<total;',marker:"WB16 extra cases are not silently hidden"},
  {id:"WB17-principal",test:"WB17",file:"src/workbench-policy.ts",old:'!/^[a-z][a-z0-9_-]{0,47}$/.test(principal)',next:'(!/^[a-z][a-z0-9_-]{0,47}$/.test(principal)&&principal!=="*")',marker:"WB17 wildcard principal refuses"},
  {id:"WB17-custody",test:"WB17",file:"src/workbench-policy.ts",old:'(file.mode&0o077)!==0',next:'((file.mode&0o077)!==0&&Boolean(0))',extra:{old:'(opened.mode&0o077)!==0',next:'((opened.mode&0o077)!==0&&Boolean(0))'},marker:"WB17 public policy file refuses"},
  {id:"WB18",file:"src/workbench-store.ts",old:'current.version!==action.expectedVersion||canonical(workbenchAssessmentRequest(current.document))!==canonical(input)',next:'current.version!==action.expectedVersion||(canonical(workbenchAssessmentRequest(current.document))!==canonical(input)&&Boolean(0))',marker:"WB18 previous evidence inventory cannot pin as current"},
  {id:"WB19",file:"src/web/workbench.ts",old:'const status=error.code==="industrial-input-budget"?413:422;',next:'const status=error.code==="industrial-input-budget"?413:503;',marker:"WB19 invalid semantic input is correctable"},
  {id:"WB20",testFile:"test/workbench-source-binding.test.ts",file:"src/review-store.ts",old:'if(stored.view?.observationId!==id)',next:'if(stored.view?.observationId!==id&&Boolean(0))',marker:"WB20 valid body under another row identity refuses"},
  {id:"WI04",testFile:"test/workbench-integration.test.ts",file:"src/web/application.ts",old:'if(options.workbenchSourceGrants&&[',next:'if(options.workbenchSourceGrants&&Boolean(0)&&[',marker:"WI04 source gate /api/cases"},
  {id:"IT01-status",test:"IT01",testFile:"test/industrial-transport.test.ts",file:"src/industrial-client.ts",old:'if(typeof f.status!=="string"||!["supported","unresolved","contradicted"].includes(f.status))',next:'if(!["supported","unresolved","contradicted"].includes(String(f.status)))',marker:"IT01 status must be a string"},
  {id:"IT01-authority",test:"IT01",testFile:"test/industrial-transport.test.ts",file:"src/industrial-client.ts",old:'result.vendorWriteAllowed!==false',next:'(result.vendorWriteAllowed!==false&&Boolean(0))',marker:"IT01 reply cannot add execution authority"},
  {id:"IT02",testFile:"test/industrial-transport.test.ts",file:"src/industrial-client.ts",old:'unique(entries.map(e=>e.id),"catalog identity");',next:'if(Boolean(0))unique(entries.map(e=>e.id),"catalog identity");',marker:"IT02 duplicate catalog identity refuses"},
  {id:"IT03",testFile:"test/industrial-transport.test.ts",file:"src/json.ts",old:'return parseJsonWithLimits(text,2097152,2048,true,65536);',next:'return parseJsonWithLimits(text,2097152,128,true,65536);',marker:"IT03 complete multi-line findings survive output transport"},
  {id:"WB21",file:"src/workbench-store.ts",old:'JSON.stringify(detachIndustrialResponse(value))',next:'JSON.stringify(detachIndustrialResponse(detach(value)))',marker:"WB21 complete result persists without truncation"},
  {id:"IT04",testFile:"test/industrial-transport.test.ts",file:"src/industrial-client.ts",old:'detail:prose(f.detail,"finding detail")',next:'detail:prose(string(f.detail,"finding detail",8192),"finding detail")',marker:"IT04 valid multiline evidence prose survives transport"}
];
const requestedIds=process.argv.slice(3),availableIds=new Set(allSpecs.map(s=>s.id));
if(new Set(requestedIds).size!==requestedIds.length||requestedIds.some(id=>!availableIds.has(id)))throw Error("invalid-finite-mutation-selection");
const specs=requestedIds.length?requestedIds.map(id=>allSpecs.find(s=>s.id===id)):allSpecs;
mkdirSync(evidence,{mode:0o700});
const hash=b=>createHash("sha256").update(b).digest("hex"),frozen=join(evidence,"sources");mkdirSync(frozen,{mode:0o700});
// npm's two TypeScript launcher links are unused: compilation invokes the frozen
// typescript/bin/tsc file directly. Validate their exact targets before excluding
// only those aliases; every other source symlink is refused, never followed.
const excludedLaunchers=[],knownLaunchers=new Map([
  ["node_modules/.bin/tsc","node_modules/typescript/bin/tsc"],
  ["node_modules/.bin/tsserver","node_modules/typescript/bin/tsserver"]
]);
function freezePart(part){
  const source=join(root,part),destination=join(frozen,part),st=lstatSync(source);
  if(st.isSymbolicLink()){
    const expected=knownLaunchers.get(part),target=expected&&join(realpathSync(root),expected);
    if(!expected||realpathSync(source)!==target||realpathSync(join(root,expected))!==target||!lstatSync(join(root,expected)).isFile())throw Error("source-symlink-refused: "+part);
    excludedLaunchers.push({path:part,link:readlinkSync(source),target:expected,targetSha256:hash(readFileSync(join(root,expected))),reason:"unused npm launcher alias; direct frozen TypeScript entrypoint is invoked"});return;
  }
  if(st.isDirectory()){
    mkdirSync(destination,{recursive:true,mode:0o700});for(const name of readdirSync(source).sort())freezePart(join(part,name));return;
  }
  if(!st.isFile())throw Error("source-file-type-refused: "+part);
  const fd=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==st.dev||opened.ino!==st.ino)throw Error("source-file-changed: "+part);
    const bytes=readFileSync(fd),after=fstatSync(fd);
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw Error("source-file-changed: "+part);
    mkdirSync(dirname(destination),{recursive:true,mode:0o700});writeFileSync(destination,bytes,{flag:"wx",mode:opened.mode&0o777});
  }finally{closeSync(fd);}
}
for(const part of ["src","test","spec","package.json","package-lock.json","tsconfig.json","node_modules","kernel/bin/fde-semantic","scripts/assertion-reporter.mjs","scripts/workbench-host-mutants.mjs"])freezePart(part);
const inventory={};function bind(path){for(const name of readdirSync(path).sort()){const file=join(path,name),s=lstatSync(file);if(s.isSymbolicLink())throw Error("frozen-symlink-refused");if(s.isDirectory())bind(file);else if(s.isFile())inventory[relative(frozen,file)]=hash(readFileSync(file));}}bind(frozen);
for(const alias of excludedLaunchers)if(inventory[alias.target]!==alias.targetSha256)throw Error("launcher-target-changed-during-freeze");
const sourceBindingSha256=hash(JSON.stringify(inventory)),ts=createRequire(join(frozen,"package.json"))("typescript");
writeFileSync(join(evidence,"plan.json"),JSON.stringify({schema:"fde.workbench-host-mutation-plan/v1",sourceBindingSha256,files:inventory,node:process.version,selectionMode:requestedIds.length?"explicit":"all",selectedSpecIds:specs.map(s=>s.id),availableSpecIds:[...availableIds],specs,excludedLaunchers,scope:"host-only synthetic tests; no source systems or credentials",authority:"owner-custody; hashes bind bytes, not independent authenticity"},null,2)+"\n");
const command=(argv,cwd)=>spawnSync(argv[0],argv.slice(1),{cwd,encoding:"utf8",timeout:60000,maxBuffer:8*1024*1024});
function copy(){const dir=mkdtempSync(join(tmpdir(),"fde-workbench-mutant-"));for(const part of ["src","test","spec","package.json","tsconfig.json"])cpSync(join(frozen,part),join(dir,part),{recursive:true});symlinkSync(join(frozen,"node_modules"),join(dir,"node_modules"),"dir");mkdirSync(join(dir,"kernel/bin"),{recursive:true});cpSync(join(frozen,"kernel/bin/fde-semantic"),join(dir,"kernel/bin/fde-semantic"));return dir;}
const compile=dir=>command([process.execPath,join(frozen,"node_modules/typescript/bin/tsc"),"-p",join(dir,"tsconfig.json")],dir);
function run(dir,spec){
  const selectedTest=spec.testFile??"test/workbench-host.test.ts";
  if(!/^test\/[a-z0-9-]+\.test\.ts$/.test(selectedTest))throw Error("invalid-finite-test-path");
  const testFile=join(dir,"dist",selectedTest.replace(/\.ts$/,".js")),source=readFileSync(testFile,"utf8"),ast=ts.createSourceFile(testFile,source,ts.ScriptTarget.Latest,true),lines=[];
  function visit(n){if(ts.isCallExpression(n)&&n.arguments.some(a=>ts.isStringLiteral(a)&&a.text===spec.marker))lines.push(ast.getLineAndCharacterOfPosition(n.getStart(ast)).line+1);ts.forEachChild(n,visit);}visit(ast);
  if(lines.length!==1)throw Error("named-assertion-not-unique");
  const id=spec.test??spec.id,argv=[process.execPath,"--test","--test-reporter",join(frozen,"scripts/assertion-reporter.mjs"),"--test-name-pattern","^"+id+" ",testFile],r=command(argv,dir);
  let events;try{events=r.stdout.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}catch{events=[];}
  return {r,argv,testFile,line:lines[0],testSha256:hash(source),target:events.filter(e=>["test:pass","test:fail"].includes(e.type)&&e.data.name?.startsWith(id+" ")&&!e.data.skip),fails:events.filter(e=>e.type==="test:fail")};
}
const results=[];
for(const spec of specs){
  const dir=copy(),result={id:spec.id,intendedAssertion:spec.marker,result:"blocked",reason:"not-run",sourceBindingSha256};
  try{
    let built=compile(dir);writeFileSync(join(evidence,spec.id+"-control-build.log"),built.stdout+built.stderr);if(built.error||built.status!==0)throw Error("control-compile-failed");
    const control=run(dir,spec);writeFileSync(join(evidence,spec.id+"-control.jsonl"),control.r.stdout);writeFileSync(join(evidence,spec.id+"-control.stderr.log"),control.r.stderr??"");
    result.control={status:control.r.status,argv:control.argv,testSha256:control.testSha256};
    if(control.r.status!==0||control.target.length!==1||control.target[0].type!=="test:pass"||control.fails.length)throw Error("control-not-qualified");
    const file=join(dir,spec.file);for(const m of [spec,...(spec.extra?[spec.extra]:[])]){const raw=readFileSync(file,"utf8");if(raw.split(m.old).length!==2)throw Error("mutation-anchor-not-unique");writeFileSync(file,raw.replace(m.old,m.next));}
    result.variantSourceSha256=hash(readFileSync(file));built=compile(dir);writeFileSync(join(evidence,spec.id+"-variant-build.log"),built.stdout+built.stderr);if(built.error||built.status!==0)throw Error("variant-compile-blocked");
    const variant=run(dir,spec);writeFileSync(join(evidence,spec.id+"-variant.jsonl"),variant.r.stdout);writeFileSync(join(evidence,spec.id+"-variant.stderr.log"),variant.r.stderr??"");
    result.variant={status:variant.r.status,argv:variant.argv,testSha256:variant.testSha256};result.assertionLocation={file:variant.testFile,line:variant.line};
    if(variant.target.length!==1)throw Error("target-missing-or-duplicate");
    if(variant.r.status===0&&variant.target[0].type==="test:pass"&&variant.fails.length===0){result.result="survived";result.reason="intended assertion passed";}
    else{
      const error=variant.target[0].data?.details?.error?.cause,first=typeof error?.message==="string"?error.message.split("\n")[0]:"";
      const messages=[spec.marker,"Missing expected exception: "+spec.marker,"Missing expected rejection: "+spec.marker,"Missing expected exception ("+spec.marker+").","Missing expected rejection ("+spec.marker+").","Got unwanted exception: "+spec.marker,"Got unwanted rejection: "+spec.marker,"Got unwanted exception ("+spec.marker+").","Got unwanted rejection ("+spec.marker+")."];
      if(variant.r.status===1&&variant.fails.length===1&&variant.target[0].type==="test:fail"&&error?.code==="ERR_ASSERTION"&&messages.includes(first)&&typeof error.stack==="string"&&error.stack.includes(variant.testFile+":"+variant.line+":")){
        result.result="killed";result.reason="intended named assertion failed at exact compiled location";result.observedAssertion={code:error.code,message:first,operator:error.operator};
      }else{result.reason="failure-not-attributed-to-intended-assertion";result.observedFailure=error??null;}
    }
  }catch(error){result.reason=error.message;}finally{rmSync(dir,{recursive:true,force:true});}
  results.push(result);writeFileSync(join(evidence,spec.id+".json"),JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify({id:spec.id,result:result.result,reason:result.reason}));
}
const counts={total:results.length,killed:results.filter(r=>r.result==="killed").length,survived:results.filter(r=>r.result==="survived").length,blocked:results.filter(r=>r.result==="blocked").length};
writeFileSync(join(evidence,"report.json"),JSON.stringify({schema:"fde.workbench-host-mutations/v1",sourceBindingSha256,node:process.version,selectedSpecIds:specs.map(s=>s.id),counts,results},null,2)+"\n");console.log(JSON.stringify(counts));if(counts.killed!==counts.total)process.exitCode=1;
