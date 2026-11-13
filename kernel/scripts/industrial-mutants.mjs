#!/usr/bin/env node
/** Finite industrial semantic mutation qualification. No vendor/model calls. */
import {cpSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from "node:fs";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {resolve,join,relative} from "node:path";
import {localToolchain} from "../../scripts/local-toolchain.mjs";

const project=resolve(import.meta.dirname,"../.."),env=localToolchain();
const scratch=env.FDE_MUTANT_SCRATCH||env.TMPDIR||"/tmp",ghc=env.FDE_GHC_PATH||"ghc";
const db=env.FDE_GHC_PACKAGE_DB||"";
const domain="kernel/src/FDE/Industrial.hs",wire="kernel/src/FDE/IndustrialWire.hs";
const mutation=(assertion,old,next,file=domain,extra=[])=>({id:assertion,assertion,file,old,next,extra});
const suite=[
 mutation("I01","catalog _ = Nothing",'catalog _ = catalog "layout"'),
 mutation("I02",'&& not (measurementReady input)',"&& False"),
 mutation("I03",'["worker-observation" | workerConcern input]',"[]"),
 mutation("I04",'| effectivity input == "unknown" = "effectivity-unresolved"','| False = "effectivity-unresolved"'),
 mutation("I05",'| identity input == "conflicting" = "conflicting-identity"','| False = "conflicting-identity"'),
 mutation("I06",'| release input /= "released" = "release-unresolved"','| False = "release-unresolved"'),
 mutation("I07",'| changeApproved input && changePropagated input == Just False = "change-not-propagated"','| False = "change-not-propagated"'),
 mutation("I08",'| not revisionMatches && not (approvedAlternate input) = "revision-mismatch"','| False = "revision-mismatch"'),
 mutation("I09",'quantityKnown && engineeringUnit input == manufacturingUnit input',"quantityKnown"),
 mutation("I10",'| null refs || not revisionKnown || not quantityKnown = "evidence-incomplete"','| not revisionKnown || not quantityKnown = "evidence-incomplete"'),
 mutation("I11","sum values / fromIntegral (length values)","sum values"),
 mutation("I12",'timeFactor "min" = Just 60','timeFactor "min" = Just 1'),
 mutation("I13",'comparable = population before == population after && method before == method after && conditions before == conditions after && basis before == basis after',"comparable = True"),
 mutation("I14",'| name == "cycle" = basis o `elem` ["operator-observation","machine-observation"]','| name == "cycle" = True'),
 mutation("I15","percentage && any (>100) (a<>b)","False"),
 mutation("I16",'quality = measurementQuality before == "adequate" && measurementQuality after == "adequate"',"quality = True"),
 mutation("I17","| meanA /= 0]","| True]",domain,[{file:domain,old:"((meanA-meanB)/meanA*100)",next:"((meanA-meanB)/(if meanA == 0 then 1 else meanA)*100)"}]),
 mutation("I18","normalized <- canonicalQuantity text","normalized <- canonicalQuantity (if T.isInfixOf \".\" text then T.takeWhile (/= '.') text else text)"),
 mutation("I19","localComplete = not (null (localObservations input))","localComplete = True"),
 mutation("I20","acceptanceComplete = reviewerKnown && not (null (acceptanceEvidence input))","acceptanceComplete = True"),
 mutation("I21","not (all (`elem` refs) (concat subsets))","False"),
 mutation("I22","net = sum cash - sum costs","net = sum cash"),
 mutation("I23",'allocationKnown = cashKnown && commitment input == "authorized" && share /= Nothing',"allocationKnown = cashKnown && share /= Nothing"),
 mutation("I24",'deliveredKnown = observationKnown && commitment input == "authorized" && delivered /= Nothing && not (null (deliveryEvidence input))','deliveredKnown = observationKnown && commitment input == "authorized" && delivered /= Nothing'),
 mutation("I25","length ids /= length (nub ids) || any (T.null . T.strip) ids","any (T.null . T.strip) ids"),
 mutation("I26","allocatable = max 0 net","allocatable = net"),
 mutation("I27",'cashKnown = observationKnown && cashScope input == "nonoverlapping" && not (null cash)',"cashKnown = observationKnown && not (null cash)"),
 mutation("I28",'observationKnown = workerObservation input == "observed" && not (null refs)',"observationKnown = not (null refs)"),
 mutation("I29",'[f "nonfinancial-outcome" (if observationKnown then Supported else Unresolved) outcome','[f "nonfinancial-outcome" Supported outcome'),
 mutation("I30","unless (sort (map Key.toText (KM.keys obj)) == sort names)","unless False",wire),
 mutation("I31",'"vendorWriteAllowed" .= False','"vendorWriteAllowed" .= True',wire),
 mutation("I32","maybe False (>100) share","False"),
 mutation("I33","not (null (requirements input)) && not (null (designs input)) && not (null (measurements input))","not (null (requirements input)) && not (null (designs input))"),
 mutation("I34","contextComplete = all (not . T.null . T.strip)","contextComplete = const True"),
 mutation("I35",'["native-records","field-definitions"','["field-definitions"'),
 mutation("I36",'"production-bom","point-of-use"','"production-bom"'),
 mutation("I37",'"process-boundary","time-observations","product-mix"','"process-boundary","product-mix"'),
 mutation("I38",'"requirement","measurement-method","inspection-observations"','"requirement","inspection-observations"'),
 mutation("I39",'"requirement","design-reference","measurement"','"requirement","measurement"'),
 mutation("I40",'"dimensions","movement-observations","worker-observation"','"dimensions","worker-observation"'),
 mutation("I41",'"asset-identity","failure-history","maintenance-records"','"asset-identity","maintenance-records"'),
 mutation("I42",'"source-lineage","freshness-requirement"','"source-lineage"'),
 mutation("I43","missing = filter (`notElem` ids) refs","missing = []"),
 mutation("I44",'incomplete = filter (\\e -> not (all nonblank [inventoryReference e,inventoryRevision e,inventoryObservedAt e])) used',"incomplete = []"),
 mutation("I45","limited = filter (nonblank . inventoryLimitations) used","limited = []"),
 mutation("I46",'if length ids /= length (nub ids) then Left "ambiguous-case-evidence" else pure ()',"if False then Left \"ambiguous-case-evidence\" else pure ()",domain,
   [{file:domain,old:'if not (validRefs ids) || any ((`notElem` ["synthetic","manual-reference"]) . inventoryOrigin) inventory',next:'if any ((`notElem` ["synthetic","manual-reference"]) . inventoryOrigin) inventory'}]),
 mutation("I47",'tag o "origin" ["synthetic","manual-reference"]','tag o "origin" ["synthetic","manual-reference","host-pinned-w1"]',wire,
   [{file:domain,old:'((`notElem` ["synthetic","manual-reference"]) . inventoryOrigin)',next:'((`notElem` ["synthetic","manual-reference","host-pinned-w1"]) . inventoryOrigin)'}]),
 mutation("I48",'Contradicted "This engineering position has no supplied manufacturing BOM line."','Supported "This engineering position has no supplied manufacturing BOM line."'),
 mutation("I49","identityResolved = (samePart && sameRevision) || sub /= Nothing","identityResolved = True"),
 mutation("I50","factor = maybe 1 snd sub","factor = 1"),
 mutation("I51","unitsMatch = lineUnit e == lineUnit m","unitsMatch = True"),
 mutation("I52",'if length positions /= length (nub positions) then Left "duplicate-bom-position" else pure ()','if False then Left "duplicate-bom-position" else pure ()'),
 mutation("I53","scoped = filter ((==bomConfiguration input) . usageConfiguration) usages","scoped = usages"),
 mutation("I54","(childId e,childRevision e)==node","childId e==fst node"),
 mutation("I55","| node `elem` stack = (done,[],True)","| node `elem` stack = (done,[],False)"),
 mutation("I56",'| bomEffectivity input /= "applicable" = "bom-applicability-unresolved"','| False = "bom-applicability-unresolved"'),
 mutation("I57",'if any (\\item -> T.null (T.strip (moneyEvidenceRef item)) || moneyEvidenceRef item `notElem` refs) items',"if False"),
 mutation("I58","itemBasisUnique = length (map moneyEvidenceRef items) == length (nub (map moneyEvidenceRef items))","itemBasisUnique = True"),
 mutation("I59","|| approvalRef sub `notElem` refs","|| False"),
 mutation("I60",'if length usageKeys /= length (nub usageKeys) then Left "duplicate-where-used-relationship" else pure ()','if False then Left "duplicate-where-used-relationship" else pure ()'),
 mutation("I61",'if lineEvidenceRef row `notElem` refs then Left "unbound-bom-line-evidence" else pure ()','if False then Left "unbound-bom-line-evidence" else pure ()'),
 mutation("I62","positions = sort (nub (map (linePosition . fst) (erows<>mrows)))","positions = drop 1 (sort (nub (map (linePosition . fst) (erows<>mrows))))"),
 mutation("I63",'usageCode p r = "where-used:"<>T.pack (show (T.length p))<>":"<>p<>":"<>T.pack (show (T.length r))<>":"<>r','usageCode p r = "where-used:"<>p<>":"<>r'),
 mutation("I64","plainIdentifier = T.all (\\c -> c >= ' ' && c /= toEnum 127)","plainIdentifier = const True")
];
const args=process.argv.slice(2),selected=!args.length||args[0]==="all"?suite:suite.filter(x=>args.includes(x.id));
if(!selected.length||args.some(x=>x!=="all"&&!suite.some(y=>y.id===x)))throw Error("Unknown industrial mutation ID");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(join(dir,x.name)):[join(dir,x.name)]);
const source=[...walk(join(project,"kernel/src")),join(project,"kernel/test/IndustrialSpec.hs"),join(project,"kernel/scripts/industrial-mutants.mjs")]
 .sort().map(path=>({path:relative(project,path),sha256:hash(readFileSync(path))}));
