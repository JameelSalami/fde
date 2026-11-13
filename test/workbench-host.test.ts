import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,rmSync,writeFileSync,chmodSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {emptyWorkbenchDocument,parseWorkbenchDocument,workbenchAssessmentRequest} from "../src/workbench-model.js";
import {WorkbenchStore,workbenchDigest,type WorkbenchCase} from "../src/workbench-store.js";
import {createWorkbenchHandler,assertWorkbenchSourceGrant,type WorkbenchSourceGrant,type WorkbenchHandlerOptions} from "../src/web/workbench.js";
import {createAuthenticator,makeAuthUser,admitAuthConfig,type Principal} from "../src/web/auth.js";
import {listenLocal,validateLocalRequest} from "../src/web/server.js";
import {admitWorkbenchSourcePolicy,readWorkbenchSourcePolicy} from "../src/workbench-policy.js";
import {FdeInputError} from "../src/json.js";

const now=Date.parse("2026-11-01T14:00:00Z"),kernel="b".repeat(64);
const reviewer:Principal={id:"reviewer",role:"reviewer"},viewer:Principal={id:"viewer",role:"viewer"},operator:Principal={id:"operator",role:"operator"};
const password="isolated-workbench-host-test-password-42";
const config=Promise.all([makeAuthUser("reviewer","reviewer",password),makeAuthUser("viewer","viewer",password),makeAuthUser("operator","operator",password)]).then(users=>admitAuthConfig({schema:"fde.lab-auth/v1",users}));
function temporary(t:TestContext):string{const dir=mkdtempSync(join(tmpdir(),"fde-workbench-test-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function createStore(t:TestContext){const s=new WorkbenchStore(join(temporary(t),"workbench.sqlite"),()=>now);t.after(()=>s.close());return s;}
const caseAction=(c:WorkbenchCase)=>({actionId:randomUUID(),caseId:c.caseId,expectedVersion:c.version});
const diagnostic={schema:"fde.industrial-assessment/v1",kind:"triage",classification:"evidence-needed",findings:[],metrics:[],nextInvestigations:["obtain-evidence"],limitations:["Synthetic host-test result; not domain validation"],authority:"none",vendorWriteAllowed:false,physicalAcceptanceCertified:false};
const grant:WorkbenchSourceGrant={sourceId:"w1",principals:["reviewer"],action:"read-pinned-w1",validFrom:"2026-11-01T00:00:00Z",validUntil:"2026-11-02T00:00:00Z",revoked:false};
async function host(t:TestContext,extra:Partial<WorkbenchHandlerOptions>={}){
  const store=createStore(t),auth=createAuthenticator(await config);
  const handler=createWorkbenchHandler({store,assess:()=>diagnostic,catalog:()=>({schema:"fde.industrial-catalog/v1",entries:[],authority:"none"}),kernelSha256:()=>kernel,now:()=>now,...extra});
  const server=createServer((req,res)=>{void(async()=>{
    if(!validateLocalRequest(req)){res.writeHead(403);res.end();return;}
    const principal=await auth(req);if(!principal){res.writeHead(401);res.end();return;}
    if(!await handler(req,res,principal)){res.writeHead(404);res.end();}
  })().catch(()=>{res.writeHead(500);res.end();});});
  const port=await listenLocal(server,0);t.after(()=>{server.closeAllConnections();server.close();});
  const base="http://127.0.0.1:"+port;
  const headers=(id="reviewer")=>({Authorization:"Basic "+Buffer.from(id+":"+password).toString("base64")});
  const get=(path:string,id="reviewer")=>fetch(base+"/api/workbench/"+path,{headers:headers(id)});
  const post=(path:string,input:unknown,id="reviewer")=>fetch(base+"/api/workbench/"+path,{method:"POST",headers:{...headers(id),"Content-Type":"application/json","X-FDE-Request":"workbench"},body:JSON.stringify(input)});
  return {store,base,headers,get,post};
}

test("WB01 bounded records refuse forged provenance and preserve application ownership",()=>{
  const document=emptyWorkbenchDocument();assert.equal(parseWorkbenchDocument(document).schema,"fde.workbench-document/v1");
  assert.throws(()=>parseWorkbenchDocument({...document,sourceWriteAllowed:true}),/invalid-workbench-document/,"WB01 extra authority field refused");
  const forged={...document,evidence:[{id:"e-1",title:"User supplied",reference:"ref",revision:"A",observedAt:"2026-11-01",origin:"host-pinned-w1",limitations:""}]};
  assert.throws(()=>parseWorkbenchDocument(forged),/invalid-workbench-document/,"WB01 user cannot forge host provenance");
  assert.throws(()=>parseWorkbenchDocument({...document,title:" "}),/invalid-workbench-document/);
  assert.throws(()=>parseWorkbenchDocument({...document,engagement:{...document.engagement,systems:[{id:"dup",name:"A",owner:"B",purpose:"C"},{id:"dup",name:"D",owner:"E",purpose:"F"}]}}),/invalid-workbench-document/);
  assert.equal(parseWorkbenchDocument({...document,investigation:{...document.investigation,phase:"control"}}).investigation.phase,"control","WB01 phase is a human workflow record, not evidence of success");
});
test("WB02 store role gates and finite revisions protect concurrent work",t=>{
  const store=createStore(t),doc=emptyWorkbenchDocument();
  assert.throws(()=>store.create(viewer,randomUUID(),doc),/reviewer-role-required/,"WB02 viewer cannot create");
  const first=store.create(reviewer,randomUUID(),doc).case,a=caseAction(first);
  const saved=store.update(reviewer,a,{...doc,title:"PDM change propagation"});assert.equal(saved.case.version,1);
  assert.throws(()=>store.update(reviewer,{...a,actionId:randomUUID()},{...doc,title:"Concurrent stale title"}),/workbench-version-conflict/,"WB02 stale concurrent revision refuses");
  assert.equal(store.get(first.caseId).document.title,"PDM change propagation");
  assert.equal(store.history(first.caseId).revisions.length,2);
});
test("WB03 retry identity preserves one action and detects changed payloads",t=>{
  const store=createStore(t),doc=emptyWorkbenchDocument(),id=randomUUID();
  const first=store.create(reviewer,id,doc);assert.equal(store.create(reviewer,id,doc).duplicate,true);
  assert.throws(()=>store.create(reviewer,id,{...doc,title:"Different"}),/idempotency-key-reused/,"WB03 altered retry refuses");
  assert.throws(()=>store.create(operator,id,doc),/idempotency-key-reused/,"WB03 different actor cannot adopt retry");
  const a=caseAction(first.case);store.update(reviewer,a,{...doc,title:"One update"});
  assert.equal(store.update(reviewer,a,{...doc,title:"One update"}).duplicate,true);
  assert.equal(store.history(first.case.caseId).revisions.length,2,"WB03 retry creates no extra revision");
});
test("WB04 records and diagnostic pins survive restart and restore",async t=>{
  const dir=temporary(t),path=join(dir,"workbench.sqlite"),copy=join(dir,"restore.sqlite");
  const first=new WorkbenchStore(path,()=>now),c=first.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  const e=first.recordEvaluation(reviewer,caseAction(c),workbenchAssessmentRequest(c.document),diagnostic,kernel).evaluation;
  await first.backup(copy);first.close();
  const reopened=new WorkbenchStore(path,()=>now),restored=new WorkbenchStore(copy,()=>now);t.after(()=>{reopened.close();restored.close();});
  assert.deepEqual(reopened.get(c.caseId),c,"WB04 case survives restart");
  assert.deepEqual(restored.evaluation(e.evaluationId),e,"WB04 backup retains exact diagnostic pin");
  assert.equal(restored.history(c.caseId).revisions.length,1,"WB04 backup retains revision history");assert.equal(restored.ready(),true);
});
test("WB05 private worker notes remain outside ordinary cases, history, and exports",t=>{
  const store=createStore(t),c=store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  assert.throws(()=>store.privateNote(reviewer,c.caseId),/operator-role-required/,"WB05 reviewer cannot read private note");
  const request={actionId:randomUUID(),caseId:c.caseId,expectedVersion:0};
  assert.throws(()=>store.savePrivateNote(reviewer,request,"Sensitive personal detail"),/operator-role-required/);
  store.savePrivateNote(operator,request,"PRIVATE-WORKER-NOTE-TEST");
  assert.equal(store.privateNote(operator,c.caseId).version,1);
  assert.equal(JSON.stringify(store.handoff(c.caseId)).includes("PRIVATE-WORKER-NOTE-TEST"),false,"WB05 ordinary handoff excludes private notes");
  assert.equal(JSON.stringify(store.history(c.caseId)).includes("PRIVATE-WORKER-NOTE-TEST"),false);
  assert.throws(()=>store.savePrivateNote(operator,{...request,actionId:randomUUID()},"Stale overwrite"),/private-note-version-conflict/);
});
test("WB06 real host grants reject missing expired revoked and wrong-subject access",()=>{
  assert.doesNotThrow(()=>assertWorkbenchSourceGrant(reviewer,"w1",[grant],now));
  assert.throws(()=>assertWorkbenchSourceGrant(reviewer,"w1",[],now),/permission-required/,"WB06 missing host grant refuses");
  assert.throws(()=>assertWorkbenchSourceGrant(reviewer,"other",[grant],now),/permission-required/);
  assert.throws(()=>assertWorkbenchSourceGrant(operator,"w1",[grant],now),/permission-required/);
  assert.throws(()=>assertWorkbenchSourceGrant(reviewer,"w1",[{...grant,validUntil:new Date(now).toISOString()}],now),/permission-required/,"WB06 expired host grant refuses");
  assert.throws(()=>assertWorkbenchSourceGrant(reviewer,"w1",[grant,{...grant,revoked:true}],now),/permission-required/,"WB06 revocation defeats overlapping grant");
});
test("WB07 protected HTTP paths refuse unauthenticated reads and viewer writes",async t=>{
  let imports=0;const h=await host(t,{importPinnedW1:()=>{imports++;return {};}});
  assert.equal((await fetch(h.base+"/api/workbench/cases")).status,401);
  const legacy=await h.get("catalog","viewer");assert.equal(legacy.status,200);
  const catalogBody=await legacy.json();
  assert.equal(catalogBody.industrySet,null);
  assert.equal(catalogBody.industrySetStatus,"unverified");
  assert.equal((await h.get("industry-set","viewer")).status,503,
    "Dedicated industry set does not silently accept a partial host catalog");
  assert.equal((await h.post("cases",{actionId:randomUUID(),document:emptyWorkbenchDocument()},"viewer")).status,403,"WB07 viewer HTTP mutation refuses");
  const response=await h.post("cases",{actionId:randomUUID(),document:emptyWorkbenchDocument()});assert.equal(response.status,200);
  const c=(await response.json()).case;
  assert.equal((await h.get("case?id="+c.caseId,"viewer")).status,200);
  assert.equal((await h.get("private-note?caseId="+c.caseId,"reviewer")).status,403);
  assert.equal(imports,0);
});
test("WB08 request admission refuses CSRF omissions duplicate keys and unknown fields",async t=>{
  const h=await host(t),request={actionId:randomUUID(),document:emptyWorkbenchDocument()};
  const write=(headers:Record<string,string>,text=JSON.stringify(request))=>fetch(h.base+"/api/workbench/cases",{method:"POST",headers:{...h.headers(),"Content-Type":"application/json",...headers},body:text});
  assert.equal((await write({})).status,415,"WB08 request header required");
  assert.equal((await write({"X-FDE-Request":"workbench",Origin:"https://foreign.invalid"})).status,403);
  assert.equal((await write({"X-FDE-Request":"workbench"},'{"a":1,"a":2}')).status,400);
  assert.equal((await h.post("cases",{...request,sourceWriteAllowed:true})).status,400);
  assert.equal((await h.get("cases?q=a&q=b")).status,400);
});
test("WB09 assessment pins replay exact input without source acquisition and remain versioned",async t=>{
  let calls=0,currentKernel=kernel;const h=await host(t,{assess:()=>{calls++;return diagnostic;},kernelSha256:()=>currentKernel});
  const c=(await(await h.post("cases",{actionId:randomUUID(),document:emptyWorkbenchDocument()})).json()).case as WorkbenchCase;
  const a=caseAction(c),first=await h.post("evaluate",a);assert.equal(first.status,200);const pin=(await first.json()).evaluation;
  assert.equal((await(await h.post("evaluate",a)).json()).duplicate,true);assert.equal(calls,1,"WB09 evaluation retry does not recompute");
  const updated=await h.post("case",{...caseAction(c),document:{...c.document,title:"Later workflow state"}});assert.equal(updated.status,200);
  const replay=await(await h.get("replay?evaluationId="+pin.evaluationId)).json();
  assert.equal(replay.matched,true);assert.equal(replay.evaluatedCaseVersion,0);assert.equal(replay.currentCaseVersion,1);assert.equal(replay.readsFreshSources,false);
  currentKernel="c".repeat(64);
  assert.equal((await h.get("replay?evaluationId="+pin.evaluationId)).status,409,"WB09 changed kernel cannot replay old pin");
});
test("WB10 recorded permission metadata cannot authorize import and revocation during read refuses",async t=>{
  let grants:readonly WorkbenchSourceGrant[]=[],calls=0,revokeDuringRead=false;
  const h=await host(t,{sourceGrants:()=>grants,importPinnedW1:()=>{calls++;if(revokeDuringRead)grants=[{...grant,revoked:true}];return {schema:"test.pinned-w1/v1",observationId:"obs-"+"a".repeat(64)};}});
  const doc=emptyWorkbenchDocument(),document={...doc,engagement:{...doc.engagement,permissionRecords:[{sourceId:"w1",approver:"Company owner",reference:"Claimed approval",validUntil:"2099-01-01",notes:"Human-entered metadata"}]}};
  const c=(await(await h.post("cases",{actionId:randomUUID(),document})).json()).case as WorkbenchCase;
  const request={...caseAction(c),sourceId:"w1",observationId:"obs-"+"a".repeat(64)};
  assert.equal((await h.post("import-w1",request)).status,403,"WB10 case permission cannot grant source access");assert.equal(calls,0);
  grants=[grant];revokeDuringRead=true;
  assert.equal((await h.post("import-w1",request)).status,403,"WB10 authorization rechecked after acquisition");assert.equal(h.store.imports(c.caseId).length,0);
  grants=[grant];revokeDuringRead=false;
  const imported=await h.post("import-w1",request);assert.equal(imported.status,200);assert.equal((await imported.json()).import.origin,"host-pinned-w1");
  assert.equal((await(await h.post("import-w1",request)).json()).duplicate,true);assert.equal(calls,2);
  assert.equal((await h.post("import-w1",{...request,receipt:{forged:true}})).status,400);
});
test("WB11 corrupted or altered diagnostic results cannot silently replay",async t=>{
  const h=await host(t),c=h.store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  const pin=h.store.recordEvaluation(reviewer,caseAction(c),workbenchAssessmentRequest(c.document),diagnostic,kernel).evaluation;
  const db=new DatabaseSync(h.store.path),changed={...diagnostic,classification:"fabricated-success"};
  db.prepare("UPDATE workbench_evaluations SET result=? WHERE evaluation_id=?").run(JSON.stringify(changed),pin.evaluationId);
  assert.throws(()=>h.store.evaluation(pin.evaluationId),/evaluation-corrupt/,"WB11 changed stored bytes refuse");
  const rehashed={caseId:pin.caseId,caseVersion:pin.caseVersion,input:pin.input,result:changed,kernelSha256:pin.kernelSha256,createdAt:pin.createdAt,actor:pin.actor};
  db.prepare("UPDATE workbench_evaluations SET digest=? WHERE evaluation_id=?").run(workbenchDigest(rehashed),pin.evaluationId);db.close();
  assert.equal((await h.get("replay?evaluationId="+pin.evaluationId)).status,409,"WB11 rehashed false result fails replay");
});
test("WB12 evaluator failure and concurrent edits never produce a current result",async t=>{
  let after:()=>void=()=>{};const h=await host(t,{assess:()=>{after();return diagnostic;}});
  const c=h.store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  after=()=>{h.store.update(reviewer,caseAction(c),{...c.document,title:"Concurrent revision"});};
  assert.equal((await h.post("evaluate",caseAction(c))).status,409,"WB12 concurrent edit prevents stale evaluation commit");
  assert.equal(h.store.evaluations(c.caseId).length,0);
  after=()=>{throw Error("synthetic evaluator failure");};
  assert.equal((await h.post("evaluate",caseAction(h.store.get(c.caseId)))).status,503);
  assert.equal(h.store.evaluations(c.caseId).length,0);
});
test("WB13 company approval identity binds workflow custody independently of binary bytes",t=>{
  const store=createStore(t),binding={companyId:"example",packageId:"industrial",version:"1",manifestSha256:"a".repeat(64),policySha256:"d".repeat(64)};
  store.bindSemanticPackage(binding);const c=store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  assert.doesNotThrow(()=>store.bindSemanticPackage(binding));
  assert.throws(()=>store.bindSemanticPackage({...binding,manifestSha256:"b".repeat(64)}),/company-state-binding-refused/,"WB13 same binary different approval cannot inherit state");
  assert.throws(()=>store.bindSemanticPackage(undefined),/company-state-binding-refused/);
  assert.deepEqual(store.handoff(c.caseId).semanticPackage,binding);
});
test("WB14 source grants apply to receipt disclosure and exports for the current reader",async t=>{
  let grants:readonly WorkbenchSourceGrant[]=[grant];const h=await host(t,{sourceGrants:()=>grants});
  const c=h.store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  h.store.recordImport(reviewer,caseAction(c),"w1","obs-"+"a".repeat(64),{content:"PRIVATE-SOURCE-CONTENT"});
  const permitted=await(await h.get("case?id="+c.caseId)).json();assert.equal(permitted.imports[0].receipt.content,"PRIVATE-SOURCE-CONTENT");
  const viewerRead=await(await h.get("case?id="+c.caseId,"viewer")).json();
  assert.equal(viewerRead.imports[0].receipt,null,"WB14 unauthorized reader receives no imported receipt");
  assert.equal(viewerRead.imports[0].access,"withheld-current-permission");
  grants=[{...grant,validUntil:new Date(now).toISOString()}];
  const expiredExport=await(await h.get("export?caseId="+c.caseId)).text();
  assert.equal(expiredExport.includes("PRIVATE-SOURCE-CONTENT"),false,"WB14 expired export grant withholds source content");
  assert.equal(expiredExport.includes('"withheldImports":1'),true);
  grants=[{...grant,revoked:true}];
  assert.equal((await(await h.get("case?id="+c.caseId)).json()).imports[0].receipt,null);
  assert.equal((await h.get("history?caseId="+c.caseId,"viewer")).status,200,"WB14 manual review history remains separate");
});
test("WB15 complete export pins one snapshot and includes records beyond display pages",async t=>{
  const h=await host(t),store=h.store;let c=store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  for(let i=0;i<25;i++)c=store.update(reviewer,caseAction(c),{...c.document,title:"Revision "+i}).case;
  for(let i=0;i<130;i++)store.recordEvaluation(reviewer,caseAction(c),workbenchAssessmentRequest(c.document),diagnostic,kernel);
  store.savePrivateNote(operator,{actionId:randomUUID(),caseId:c.caseId,expectedVersion:0},"PRIVATE-EXPORT-NOTE");
  const records=store.handoffRecords(c.caseId),manifest=records.next().value!;
  store.update(reviewer,caseAction(c),{...c.document,title:"Changed after snapshot"});
  const rest=[...records],snapshotCase=rest.find(r=>r.recordType==="case")!;
  assert.equal((snapshotCase.case as WorkbenchCase).version,25,"WB15 snapshot preserves captured case version");
  assert.equal(rest.filter(r=>r.recordType==="revision").length,26,"WB15 snapshot keeps revision boundary");
  assert.equal(rest.filter(r=>r.recordType==="evaluation").length,130,"WB15 complete snapshot exceeds display cap");
  assert.equal((manifest.counts as {evaluations:number}).evaluations,130);
  const response=await h.get("export?caseId="+c.caseId);assert.equal(response.status,200);
  const text=await response.text(),lines=text.trimEnd().split("\n"),end=JSON.parse(lines.at(-1)!);
  assert.equal(end.complete,true);assert.equal(end.caseVersion,26);assert.equal(text.includes("PRIVATE-EXPORT-NOTE"),false);
  const expected=createHash("sha256").update(lines.slice(0,-1).join("\n")+"\n").digest("hex");
  assert.equal(end.contentSha256,expected,"WB15 exported digest binds exact preceding lines");
});
test("WB16 case list reports and retrieves additional pages",t=>{
  const store=createStore(t);for(let i=0;i<101;i++)store.create(reviewer,randomUUID(),{...emptyWorkbenchDocument(),title:"Item "+i});
  const first=store.listPage(),last=store.listPage("",100);
  assert.equal(first.total,101);assert.equal(first.hasMore,true,"WB16 extra cases are not silently hidden");assert.equal(first.nextOffset,100);
  assert.equal((first.cases as unknown[]).length,100);assert.equal((last.cases as unknown[]).length,1);
  assert.equal(last.hasMore,false);assert.equal(last.nextOffset,null);
  assert.throws(()=>store.listPage("",-1),/invalid-workbench-list-offset/);
});
test("WB17 source policy requires owner custody closed finite grants and reloads revocation",t=>{
  const dir=temporary(t),path=join(dir,"policy.json"),policy={schema:"fde.workbench-source-policy/v1",grants:[{...grant,sourceId:"w1-observations"}]};
  writeFileSync(path,JSON.stringify(policy),{mode:0o600});
  assert.doesNotThrow(()=>assertWorkbenchSourceGrant(reviewer,"w1-observations",readWorkbenchSourcePolicy(path),now));
  assert.throws(()=>admitWorkbenchSourcePolicy({...policy,grants:[{...policy.grants[0],principals:["*"]}]}),/policy-refused/,"WB17 wildcard principal refuses");
  assert.throws(()=>admitWorkbenchSourcePolicy({...policy,grants:[{...policy.grants[0],sourceId:"arbitrary-source"}]}),/policy-refused/);
  assert.throws(()=>admitWorkbenchSourcePolicy({...policy,grants:[{...policy.grants[0],action:"write"}]}),/policy-refused/);
  assert.throws(()=>admitWorkbenchSourcePolicy({...policy,extra:true}),/policy-refused/);
  chmodSync(path,0o644);assert.throws(()=>readWorkbenchSourcePolicy(path),/policy-refused/,"WB17 public policy file refuses");chmodSync(path,0o600);
  const link=join(dir,"linked.json");symlinkSync(path,link);assert.throws(()=>readWorkbenchSourcePolicy(link),/policy-refused/);
  writeFileSync(path,JSON.stringify({...policy,grants:[{...policy.grants[0],revoked:true}]}));
  assert.throws(()=>assertWorkbenchSourceGrant(reviewer,"w1-observations",readWorkbenchSourcePolicy(path),now),/permission-required/,"WB17 policy reload applies revocation");
});
test("WB18 evaluation pins bind the saved evidence inventory without host interpretation",t=>{
  const store=createStore(t),base=emptyWorkbenchDocument(),document={...base,evidence:[{id:"drawing",title:"Drawing",reference:"drawing/A",revision:"A",observedAt:"2026-11-01",origin:"synthetic" as const,limitations:""}]};
  const c=store.create(reviewer,randomUUID(),document).case,request=workbenchAssessmentRequest(c.document) as {request:unknown;evidenceInventory:unknown[]};
  assert.deepEqual(request.evidenceInventory,[{id:"drawing",reference:"drawing/A",revision:"A",observedAt:"2026-11-01",origin:"synthetic",limitations:""}],"WB18 saved evidence enters pinned request");
  const pin=store.recordEvaluation(reviewer,caseAction(c),request,diagnostic,kernel).evaluation;
  const edited={...document,evidence:[{...document.evidence[0]!,revision:"B"}]},next=store.update(reviewer,caseAction(c),edited).case;
  assert.throws(()=>store.recordEvaluation(reviewer,caseAction(next),request,diagnostic,kernel),/version-conflict/,"WB18 previous evidence inventory cannot pin as current");
  assert.deepEqual(store.evaluation(pin.evaluationId).input,request);
});
test("WB19 correctable assessment input refusals are distinct from host failures",async t=>{
  let failure:string|null="industrial-input-refused";
  const h=await host(t,{assess:()=>{if(failure)throw new FdeInputError(failure,"invalid-decimal: baseline sample");return diagnostic;}});
  const c=h.store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  const refused=await h.post("evaluate",caseAction(c));
  assert.equal(refused.status,422,"WB19 invalid semantic input is correctable");
  const error=await refused.json();assert.equal(error.code,"industrial-input-refused");assert.match(error.detail,/invalid-decimal/);
  failure="industrial-input-budget";assert.equal((await h.post("evaluate",caseAction(c))).status,413);
  failure="industrial-kernel-unavailable";assert.equal((await h.post("evaluate",caseAction(c))).status,503,"WB19 unavailable kernel stays a host failure");
  failure="industrial-receipt-refused";assert.equal((await h.post("evaluate",caseAction(c))).status,503);
  assert.equal(h.store.evaluations(c.caseId).length,0);
  failure=null;const pin=(await(await h.post("evaluate",caseAction(c))).json()).evaluation;
  failure="industrial-input-refused";assert.equal((await h.get("replay?evaluationId="+pin.evaluationId)).status,409);
});
test("WB21 expanded result persistence does not expand ordinary input admission",async t=>{
  const many={...diagnostic,findings:Array.from({length:129},(_,i)=>({code:"line-"+i,status:"unresolved",detail:"Synthetic multi-line finding",evidenceRefs:[]}))};
  const h=await host(t,{assess:()=>many}),c=h.store.create(reviewer,randomUUID(),emptyWorkbenchDocument()).case;
  const response=await h.post("evaluate",caseAction(c));
  assert.equal(response.status,200,"WB21 complete result persists without truncation");
  const pin=(await response.json()).evaluation;assert.equal(pin.result.findings.length,129);
  const reopened=new WorkbenchStore(h.store.path,()=>now);
  try{assert.equal((reopened.evaluation(pin.evaluationId).result as typeof many).findings.length,129);}finally{reopened.close();}
  assert.equal((await(await h.get("replay?evaluationId="+pin.evaluationId)).json()).matched,true);
  const document={...c.document,semanticInput:{rows:Array.from({length:129},()=>"input")}};
  assert.throws(()=>parseWorkbenchDocument(document),/invalid-workbench-document/,"WB21 input arrays retain original boundary");
});
