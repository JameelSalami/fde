#!/usr/bin/env node
/** Offline, post-fix interpretation of retained model replies. No network path. */
import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from "node:fs";
import {dirname,isAbsolute,join,relative,resolve} from "node:path";
import {performance} from "node:perf_hooks";
import {draftInvestigation} from "../dist/src/investigation.js";
import {parseStrictJson,parseProviderEnvelopeJson} from "../dist/src/json.js";

const root=resolve(import.meta.dirname,".."),[original,destination]=process.argv.slice(2);
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const requireThat=(condition,reason)=>{if(!condition)throw Error(reason);};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
function privateDirectory(path){const st=lstatSync(path);
  requireThat(isAbsolute(path)&&st.isDirectory()&&!st.isSymbolicLink()&&realpathSync(path)===resolve(path)&&(st.mode&0o077)===0&&
    (!process.getuid||st.uid===process.getuid()),"private-evidence-custody-required");}
function relativePath(path){return typeof path==="string"&&/^[A-Za-z0-9._/-]+$/.test(path)&&!isAbsolute(path)&&!path.split("/").some(x=>x===".."||x==="."||x==="");}
function bytes(path){const st=lstatSync(path);requireThat(st.isFile()&&!st.isSymbolicLink()&&st.size<=67108864,"artifact-file-refused");return readFileSync(path);}
function artifact(path){
  const raw=bytes(path);requireThat(raw.length<=2097152,"artifact-json-budget");const text=raw.toString("utf8"),value=JSON.parse(text);
  // These are our generated pretty-JSON evidence files, not domain envelopes.
  // Exact re-encoding rejects duplicate/ambiguous raw keys without widening the domain codec.
  requireThat(text===JSON.stringify(value,null,2)+"\n","noncanonical-archive-json");
  let nodes=0;function visit(v,depth){requireThat(++nodes<=50000&&depth<=32,"artifact-structure-budget");
    if(v&&typeof v==="object"){requireThat(!Array.isArray(v)||v.length<=10000,"artifact-array-budget");
      for(const [key,item] of Object.entries(v)){requireThat(!["__proto__","constructor","prototype"].includes(key),"artifact-prototype-key");visit(item,depth+1);}}
    else if(typeof v==="number")requireThat(Number.isFinite(v),"artifact-nonfinite");}
  visit(value,0);return value;
}
function writeNew(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value,null,2)+"\n",{flag:"wx",mode:0o600});}
function preserve(path,relative,expected){const raw=bytes(path);if(expected)requireThat(hash(raw)===expected,"source-changed-before-preservation");
  const out=join(destination,"sources",relative);mkdirSync(dirname(out),{recursive:true,mode:0o700});writeFileSync(out,raw,{flag:"wx",mode:0o600});return {path:relative,sha256:hash(raw)};}
