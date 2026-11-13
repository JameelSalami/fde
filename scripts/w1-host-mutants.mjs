#!/usr/bin/env node
// Each host mutant is applied to an isolated copy. Compilation and setup failures
// are blocked. Only the predeclared assertion message at its exact compiled test
// line, emitted as ERR_ASSERTION by the named test, can kill the mutant.
import {spawnSync,execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync,symlinkSync,readdirSync,lstatSync} from "node:fs";
import {join,resolve,relative,dirname} from "node:path";
import {createRequire} from "node:module";
const root=resolve(import.meta.dirname,".."),scratch=process.env.FDE_MUTANT_SCRATCH||"/tmp";
const ts=createRequire(import.meta.url)("typescript");
const allSpecs=[
{"id":"C08","suite":"company-package","file":"bin/fde-app.mjs","old":"if(companyConfigured&&(!selection||!policy))","next":"if(false&&companyConfigured&&(!selection||!policy))","marker":"C08 explicit empty company config refuses before auth"},
{"id":"C07","suite":"company-package","file":"src/review-store.ts","old":"if(row.binding!==encoded)","next":"if(false&&row.binding!==encoded)","marker":"C07 new package cannot inherit prior review state"},
{"id":"C06","suite":"company-package","file":"src/semantic-runtime.ts","old":"if(sha256(bytes)!==this.sha256)","next":"if(false&&sha256(bytes)!==this.sha256)","extra":{"old":"if(sha256(readFileSync(fd))!==this.sha256)","next":"if(false&&sha256(readFileSync(fd))!==this.sha256)"},"marker":"C06 changed selected artifact never dispatches"},
{"id": "C01", "suite": "company-package", "file": "src/company-package.ts", "old": "if(!trusted||!verify(null,message(manifest,role),publicKey(trusted.publicKeyPem),Buffer.from(claim.signature,\"base64\")))", "next": "if(!trusted||(!verify(null,message(manifest,role),publicKey(trusted.publicKeyPem),Buffer.from(claim.signature,\"base64\"))&&Boolean(0)))", "marker": "C01 changed signed payload refuses"},
{"id": "C02", "suite": "company-package", "file": "src/company-package.ts", "old": "if(identities.has(identity)||keys.has(fingerprint))", "next": "if(false&&(identities.has(identity)||keys.has(fingerprint)))", "marker": "C02 one key cannot impersonate two employees"},
{"id": "C03", "suite": "company-package", "file": "src/company-package.ts", "old": "if(s.companyId!==approved.binding.companyId||s.manifestSha256!==approved.binding.manifestSha256)", "next": "if(s.companyId!==approved.binding.companyId||(false&&s.manifestSha256!==approved.binding.manifestSha256))", "marker": "C03 approved but unselected package refuses"},
{"id": "C04", "suite": "company-package", "file": "src/semantic-runtime.ts", "old": "return canonical(binding??null)===canonical(this.companyPackage??null);", "next": "return canonical(binding??null)===canonical(binding??null);", "marker": "C04 same binary different approval cannot replay"},
{"id": "C05", "suite": "company-package", "file": "src/company-package.ts", "old": "return selected.binding;", "next": "writeFileSync(join(destination,\"private-source.hs\"),readFileSync(join(dirname(selected.executable),\"private-source.hs\")));return selected.binding;", "marker": "C05 private material is absent from export"},
 {id:"A01",file:"src/web/auth.ts",old:'!timingSafeEqual(calculated,Buffer.from(material.digest,"hex"))||!user',next:'!timingSafeEqual(calculated,calculated)||!user',marker:"A01 wrong password"},
 {id:"A02",file:"src/review-store.ts",old:'if(principal.role!=="reviewer"&&principal.role!=="operator")',next:'if(principal.id.length<0)',marker:"A02 store requires reviewer role"},
 {id:"A03",file:"src/web/application.ts",old:'req.headers["content-type"]!=="application/json"||req.headers["x-fde-request"]!=="w1"',next:'req.headers["content-type"]!=="application/json"||(false&&req.headers["x-fde-request"]!=="w1")',marker:"A03 custom request header"},
 {id:"A04",file:"src/review-store.ts",old:'this.verify(stored);\n    return stored;',next:'return stored;',marker:"A04 rehashed corrupt semantics refuse"},
 {id:"A05-idempotency",test:"A05",file:"src/review-store.ts",old:'if(prior.request_digest!==digest)',next:'if(prior.request_digest!==digest&&Boolean(0))',marker:"A05 mismatched retry refuses"},
 {id:"A05-concurrency",test:"A05",file:"src/review-store.ts",old:'if(before.version!==action.expectedVersion)',next:'if(false&&before.version!==action.expectedVersion)',marker:"A05 stale concurrent version refuses"},
 {id:"A06",file:"src/review-store.ts",old:'if(before.currentness!=="latest-observed"&&before.currentness!=="same-source-case")',next:'if(false&&before.currentness!=="latest-observed"&&before.currentness!=="same-source-case")',marker:"A06 old case refuses mutation"},
 {id:"A07",file:"src/web/application.ts",old:'throw new ReviewError(503,"source-observation-unavailable")',next:'throw new ReviewError(200,"source-observation-unavailable")',marker:"A07 failed source status"},
 {id:"A08",file:"src/review-store.ts",old:'this.db.prepare(`INSERT INTO review_actions(action_id,case_id,observation_id,actor,actor_role,version,created_at,request_digest,request,response)',next:'if(false)this.db.prepare(`INSERT INTO review_actions(action_id,case_id,observation_id,actor,actor_role,version,created_at,request_digest,request,response)',marker:"A08 audit restored"},
 {id:"A09",file:"src/review-store.ts",old:'!["open","needs-investigation","reviewed"].includes',next:'!["open","needs-investigation","reviewed","stock-posted"].includes',marker:"A09 unsupported disposition"},
 {id:"A10",file:"src/review-store.ts",old:'times.some(t=>!Number.isFinite(t)||t>this.now()+5000)',next:'(!Number.isFinite(time)||time>this.now()+5000)',marker:"A10 one future source must refuse"},
 {id:"A11",file:"src/web/application.ts",old:'if(JSON.stringify(Object.keys(r.files).sort())!==JSON.stringify(expected))',next:'if(JSON.stringify(Object.keys(r.files).sort())!==JSON.stringify(expected)&&Boolean(0))',marker:"A11 omitted executable hash refuses",suite:"release"},
 {id:"A12",file:"src/web/application.ts",old:'if(existing){store.recordAttempt',next:'if(existing&&view.observationId.length<0){store.recordAttempt',marker:"A12 repeated source acquisition succeeds"},
 {id:"A13",file:"src/admission.ts",old:'kernelFingerprint(runtime)!==stored.kernelSha256',next:'(false&&kernelFingerprint(runtime)!==stored.kernelSha256)',extra:{old:'requiredKernel!==undefined&&kernelFingerprint(runtime)!==requiredKernel',next:'false&&requiredKernel!==undefined&&kernelFingerprint(runtime)!==requiredKernel'},marker:"A13 changed compiler refuses"},
 {id:"I01",file:"src/investigation.ts",old:'...selection.questionIds.flatMap(id=>questionCatalog[id].refs),"erp.report","mes.report","coverage"',next:'...selection.questionIds.flatMap(id=>questionCatalog[id].refs),"erp.report","mes.report"',marker:"I01 model cannot omit coverage limits",suite:"investigation"},
 {id:"I02",file:"src/investigation.ts",old:'s.evidenceOrder.some(id=>typeof id!=="string"||!ids.has(id))',next:'(s.evidenceOrder.some(id=>typeof id!=="string"||!ids.has(id))&&Boolean(0))',marker:"I02 unknown evidence",suite:"investigation"},
 {id:"I03",file:"src/investigation.ts",old:'object(raw,["evidenceOrder","questionIds","abstain"],"model selection")',next:'object(raw,Object.keys(raw??{}),"model selection")',marker:"I03 injected grant refused",suite:"investigation"},
 {id:"I04",file:"src/investigation.ts",old:'u.protocol!=="http:"||!local||u.username',next:'u.protocol!=="http:"||(false&&!local)||u.username',marker:"I04 public model endpoint denied",suite:"investigation"},
 {id:"I05",file:"src/investigation.ts",old:'"indeterminate-native-state":{questionIds:["native-state"],abstain:true}',next:'"indeterminate-native-state":{questionIds:["native-state"],abstain:false}',marker:"I05 indeterminate interpretation is withheld",suite:"investigation"},
 {id:"I06-provider-context",test:"I06",file:"src/json.ts",old:'return parseJsonWithLimits(text,32768,4096,true);',next:'return parseJsonWithLimits(text,32768,128,true);',marker:"I06 provider context accepted",suite:"investigation"},
 {id:"I06-provider-bytes",test:"I06",file:"src/json.ts",old:'return parseJsonWithLimits(text,32768,4096,true);',next:'return parseJsonWithLimits(text,32768,4096,false);',marker:"I06 provider byte budget",suite:"investigation"},
 {id:"I06-domain-limit",test:"I06",file:"src/json.ts",old:'return parseJsonWithLimits(text,262144,128,false);',next:'return parseJsonWithLimits(text,262144,4096,false);',marker:"I06 domain array limit unchanged",suite:"investigation"}
,
 {"id":"A14","file":"src/web/auth.ts","old":"count!==1||typeof value!==\"string\"","next":"count<1||typeof value!==\"string\"","marker":"A14 duplicate raw Authorization headers refuse","suite":"acceptance-followup"},
 {"id":"A15","file":"src/review-store.ts","old":"WHERE excluded.captured_at>=heads.captured_at","next":"WHERE 1=1","marker":"A15 regressed capture cannot replace the newer head","suite":"acceptance-followup"}
];
const requestedProfile=process.argv[3]??"all";
if(!["all","acceptance-addendum","company-packages"].includes(requestedProfile))throw Error("unknown-finite-mutation-profile");
const specs=requestedProfile==="company-packages"?allSpecs.filter(s=>s.id.startsWith("C")):requestedProfile==="acceptance-addendum"?allSpecs.filter(s=>["A14","A15"].includes(s.id)):allSpecs;
const hash=raw=>createHash("sha256").update(raw).digest("hex");
const command=(argv,cwd)=>spawnSync(argv[0],argv.slice(1),{cwd,encoding:"utf8",timeout:30000,maxBuffer:8*1024*1024});
const evidence=process.argv[2];
if(!evidence?.startsWith("/"))throw Error("absolute-new-evidence-directory-required");
mkdirSync(evidence,{mode:0o700});
const head=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
const frozen=join(evidence,"sources");mkdirSync(frozen,{mode:0o700});
for(const item of ["src","test","web","bin","tsconfig.json","package.json","package-lock.json","node_modules",
  "kernel/bin/fde-semantic","scripts/w1-host-mutants.mjs","scripts/assertion-reporter.mjs"]){
  mkdirSync(dirname(join(frozen,item)),{recursive:true,mode:0o700});cpSync(join(root,item),join(frozen,item),{recursive:true});
}
const inventory={};
function bind(dir){for(const item of readdirSync(dir).sort()){
  if(item===".bin")continue;
  const path=join(dir,item),stat=lstatSync(path);
  if(stat.isSymbolicLink())throw Error("frozen-source-symlink-refused");
  if(stat.isDirectory())bind(path);else if(stat.isFile())inventory[relative(frozen,path)]=hash(readFileSync(path));
}}
bind(frozen);
const sourceBindingSha256=hash(JSON.stringify(inventory));
writeFileSync(join(evidence,"frozen-plan.json"),JSON.stringify({schema:"fde.w1-host-mutations-plan/v1",
  frozenAt:new Date().toISOString(),profile:requestedProfile,sourceRevision:head,sourceRevisionIsAncestor:true,sourceBindingSha256,files:inventory,
  node:{version:process.version,executableSha256:hash(readFileSync(process.execPath))},specs,
  exclusions:["source credentials","application state","vendor data","Node executable bytes","OS libraries"],
  authority:"local-owner-custody; hashes detect changes, not independent authenticity"},null,2)+"\n",{flag:"wx",mode:0o600});
