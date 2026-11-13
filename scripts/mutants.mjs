#!/usr/bin/env node
/** FDE-only semantic mutation runner.
 * Each selected mutant changes one source check in a disposable copy.
 * A compiler/import failure is BLOCKED; only the specific preauthored
 * independent assertion failing can count as KILLED.
 * Never reads, executes or compares Northstar/Brownfield code.
 */
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,
  symlinkSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {localToolchain} from "./local-toolchain.mjs";

const project=resolve(import.meta.dirname,"..");
const scratch=process.env.FDE_MUTANT_SCRATCH||"/tmp";
const ghc=process.env.FDE_GHC_PATH||"ghc";
const ghcDb=process.env.FDE_GHC_PACKAGE_DB||"";
const H="kernel/src/FDE/Kernel.hs",W="kernel/src/FDE/Wire.hs",P="kernel/src/FDE/History.hs",S="kernel/src/FDE/Semantic.hs";
const suite=[
 {id:"K01",file:H,old:'| dr /= 0 = "reported-gap"',next:'| dr /= 0 = "aligned-reports"'},
 {id:"K02",file:H,old:'mesNativeId binding /= nativeId mes = Left "unbound-native-identity"',next:'False = Left "unbound-native-identity"'},
 {id:"K03",file:H,old:"dr = mr - er",next:"dr = mr + er"},
 {id:"K04",file:H,old:"T.all (== '0') (T.drop 6 f)",next:"T.all (== '1') (T.drop 6 f)"},
 {id:"K05",file:H,old:"T.all (== '0') (T.drop 6 f)",next:"not (T.null f)"},
 {id:"K06",file:H,old:'["Not Started","In Process","Completed","Stopped"] &&',next:'["Not Started","In Process","Completed","Stopped"] ||'},
 {id:"K07",file:W,old:'"postingPermitted" .= False',next:'"postingPermitted" .= True'},
 {id:"K08",file:H,old:'dp /= 0 && dr /= 0 = "plan-and-report-disagreement"',next:'dp /= 0 && False = "plan-and-report-disagreement"'},
 {id:"K09",file:W,old:'"erpNativeId" .= nativeId a',next:'"erpNativeId" .= ("unsourced" :: Text)'},
 {id:"K10",file:W,old:'"admissionStatus" .= ("candidate-only" :: Text)',next:'"admissionStatus" .= ("accepted" :: Text)'},
 {id:"K11",file:W,old:'"executable" .= False',next:'"executable" .= True'},
 {id:"K12",file:W,old:'"receiptCoverage" .= ("not-covered" :: Text)',next:'"receiptCoverage" .= ("fully-observed" :: Text)'},
 {id:"K13",file:H,old:'known = elem (nativeState erp) ["Not Started","In Process","Completed","Stopped"] &&',next:'known = True &&'},
 {id:"K14",file:W,old:'candidate "report" b "reported-execution-quantity" (reported b)',next:'candidate "work-plan" b "reported-execution-quantity" (reported b)'},
 {id:"K15",file:W,old:'schema == ("fde.case/v1" :: Text)',next:'schema == ("fde.case/v2" :: Text)'},
 {id:"K16",file:W,old:'exact ["schema","erp","mes","binding"] o',next:'pure ()'},
 {id:"K17",file:H,old:'vendor erp /= "erpnext"',next:'False'},
 {id:"K18",file:P,old:'sort . nub <$> traverse admitPath paths',next:'sort . nubBy (\\a b -> initial a == initial b && terminal a == terminal b) <$> traverse admitPath paths',
  extra:{file:P,old:'import Data.List (nub,sort)',next:'import Data.List (nub,nubBy,sort)'}},
 {id:"K19",file:P,old:'edges a ++ edges b',next:'edges b ++ edges a'},
 {id:"K20",file:P,old:'[_] -> Unestablished',next:'[one] -> ConditionalUnique one'},
 {id:"K21",file:P,old:'[one] | complete -> ConditionalUnique one',next:'[one] | complete -> Unestablished'},
 {id:"K22",file:P,old:'after (foldl (\\_ next -> next) first rest) /= terminal p',
                 next:'after (foldl (\\_ next -> next) first rest) == terminal p'},
 {id:"K23",file:H,old:'mappingGrade binding /= "synthetic-native-import-reviewed"',next:'False'},
 {id:"K24",file:S,
  old:`semanticFactId = fid
    , semanticSubjectId = ""
    , semanticPropertyId = property`,
  next:`semanticFactId = fid
    , semanticSubjectId = ""
    , semanticPropertyId = "mutated-property"`},
 {id:"K25",file:S,
  old:'unknownFact "fact:physical-production" "physical-production" "not-covered-by-admitted-native-read"',
  next:'SemanticFact "fact:physical-production" sid "physical-production" (Known (BooleanValue True)) both'},
 {id:"K26",file:S,old:'| otherwise -> receipt cid Violated "known-values-differ"',
  next:'| otherwise -> receipt cid Satisfied "known-values-differ"'},
 {id:"K27",file:S,old:'(Just (Conflicting _),_) -> receipt cid Indeterminate "conflicting-value"',
  next:'(Just (Conflicting _),_) -> receipt cid Violated "conflicting-value"'},
 {id:"K28",file:S,old:'catalogMappingId = "fde.w1.synthetic-pcs-Nos/v1"',
  next:'catalogMappingId = "fde.w1.unreviewed/v1"'},
 {id:"K29",file:S,
  old:'relation NativeMES Related "The MES row concerns the bounded order, but MES DONE/reported quantity is not physical-production evidence."',
  next:'relation NativeMES Supports "The MES row concerns the bounded order, but MES DONE/reported quantity is not physical-production evidence."'},
 {id:"K30",file:S,old:'verdict = if expectedQuantity == actualQuantity then Supports else Contradicts',
  next:'verdict = Supports'},
 {id:"K31",file:S,old:'otherIrrelevant = relation OtherEvidence Irrelevant',
  next:'otherIrrelevant = relation OtherEvidence Supports'},
 {id:"PK01",file:"src/package.ts",
  old:'semantic.modelId!==catalog.modelId',
  next:'semantic.modelId===catalog.modelId && false'},
 {id:"PK02",file:"src/package.ts",
  old:'gar.corpusLane!=="grounding-reference"',
  next:'false'},
 {id:"PK03",file:"src/package.ts",
  old:'byId.get(fid)?.ownership!=="workflow-owned"',
  next:'byId.get(fid)?.ownership==="workflow-owned" && false'},
 {id:"PK04",file:"src/package.ts",
  old:'effect.vendorEffects!=="none"',
  next:'false'},
 {id:"PK05",file:"src/package.ts",
  old:'editable.some(x=>byId.get(x)?.ownership!=="workflow-owned")',
  next:'false'},
 {id:"PK06",file:"src/package.ts",
  old:'{path:"package-ir.json",content:json(ir)}',
  next:'{path:"package-ir-mutated.json",content:json(ir)}'},
 {id:"H01",file:"src/json.ts",old:'if(actual.length!==keys.length||keys.some(k=>!Object.hasOwn(p,k)))',
   next:'if(actual.length<0&&keys.some(k=>!Object.hasOwn(p,k)))'},
 {id:"H02",file:"src/model.ts",old:'if(v.vendor!==(v.role==="erp"?"erpnext":"openmes"))reject("wrong-vendor","source");',
   next:'if(v.vendor!=="erpnext"&&v.vendor!=="openmes")reject("wrong-vendor","source");'},
 {id:"H06",file:"src/compiler.ts",old:'required(x.quantity,src[quantityKey],"candidate verbatim quantity");',
   next:'required(x.quantity,String(src[quantityKey]).length>0?x.quantity:src[quantityKey],"candidate verbatim quantity");'},
 {id:"H07",file:"src/compiler.ts",old:'required(candidate.executable,false,"nonexecutable proposal");',
   next:'required(candidate.executable,candidate.executable,"nonexecutable proposal");'},
 {id:"H08",file:"src/model.ts",old:'return {...rest,capture:{querySha256:capture.querySha256,',
   next:'return {...rest,revision:"ignored-source-version",capture:{querySha256:capture.querySha256,'},
 {id:"H11",file:"src/enterprise/config.ts",old:'erp.username!=="mfg_ci_erp_ro"',
   next:'erp.username===""'},
 {id:"H12",file:"src/enterprise/erpnext.ts",old:'if(!Array.isArray(raw)||raw.length!==1||',
   next:'if(!Array.isArray(raw)||raw.length===0||'},
 {id:"H14",file:"src/disclosure.ts",old:'state:"owner-review-required" as const,',
   next:'state:"released" as const,'},
 {id:"W01",file:"src/workspace.ts",
   old:'sources:Object.freeze({erp:facet(p.erp),mes:facet(p.mes)}),',
   next:'sources:Object.freeze({erp:facet(p.erp),mes:facet(p.erp)}),'},
 {id:"W02",file:"src/workspace.ts",
   old:'sourceNativeIds:Object.freeze(candidates.map(c=>c.sourceNativeId)),',
   next:'sourceNativeIds:Object.freeze(candidates.map(c=>c.sourceBusinessId)),'},
 {id:"W03",file:"src/workspace.ts",
   old:'sourceWriteAllowed:false as const,',next:'sourceWriteAllowed:true as const,',
   extra:{file:"src/workspace.ts",old:'readonly sourceWriteAllowed:false;',
     next:'readonly sourceWriteAllowed:boolean;'}},
 {id:"W08",file:"web/app.js",
   old:'localStorage.setItem(storageKey,JSON.stringify(state.settings));',
   next:'fetch("/api/notes",{method:"POST",body:JSON.stringify(state.settings)});'},
 {id:"W09",file:"src/workspace.ts",
   old:'businessTruthAdmitted:false as const,physicalProductionCertified:false as const',
   next:'businessTruthAdmitted:false as const,physicalProductionCertified:true as const',
   extra:{file:"src/workspace.ts",old:'readonly physicalProductionCertified:false;',
     next:'readonly physicalProductionCertified:boolean;'}},
 {id:"W17",file:"src/web/server.ts",
   old:'authority:"none",vendorWriteCapability:false',
   next:'authority:"none",vendorWriteCapability:true'},
 {id:"W18",file:"src/web/server.ts",
   old:'if(!validateLocalRequest(req)){refusal(res,403,"local-origin-required");return;}',
   next:'if(false){refusal(res,403,"local-origin-required");return;}'},
 {id:"W19",file:"src/web/server.ts",
   old:'catch{refusal(res,503,"source-observation-unavailable");}',
   next:'catch{refusal(res,200,"source-observation-unavailable");}'},
 {id:"W20",file:"src/web/server.ts",
   old:'const c=snapshots.get(entries[0][1]);',
   next:'await current();\n      const c=snapshots.get(entries[0][1]);'},
 {id:"W21",file:"src/export.ts",old:'const safe=identifier||/',
   next:'const safe=identifier&&/'},
 {id:"W24",file:"src/web/server.ts",
   old:'if(options.host!==undefined&&options.host!=="127.0.0.1")',
   next:'if(false)'}
];
function run(command,args,cwd,timeout=30000){
 return spawnSync(command,args,{cwd,encoding:"utf8",timeout,maxBuffer:2*1024*1024,
    env:localToolchain()});
}
function edit(dir,entry){
 const path=join(dir,entry.file);
 const raw=readFileSync(path,"utf8");
 if(raw.split(entry.old).length!==2)throw Error("nonunique/missing mutation anchor");
 writeFileSync(path,raw.replace(entry.old,entry.next));
}
function haskell(m,dir){
 const dirSrc=join(dir,"kernel/src"),dirTest=join(dir,"kernel/test");
 cpSync(join(project,"kernel/src"),dirSrc,{recursive:true});
 cpSync(join(project,"kernel/test"),dirTest,{recursive:true});
 edit(dir,m);if(m.extra)edit(dir,m.extra);
 const bin=join(dir,"haskell-law-test");
 const c=run(ghc,["-O0","-package-db",ghcDb,"-package","aeson",
   "-i"+dirSrc,"-odir",dir,"-hidir",dir,"-o",bin,
   join(dirTest,"Spec.hs")],dir,30000);
 if(c.status!==0)return {result:"blocked",reason:"Haskell compile/link failure"};
 const t=run(bin,[m.id],dir,10000);
 const output=(t.stdout||"")+"\n"+(t.stderr||"");
 if(t.status===1&&output.includes("FAIL "+m.id+" "))return {result:"killed",reason:"selected independent Haskell law failed"};
 if(t.status===0)return {result:"survived",reason:"selected independent Haskell law passed"};
 return {result:"blocked",reason:"nonsemantic execution failure"};
}
function host(m,dir){
 cpSync(join(project,"src"),join(dir,"src"),{recursive:true});
 cpSync(join(project,"test"),join(dir,"test"),{recursive:true});
 cpSync(join(project,"web"),join(dir,"web"),{recursive:true});
 if(existsSync(join(project,"spec")))cpSync(join(project,"spec"),join(dir,"spec"),{recursive:true});
 cpSync(join(project,"tsconfig.json"),join(dir,"tsconfig.json"));
 symlinkSync(join(project,"node_modules"),join(dir,"node_modules"),"dir");
 mkdirSync(join(dir,"kernel/bin"),{recursive:true});
 symlinkSync(join(project,"kernel/bin/fde-semantic"),
    join(dir,"kernel/bin/fde-semantic"),"file");
 writeFileSync(join(dir,"package.json"),'{"type":"module","private":true}\n');
 edit(dir,m);if(m.extra)edit(dir,m.extra);
 const c=run(process.execPath,[join(project,"node_modules/typescript/bin/tsc"),
   "-p",join(dir,"tsconfig.json")],dir,30000);
 if(c.status!==0)return {result:"blocked",reason:"TypeScript compile/loader failure"};
 const file=m.id.startsWith("PK")?"package":
   m.id.startsWith("W")?
     (["W17","W18","W19","W20","W24"].includes(m.id)?"web":"workspace"):
     (m.id==="H11"||m.id==="H12"||m.id==="H14"?"enterprise":"laws");
 const t=run(process.execPath,["--test","--test-name-pattern","^"+m.id+" ",
   join(dir,"dist/test/"+file+".test.js")],dir,15000);
 const output=(t.stdout||"")+"\n"+(t.stderr||"");
 if(t.status===1&&new RegExp("not ok\\s+\\d+\\s+-\\s+"+m.id+"\\s").test(output))
   return {result:"killed",reason:"selected independent TypeScript assertion failed"};
 if(t.status===0)return {result:"survived",reason:"selected independent TypeScript assertion passed"};
 return {result:"blocked",reason:"nonsemantic execution failure"};
}
if(process.argv.length!==3||!/^(\d+|all)$/.test(process.argv[2])){
 console.error("usage: node scripts/mutants.mjs all | <1-based-batch-number>");
 process.exit(2);
}
const chosen=process.argv[2]==="all"?suite:
 suite.filter((_,i)=>Math.floor(i/6)+1===Number(process.argv[2]));