function verifiedFinalLogAppend(raw,manifestSha256,inventory){
  const running=createHash("sha256");let offset=0,prefixLength=-1;
  // The original bytes must be an exact complete-line prefix, not merely a
  // parsed subset or a log whose earlier content was rewritten.
  for(let end=raw.indexOf(10);end>=0;end=raw.indexOf(10,offset)){
    running.update(raw.subarray(offset,end+1));offset=end+1;
    if(running.copy().digest("hex")===manifestSha256){requireThat(prefixLength===-1,"ambiguous-log-prefix");prefixLength=offset;}
  }
  requireThat(prefixLength>0&&prefixLength<raw.length,"manifest-log-prefix-not-found");
  const suffix=raw.subarray(prefixLength),text=suffix.toString("utf8");
  requireThat(Buffer.from(text,"utf8").equals(suffix)&&text.endsWith("\n"),"incomplete-log-suffix");
  const lines=text.slice(0,-1).split("\n");requireThat(lines.length===1&&lines[0].length>0,"unexpected-log-suffix-count");
  const record=JSON.parse(lines[0]);requireThat(JSON.stringify(record)===lines[0]&&record.event==="fde-ai-result"&&typeof record.report==="string","unexpected-log-suffix-record");
  const reportPath=resolve(record.report),relativeReport=relative(original,reportPath);
  requireThat(/^report-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(relativeReport)&&inventory.has(relativeReport)&&
    hash(bytes(reportPath))===inventory.get(relativeReport),"log-summary-report-unbound");
  const boundReport=artifact(reportPath);
  requireThat(boundReport.schema==="fde.ai-evaluation-result/v1"&&boundReport.freezeSha256===inventory.get("freeze.json")&&boundReport.plannedSlots===12,"log-summary-report-incompatible");
  const expected={event:"fde-ai-result",report:join(original,relativeReport),generationRequests:boundReport.generationRequests,
    model:boundReport.comparison.model,fixedBaseline:boundReport.comparison.fixedBaseline,
    classificationGuidedBaseline:boundReport.comparison.classificationGuidedBaseline,recommendation:boundReport.recommendation};
  requireThat(same(record,expected),"log-summary-metrics-mismatch");
  return {path:"execution.log",kind:"verified-append-only-final-summary",manifestSha256,manifestByteLength:prefixLength,
    currentSha256:hash(raw),currentByteLength:raw.length,suffixSha256:hash(suffix),suffixByteLength:suffix.length,
    suffixText:text,suffixRecords:[record],boundReport:{path:relativeReport,sha256:inventory.get(relativeReport)},
    interpretation:"Original manifest-hashed log bytes are intact; one verified final summary was appended after inventory capture"};
}

// Intentionally copied verbatim from the frozen evaluator. The hash must match
// the frozen scorerFunctionSha256 before any archived reply is interpreted.
function score(selection,expected){
  const present=expected.requiredQuestions.filter(id=>selection.questionIds.includes(id));
  const coverage=present.length/expected.requiredQuestions.length;
  const abstentionCorrect=selection.abstain===expected.abstain;
  return {requiredQuestionCoverage:coverage,abstentionCorrect,quality:0.75*coverage+0.25*Number(abstentionCorrect),
    pass:coverage===1&&abstentionCorrect};
}
function boundary(draft,c){requireThat(draft.authority==="none"&&draft.sourceWriteAllowed===false&&draft.humanReviewRequired===true&&
  draft.observationId===c.observationId&&draft.cards.some(x=>x.id==="coverage")&&draft.cards.some(x=>x.id==="erp.report")&&draft.cards.some(x=>x.id==="mes.report"),"offline-draft-boundary-refused");}
function summary(values){const scored=values.filter(x=>x.score!==null);return {slots:values.length,scored:scored.length,
  passes:scored.filter(x=>x.score.pass).length,meanQuality:scored.length?scored.reduce((n,x)=>n+x.score.quality,0)/scored.length:null,
  plannedSlotQualityLowerBound:values.reduce((n,x)=>n+(x.score?.quality??0),0)/12};}