function copy(){
 const dir=mkdtempSync(join(scratch,"fde-host-mutant-"));
 for(const file of ["src","test","web","bin","tsconfig.json","package.json"])cpSync(join(frozen,file),join(dir,file),{recursive:true});
 symlinkSync(join(frozen,"node_modules"),join(dir,"node_modules"),"dir");mkdirSync(join(dir,"kernel/bin"),{recursive:true});
 cpSync(join(frozen,"kernel/bin/fde-semantic"),join(dir,"kernel/bin/fde-semantic"));return dir;
}
const compile=dir=>command([process.execPath,join(frozen,"node_modules/typescript/bin/tsc"),"-p",join(dir,"tsconfig.json")],dir);
function run(dir,spec){
 const suite=spec.suite??"application",id=spec.test??spec.id;
 const testFile=join(dir,"dist/test/"+suite+".test.js"),text=readFileSync(testFile,"utf8");
 const source=ts.createSourceFile(testFile,text,ts.ScriptTarget.Latest,true),lines=[];
 function visit(node){if(ts.isCallExpression(node)&&node.arguments.some(arg=>ts.isStringLiteral(arg)&&arg.text===spec.marker))lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line+1);ts.forEachChild(node,visit);}
 visit(source);
 if(lines.length!==1)throw Error("assertion-anchor-not-unique");
 const argv=[process.execPath,"--test","--test-reporter",join(frozen,"scripts/assertion-reporter.mjs"),"--test-name-pattern","^"+id+" ",testFile];
 const r=command(argv,dir);
 let events;try{events=r.stdout.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));}catch{events=[];}
 const target=events.filter(e=>["test:pass","test:fail"].includes(e.type)&&e.data.name?.startsWith(id+" ")&&!e.data.skip);
 const fails=events.filter(e=>e.type==="test:fail");
 return {r,events,target,fails,testFile,assertionLine:lines[0],argv,compiledTestSha256:hash(text)};
}
const results=[];
for(const spec of specs){
 const dir=copy();const result={id:spec.id,sourceRevision:head,sourceBindingSha256,sourceFile:spec.file,
  sourceSha256:inventory[spec.file],testSourceSha256:inventory["test/"+(spec.suite??"application")+".test.ts"],
  testSuite:spec.suite??"application",testId:spec.test??spec.id,
  intendedAssertion:spec.marker,mutation:{old:spec.old,next:spec.next,extra:spec.extra??null},result:"blocked",reason:"not-run"};
 try{
  let built=compile(dir);writeFileSync(join(evidence,spec.id+"-control-build.log"),built.stdout+built.stderr);
  if(built.error||built.status!==0)throw Error("control-compile-failed");
  const control=run(dir,spec);writeFileSync(join(evidence,spec.id+"-control.jsonl"),control.r.stdout);
  writeFileSync(join(evidence,spec.id+"-control.stderr.log"),control.r.stderr??"");
  result.control={argv:control.argv,status:control.r.status,signal:control.r.signal,compiledTestSha256:control.compiledTestSha256};
  if(control.r.status!==0||control.target.length!==1||control.target[0].type!=="test:pass"||control.fails.length)throw Error("control-not-qualified");
  const path=join(dir,spec.file),raw=readFileSync(path,"utf8");if(raw.split(spec.old).length!==2)throw Error("mutation-anchor-not-unique");
  writeFileSync(path,raw.replace(spec.old,spec.next));
  if(spec.extra){const after=readFileSync(path,"utf8");if(after.split(spec.extra.old).length!==2)throw Error("extra-anchor-not-unique");writeFileSync(path,after.replace(spec.extra.old,spec.extra.next));}
  result.variantSourceSha256=hash(readFileSync(path));
  built=compile(dir);writeFileSync(join(evidence,spec.id+"-variant-build.log"),built.stdout+built.stderr);
  if(built.error||built.status!==0)throw Error("variant-compile-blocked");
  const variant=run(dir,spec);writeFileSync(join(evidence,spec.id+"-variant.jsonl"),variant.r.stdout);
  writeFileSync(join(evidence,spec.id+"-variant.stderr.log"),variant.r.stderr??"");
  result.variant={argv:variant.argv,status:variant.r.status,signal:variant.r.signal,compiledTestSha256:variant.compiledTestSha256};
  result.assertionLocation={file:variant.testFile,line:variant.assertionLine};
  if(variant.target.length!==1)throw Error("target-missing-or-duplicate");
  if(variant.r.status===0&&variant.target[0].type==="test:pass"&&!variant.fails.length){result.result="survived";result.reason="selected assertion passed";}
  else{
   const error=variant.target[0].data?.details?.error?.cause;
   const at=variant.testFile+":"+variant.assertionLine+":";
   const firstLine=typeof error?.message==="string"?error.message.split("\n")[0]:"";
   const exactMessages=[spec.marker,"Missing expected exception: "+spec.marker,"Missing expected rejection: "+spec.marker,
     "Missing expected exception ("+spec.marker+").","Missing expected rejection ("+spec.marker+")."];
   if(variant.r.status===1&&variant.fails.length===1&&variant.target[0].type==="test:fail"&&
      error?.code==="ERR_ASSERTION"&&exactMessages.includes(firstLine)&&
      typeof error.stack==="string"&&error.stack.includes(at)){
      result.result="killed";result.reason="intended structured assertion failed at exact compiled location";
      result.observedAssertion={code:error.code,message:error.message.split("\n")[0],operator:error.operator,actual:error.actual,expected:error.expected};
   }else{result.reason="failure-not-attributed-to-intended-assertion";result.observedFailure=error??null;}
  }
 }catch(error){result.reason=error.message;}
 finally{rmSync(dir,{recursive:true,force:true});}
 results.push(result);writeFileSync(join(evidence,spec.id+".json"),JSON.stringify(result,null,2)+"\n");
 console.log(JSON.stringify({id:spec.id,result:result.result,reason:result.reason}));
}
const report={schema:"fde.w1-host-mutations/v1",recordedAt:new Date().toISOString(),sourceRevision:head,
 sourceBindingSha256,kernelSha256:inventory["kernel/bin/fde-semantic"],node:process.version,
 counts:{total:results.length,killed:results.filter(r=>r.result==="killed").length,survived:results.filter(r=>r.result==="survived").length,blocked:results.filter(r=>r.result==="blocked").length},results};
writeFileSync(join(evidence,"report.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report.counts));if(report.counts.killed!==report.counts.total)process.exitCode=1;
