#!/usr/bin/env node
/** Bounded, source-bound W1 admission qualification. No vendor or model calls. */
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join,relative,resolve} from "node:path";
import {spawnSync} from "node:child_process";

const project=resolve(import.meta.dirname,"../..");
const scratch=process.env.FDE_MUTANT_SCRATCH||"/tmp";
const ghc=process.env.FDE_GHC_PATH||"ghc";
const db=process.env.FDE_GHC_PACKAGE_DB||"";
const A="kernel/src/FDE/Admission.hs",W="kernel/src/FDE/AdmissionWire.hs";
const contentCheck='sortOn candidateId members /= sortOn candidateId (expectedMembers context pinnedInput receipts)';
const suite=[
 {id:"KA01-membership",assertion:"KA01",file:A,
  old:'length members /= 4 || length (nub (map candidateId members)) /= 4',next:'False',
  extra:{file:A,old:contentCheck,next:'False'}},
 {id:"KA02-content",assertion:"KA02",file:A,old:contentCheck,next:'False'},
 {id:"KA03-revision",assertion:"KA03",file:A,old:'sourceRevision rc == revision src',next:'True'},
 {id:"KA04-authentication",assertion:"KA04",file:A,
  old:'not (and [authMatches src rc | (src,rc) <- matched])',next:'False'},
 {id:"KA05-policy",assertion:"KA05",file:A,old:'policyId context /= "fde.w1.lab-review/v1"',next:'False'},
 {id:"KA05-mapping",assertion:"KA05",file:A,old:'mappingId context /= "fde.w1.synthetic-pcs-Nos/v1"',next:'False'},
 {id:"KA06-kernel",assertion:"KA06",file:A,old:'kernelContract context /= "fde.semantic-w1/v1"',next:'False'},
 {id:"KA07-identities",assertion:"KA07",file:A,
  old:'not (all identity ids) || length (nub ids) /= length ids',next:'False'},
 {id:"KA08-grade",assertion:"KA08",file:A,
  old:'then "authenticated-lab-review" else "fixture-demonstration"',next:'then "authenticated-lab-review" else "authenticated-lab-review"'},
 {id:"KA08-mixed",assertion:"KA08",file:A,
  old:'sourceClass (erp pinnedInput) /= sourceClass (mes pinnedInput)',next:'False'},
 {id:"KA09-replay",assertion:"KA09",file:A,
  old:'if actual == expected then Right actual',next:'if True then Right actual'},
 {id:"KA10-authority",assertion:"KA10",file:W,
  old:'"physicalProductionCertified" .= False',next:'"physicalProductionCertified" .= True'},
 {id:"KA11-schema",assertion:"KA11",file:W,
  old:'unless (sort (map Key.toText (KM.keys obj)) == sort names)',next:'unless True'},
 {id:"KA12-snapshot",assertion:"KA12",file:W,
  old:'unless (renderSnapshot snapshot == v)',next:'unless True'}
];
const args=process.argv.slice(2);
const selected=args.length===0||args[0]==="all"?suite:suite.filter(m=>args.includes(m.id));
if(selected.length===0||args.some(x=>x!=="all"&&!suite.some(m=>m.id===x))){
 console.error("usage: node kernel/scripts/admission-mutants.mjs [all|<mutation-id> ...]");process.exit(2);
}
const startedAt=new Date().toISOString();
const hash=x=>createHash("sha256").update(x).digest("hex");
function walk(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(d=>
 d.isDirectory()?walk(join(dir,d.name)):[join(dir,d.name)]);}
const sourcePaths=[...walk(join(project,"kernel/src")),join(project,"kernel/test/AdmissionSpec.hs"),
 join(project,"kernel/fde-semantic.cabal"),join(project,"kernel/scripts/admission-mutants.mjs")].sort();
const source=sourcePaths.map(path=>({path:relative(project,path),sha256:hash(readFileSync(path))}));
const bindingSha256=hash(JSON.stringify(source));
function run(argv,cwd,timeout=30000){
 const r=spawnSync(argv[0],argv.slice(1),{cwd,encoding:"utf8",timeout,maxBuffer:2*1024*1024,
   env:{...process.env,TMPDIR:scratch}});
 return {argv,status:r.status,signal:r.signal,error:r.error?String(r.error):null,
   stdout:r.stdout??"",stderr:r.stderr??""};
}
function copy(dir){
 cpSync(join(project,"kernel/src"),join(dir,"kernel/src"),{recursive:true});
 mkdirSync(join(dir,"kernel/test"),{recursive:true});
 cpSync(join(project,"kernel/test/AdmissionSpec.hs"),join(dir,"kernel/test/AdmissionSpec.hs"));
}
function build(dir){return run([ghc,"-O0","-package-db",db,"-package","aeson","-i"+join(dir,"kernel/src"),
 "-odir",dir,"-hidir",dir,"-o",join(dir,"law-test"),join(dir,"kernel/test/AdmissionSpec.hs")],dir);}