async function main(){
  requireThat(process.argv.length===4&&isAbsolute(original)&&isAbsolute(destination)&&original!==destination,"usage: rescore-investigation-replies.mjs <original-frozen-directory> <new-private-evidence-directory>");
  privateDirectory(original);privateDirectory(dirname(destination));requireThat(!existsSync(destination),"rescore-destination-already-exists");
  const manifestNames=readdirSync(original).filter(x=>/^evidence-manifest-\d+\.json$/.test(x)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  requireThat(manifestNames.length>0,"original-evidence-manifest-missing");
  // The earliest completed-run manifest is the original observation baseline.
  const manifestName=manifestNames[0],manifest=artifact(join(original,manifestName));
  requireThat(manifest.schema==="fde.ai-retained-evidence/v1"&&Array.isArray(manifest.files),"original-evidence-manifest-refused");
  const inventory=new Map(),transportLogExceptions=[];let changedExecutionLog;
  for(const file of manifest.files){requireThat(relativePath(file.path)&&/^[a-f0-9]{64}$/.test(file.sha256)&&!inventory.has(file.path),"original-manifest-membership-refused");
    const path=join(original,file.path);requireThat(realpathSync(path)===path,"original-evidence-path-aliased: "+file.path);
    const raw=bytes(path);if(hash(raw)!==file.sha256){requireThat(file.path==="execution.log","original-evidence-altered: "+file.path);changedExecutionLog={raw,manifestSha256:file.sha256};}
    inventory.set(file.path,file.sha256);}
  // All core inputs, replies and reports above have matched their original
  // hashes before the one narrowly defined transport-log suffix is assessed.
  if(changedExecutionLog)transportLogExceptions.push(verifiedFinalLogAppend(changedExecutionLog.raw,changedExecutionLog.manifestSha256,inventory));
  function requireRetained(path){requireThat(inventory.has(path),"unbound-original-artifact: "+path);return join(original,path);}
  const frozen=artifact(requireRetained("freeze.json"));
  requireThat(frozen.schema==="fde.ai-frozen-evidence/v1"&&frozen.frozenBeforeFirstModelCall===true&&frozen.generationCalls===0,"original-freeze-refused");
  const expectedFrozen=["baselines.json","cases.json","fixtures.json","plan.json","preflight.json","prompts.json","scorer.json","source-manifest.json"];
  requireThat(same(frozen.artifacts.map(x=>x.path).sort(),expectedFrozen),"frozen-artifact-membership-refused");
  for(const file of frozen.artifacts)requireThat(inventory.get(file.path)===file.sha256&&hash(bytes(requireRetained(file.path)))===file.sha256,"frozen-artifact-binding-refused");
  const plan=artifact(requireRetained("plan.json")),fixtures=artifact(requireRetained("fixtures.json")),cases=artifact(requireRetained("cases.json")),
    prompts=artifact(requireRetained("prompts.json")),baselines=artifact(requireRetained("baselines.json")),scorer=artifact(requireRetained("scorer.json")),
    originalSources=artifact(requireRetained("source-manifest.json"));
  requireThat(plan.schema==="fde.ai-evaluation-plan/v1"&&plan.slots.length===12&&plan.maxGenerationCalls===12&&plan.retries===0&&
    plan.nodeVersion===process.version&&fixtures.length===6&&cases.length===6&&prompts.length===6&&baselines.length===12,"frozen-design-or-runtime-refused");
  requireThat(hash(score.toString())===frozen.scorerFunctionSha256,"frozen-scorer-function-mismatch");
  requireThat(same(scorer.weights,{requiredQuestionCoverage:0.75,abstentionCorrect:0.25})&&
    same(scorer.expectations,fixtures.map(f=>({id:f.id,...f.expected}))),"unchanged-scorer-expectations-refused");
  requireThat(hash(JSON.stringify(originalSources))===frozen.sourceBindingSha256,"original-source-manifest-binding-refused");
  for(const file of originalSources)requireThat(relativePath(file.path)&&inventory.get("sources/"+file.path)===file.sha256&&
    hash(bytes(requireRetained("sources/"+file.path)))===file.sha256,"original-preserved-source-refused");
  const allowedChanges=new Set(["src/json.ts","src/investigation.ts","dist/src/json.js","dist/src/json.d.ts","dist/src/investigation.js","dist/src/investigation.d.ts","scripts/evaluate-investigation.mjs"]);
  const sourceComparison=originalSources.map(file=>{
    const actual=hash(bytes(join(root,file.path))),changed=actual!==file.sha256;
    requireThat(!changed||allowedChanges.has(file.path),"unrelated-source-drift: "+file.path);
    return {path:file.path,originalSha256:file.sha256,currentSha256:actual,changed};
  });
  const slots=plan.slots.map((slot,index)=>{const stem="attempts/"+String(index+1).padStart(2,"0");
    const paths={observation:stem+".json",request:stem+"-request.json",reply:stem+"-reply.raw",tags:stem+"-tags.raw"};
    for(const path of Object.values(paths))requireRetained(path);
    const observation=artifact(join(original,paths.observation));requireThat(observation.id===slot.id&&observation.repeat===slot.repeat&&observation.generationDispatched===true,"archived-slot-observation-refused");
    const request=artifact(join(original,paths.request)),prompt=prompts.find(p=>p.id===slot.id);
    const expectedRequest={model:plan.model.model,system:prompt.system,prompt:prompt.prompt,stream:false,think:false,format:"json",keep_alive:"30s",options:plan.generationOptions};
    requireThat(same(request,expectedRequest),"archived-request-changed");
    return {...slot,paths,observation,request,prompt,rawBindings:Object.fromEntries(Object.entries(paths).map(([key,path])=>[key,{path,sha256:inventory.get(path)}]))};
  });
  mkdirSync(destination,{mode:0o700});
  const retainedCurrent=sourceComparison.map(f=>preserve(join(root,f.path),f.path,f.currentSha256));
  retainedCurrent.push(preserve(join(root,"scripts/rescore-investigation-replies.mjs"),"scripts/rescore-investigation-replies.mjs"));
  const provenance={schema:"fde.ai-offline-rescore-provenance/v1",startedAt:new Date().toISOString(),originalDirectory:original,
    originalManifest:{path:manifestName,sha256:hash(bytes(join(original,manifestName)))},originalFreezeSha256:inventory.get("freeze.json"),
    originalEvidenceVerification:{fullyHashMatchedFiles:inventory.size-transportLogExceptions.length,transportLogExceptions},
    originalScorerFunctionSha256:frozen.scorerFunctionSha256,executingScorerFunctionSha256:hash(score.toString()),
    originalSourceBindingSha256:frozen.sourceBindingSha256,sourceComparison,currentSourceManifest:retainedCurrent,
    currentSourceBindingSha256:hash(JSON.stringify(retainedCurrent)),nodeVersion:process.version,
    reason:"Separate bounded provider-envelope decoder accepts valid unused Ollama context arrays; domain/selection limits and frozen rubric unchanged",
    generationRequests:0,networkRequests:0,dynamicEvaluation:false,originalEvidenceModified:false,
    custody:"Owner-private file consistency; hashes are not external authentication"};
  writeNew(join(destination,"provenance.json"),provenance);
  const results=[];
  for(const [index,slot] of slots.entries()){
    const started=performance.now(),c=cases.find(x=>x.id===slot.id).view,expected=fixtures.find(x=>x.id===slot.id).expected;
    const result={id:slot.id,repeat:slot.repeat,rawBindings:slot.rawBindings,originalOutcome:slot.observation.outcome,
      originalStage:slot.observation.stage,originalError:slot.observation.error??null,originalLatencyMs:slot.observation.latencyMs??null,
      generationRequests:0,archivedReplyCallbacks:0,score:null,promptTokens:null,outputTokens:null};
    try{
      const tags=parseProviderEnvelopeJson(bytes(join(original,slot.paths.tags)).toString("utf8"));
      requireThat(tags.models?.some(m=>m.name===plan.model.model&&m.digest===plan.model.digest),"archived-model-digest-refused");
      const raw=parseProviderEnvelopeJson(bytes(join(original,slot.paths.reply)).toString("utf8"));
      requireThat(raw.done===true&&raw.model===plan.model.model&&typeof raw.response==="string","archived-model-reply-incomplete");
      result.promptTokens=Number.isSafeInteger(raw.prompt_eval_count)&&raw.prompt_eval_count>=0?raw.prompt_eval_count:null;
      result.outputTokens=Number.isSafeInteger(raw.eval_count)&&raw.eval_count>=0?raw.eval_count:null;
      const draft=await draftInvestigation(c,async(system,prompt)=>{
        requireThat(system===slot.prompt.system&&prompt===slot.prompt.prompt,"post-fix-prompt-drift");result.archivedReplyCallbacks++;
        return {selection:parseStrictJson(raw.response),promptTokens:Number(raw.prompt_eval_count),outputTokens:Number(raw.eval_count),modelDigest:plan.model.digest};
      });
      boundary(draft,c);result.draft=draft;result.draftLatencyScope="offline archived-reply callback and rendering; not generation";
      result.score=score({questionIds:draft.questions.map(q=>q.id),abstain:draft.abstain},expected);result.outcome="accepted-offline";result.boundaryPassed=true;
    }catch(error){result.outcome="refused-offline";result.error=String(error.message??error).slice(0,500);result.boundaryPassed=false;
      result.score={requiredQuestionCoverage:0,abstentionCorrect:false,quality:0,pass:false};}
    result.validationLatencyMs=Math.round((performance.now()-started)*1000)/1000;
    writeNew(join(destination,"slots",String(index+1).padStart(2,"0")+".json"),result);results.push(result);
  }
  const modelSummary=summary(results),fixedSummary=summary(baselines.map(x=>x.fixed)),guidedSummary=summary(baselines.map(x=>x.classificationGuided));
  const safe=results.every(x=>x.outcome==="accepted-offline"&&x.boundaryPassed&&x.score.pass);
  const improves=safe&&modelSummary.meanQuality>Math.max(fixedSummary.meanQuality,guidedSummary.meanQuality);
  const report={schema:"fde.ai-offline-post-fix-rescore/v1",reportedAt:new Date().toISOString(),provenanceSha256:hash(bytes(join(destination,"provenance.json"))),
    originalManifestSha256:provenance.originalManifest.sha256,originalFreezeSha256:provenance.originalFreezeSha256,
    originalTransportLogExceptions:transportLogExceptions,
    originalScorerFunctionSha256:frozen.scorerFunctionSha256,generationRequests:0,networkRequests:0,archivedResponses:12,results,
    comparison:{offlineModelOutput:modelSummary,unchangedFixedBaseline:fixedSummary,unchangedClassificationGuidedBaseline:guidedSummary},
    originalPipeline:{attempts:12,successfulOnlineDrafts:slots.filter(s=>s.observation.outcome==="accepted").length,
      outcomes:slots.map(s=>({id:s.id,repeat:s.repeat,outcome:s.observation.outcome,error:s.observation.error??null,latencyMs:s.observation.latencyMs??null}))},
    recommendation:{enableModel:false,status:"experimental-disabled",syntheticQualityAdvantageObserved:improves,
      reason:improves?"Offline synthetic advantage alone does not establish corrected online delivery or human usefulness":
        "No strict advantage over the strongest unchanged deterministic baseline; offline rescoring does not establish online success",
      originalFailuresPreserved:true,changesProductConfiguration:false,humanUsefulnessEstablished:false,correctedOnlinePathExercised:false},
    paidApiCostUsd:0,costScope:"No new generation or network requests; local validation compute unmeasured",
    limits:["Post-fix offline rescore, not a new prospective model run","Original transport integration failures remain failures",
      "Original generation latency is separate from offline validation latency","Six handcrafted cases; no human utility or customer adoption measurement"]};
  writeNew(join(destination,"report.json"),report);
  const outputInventory=[];function collect(path,prefix=""){for(const name of readdirSync(path).sort()){const file=join(path,name),relative=prefix+name;
    if(lstatSync(file).isDirectory())collect(file,relative+"/");else outputInventory.push({path:relative,sha256:hash(bytes(file))});}}collect(destination);
  writeNew(join(destination,"evidence-manifest.json"),{schema:"fde.ai-offline-rescore-evidence/v1",files:outputInventory});
  console.log(JSON.stringify({event:"fde-ai-offline-rescore",report:join(destination,"report.json"),generationRequests:0,archivedResponses:12,
    comparison:report.comparison,recommendation:report.recommendation}));
}
await main();