const sourceBindingSha256=hash(JSON.stringify(source));
function run(argv,cwd,timeout=45000){
 const r=spawnSync(argv[0],argv.slice(1),{cwd,env,encoding:"utf8",timeout,maxBuffer:4*1024*1024});
 return {argv,status:r.status,signal:r.signal,error:r.error?String(r.error):null,stdout:r.stdout??"",stderr:r.stderr??""};
}
function copy(dir){
 cpSync(join(project,"kernel/src"),join(dir,"kernel/src"),{recursive:true});
 mkdirSync(join(dir,"kernel/test"),{recursive:true});
 cpSync(join(project,"kernel/test/IndustrialSpec.hs"),join(dir,"kernel/test/IndustrialSpec.hs"));
}
function build(dir){return run([ghc,"-O0","-package-db",db,"-package","aeson","-i"+join(dir,"kernel/src"),
 "-odir",dir,"-hidir",dir,"-o",join(dir,"law-test"),join(dir,"kernel/test/IndustrialSpec.hs")],dir);}
function edit(dir,m){const path=join(dir,m.file),text=readFileSync(path,"utf8");
 if(text.split(m.old).length!==2)throw Error("Mutation anchor missing or ambiguous: "+m.id+" "+m.file);
 writeFileSync(path,text.replace(m.old,m.next));}