function edit(dir,m){const p=join(dir,m.file),s=readFileSync(p,"utf8");
 if(s.split(m.old).length!==2)throw Error("missing or duplicate mutation anchor: "+m.file);
 writeFileSync(p,s.replace(m.old,m.next));}
function named(output,id,label){return output.split(/\r?\n/).filter(x=>x.startsWith(label+" "+id+" "));}
function classify(test,id){
 const out=test.stdout+"\n"+test.stderr;
 const fails=named(out,id,"FAIL"),passes=named(out,id,"PASS");
 const allAssertions=out.split(/\r?\n/).filter(x=>/^(PASS|FAIL) KA\d+ /.test(x));
 if(test.error||test.signal||allAssertions.length!==1)return {result:"blocked",reason:"harness, signal, missing or duplicate assertion evidence"};
 if(test.status===1&&fails.length===1&&passes.length===0)return {result:"killed",reason:"selected independent assertion failed",observedAssertion:fails[0]};
 if(test.status===0&&passes.length===1&&fails.length===0)return {result:"survived",reason:"selected independent assertion passed",observedAssertion:passes[0]};
 return {result:"blocked",reason:"nonsemantic execution failure"};
}
const base=mkdtempSync(join(scratch,"fde-admission-control-"));
const results=[];
let controlBuild,controlSuite;
try{
 copy(base);controlBuild=build(base);
 if(controlBuild.status!==0)throw Error("unchanged control compile failed");
 controlSuite=run([join(base,"law-test")],base,10000);
 if(controlSuite.status!==0||controlSuite.signal||controlSuite.error)throw Error("unchanged control suite failed");
 for(const m of selected){
  const dir=mkdtempSync(join(scratch,"fde-admission-mutant-"));
  let entry={id:m.id,assertion:m.assertion,mutation:{file:m.file,old:m.old,next:m.next,extra:m.extra??null},
    result:"blocked",reason:"not run",sourceBindingSha256:bindingSha256};
  try{
   const control=run([join(base,"law-test"),m.assertion],base,10000);
   entry.control=control;
   if(classify(control,m.assertion).result!=="survived")throw Error("selected unchanged control did not pass exactly once");
   copy(dir);edit(dir,m);if(m.extra)edit(dir,m.extra);
   const compile=build(dir);entry.compile=compile;
   if(compile.status!==0||compile.error||compile.signal){entry.reason="compiler failure; not a semantic kill";}
   else{const test=run([join(dir,"law-test"),m.assertion],dir,10000);entry={...entry,test,...classify(test,m.assertion)};}
  }catch(e){entry.reason=String(e);}
  finally{rmSync(dir,{recursive:true,force:true});}
  results.push(entry);console.log(entry.id+" "+entry.result+" "+entry.reason);
 }
}catch(e){results.push({id:"unchanged-control",result:"blocked",reason:String(e)});}
finally{rmSync(base,{recursive:true,force:true});}
const completedAt=new Date().toISOString();
const head=run(["git","rev-parse","HEAD"],project).stdout.trim();
const report={schema:"fde.w1-admission-mutations/v1",startedAt,completedAt,head,source,sourceBindingSha256:bindingSha256,
 scope:"handwritten W1 admission; selected mutants only",noVendorEffects:true,noModelCalls:true,
 controlBuild,controlSuite,counts:{selected:selected.length,killed:results.filter(x=>x.result==="killed").length,
 survived:results.filter(x=>x.result==="survived").length,blocked:results.filter(x=>x.result==="blocked").length},results};
const out=join(project,"kernel/reports","admission-mutations-"+startedAt.replace(/[:.]/g,"-")+".json");
mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({report:out,counts:report.counts,sourceBindingSha256:bindingSha256}));
if(results.length!==selected.length||results.some(x=>x.result!=="killed"))process.exitCode=1;