if(!chosen.length)throw Error("unknown mutation batch");
const reportDir=join(project,"reports/mutations");
mkdirSync(reportDir,{recursive:true});
let failed=false;
for(const m of chosen){
 const tmp=mkdtempSync(join(scratch,"fde-mutation-"));
 let result={id:m.id,kind:m.id.startsWith("K")?"Haskell":"host",
    result:"blocked",reason:"not run"};
 try{
  const outcome=m.id.startsWith("K")?haskell(m,tmp):host(m,tmp);
  result={...result,...outcome};
 }catch(error){
  result={...result,reason:error instanceof Error?error.message:"unknown harness failure"};
 }finally{rmSync(tmp,{recursive:true,force:true});}
 const path=join(reportDir,m.id+".json");
 writeFileSync(path,JSON.stringify({...result,scope:"FDE-only independent mutation",
   legacyParity:false,sourceTreeUnchanged:true},null,2)+"\n");
 console.log(result.id+" "+result.result+" — "+result.reason);
 if(result.result!=="killed")failed=true;
}
const ids=suite.map(m=>m.id);
const present=ids.filter(id=>existsSync(join(reportDir,id+".json")));
const counts={total:ids.length,completed:present.length,
 killed:present.filter(id=>JSON.parse(readFileSync(join(reportDir,id+".json"),"utf8")).result==="killed").length,
 survived:present.filter(id=>JSON.parse(readFileSync(join(reportDir,id+".json"),"utf8")).result==="survived").length,
 blocked:present.filter(id=>JSON.parse(readFileSync(join(reportDir,id+".json"),"utf8")).result==="blocked").length};
console.log("FDE targeted mutation status: "+JSON.stringify(counts));
if(counts.completed===counts.total){
 writeFileSync(join(project,"reports/mutations.json"),
   JSON.stringify({schema:"fde.targeted-mutations/v2",scope:"handwritten FDE only",
     noLegacyParity:true,noVendorEffects:true,counts,
     results:ids.map(id=>JSON.parse(readFileSync(join(reportDir,id+".json"),"utf8")))},null,2)+"\n");
}
if(failed)process.exitCode=1;