function classification(test,id){
 const lines=(test.stdout+"\n"+test.stderr).split(/\r?\n/).filter(x=>/^(PASS|FAIL) I\d+ /.test(x));
 if(test.error||test.signal||lines.length!==1)return {result:"blocked",reason:"Missing, duplicate, signaled, or failed harness evidence"};
 if(test.status===1&&lines[0].startsWith("FAIL "+id+" "))return {result:"killed",reason:"Intended independent assertion failed",assertionEvidence:lines[0]};
 if(test.status===0&&lines[0].startsWith("PASS "+id+" "))return {result:"survived",reason:"Intended independent assertion passed",assertionEvidence:lines[0]};
 return {result:"blocked",reason:"Nonsemantic execution failure"};
}
const startedAt=new Date().toISOString(),base=mkdtempSync(join(scratch,"fde-industrial-control-")),results=[];
let controlBuild,controlSuite;
try{
 copy(base);controlBuild=build(base);
 if(controlBuild.status!==0||controlBuild.error||controlBuild.signal)throw Error("Unchanged control compile failed");
 controlSuite=run([join(base,"law-test")],base);
 if(controlSuite.status!==0||controlSuite.error||controlSuite.signal)throw Error("Unchanged independent control suite failed");
 for(const m of selected){
  const dir=mkdtempSync(join(scratch,"fde-industrial-mutant-"));
  let entry={id:m.id,mutation:m,sourceBindingSha256,result:"blocked",reason:"Not run"};
  try{
   entry.control=run([join(base,"law-test"),m.assertion],base);
   if(classification(entry.control,m.assertion).result!=="survived")throw Error("Selected control assertion did not pass exactly once");
   copy(dir);edit(dir,m);for(const extra of m.extra)edit(dir,extra);
   entry.compile=build(dir);
   if(entry.compile.status!==0||entry.compile.error||entry.compile.signal)entry.reason="Compiler failure; not a semantic kill";
   else{entry.test=run([join(dir,"law-test"),m.assertion],dir);Object.assign(entry,classification(entry.test,m.assertion));}
  }catch(error){entry.reason=String(error);}
  finally{rmSync(dir,{recursive:true,force:true});}
  results.push(entry);console.log(entry.id+" "+entry.result+" "+entry.reason);
 }
}catch(error){results.push({id:"unchanged-control",result:"blocked",reason:String(error)});}
finally{rmSync(base,{recursive:true,force:true});}
const counts={selected:selected.length,killed:results.filter(x=>x.result==="killed").length,
 survived:results.filter(x=>x.result==="survived").length,blocked:results.filter(x=>x.result==="blocked").length};
const report={schema:"fde.industrial-mutations/v1",startedAt,completedAt:new Date().toISOString(),source,sourceBindingSha256,
 noVendorEffects:true,noModelCalls:true,controlBuild,controlSuite,counts,results};
const path=join(project,"kernel/reports","industrial-mutations-"+startedAt.replace(/[:.]/g,"-")+".json");
mkdirSync(join(project,"kernel/reports"),{recursive:true});writeFileSync(path,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({report:path,counts,sourceBindingSha256}));
if(results.length!==selected.length||results.some(x=>x.result!=="killed"))process.exitCode=1;
