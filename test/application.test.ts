import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {synthetic} from "./fixtures.js";
import {ReviewStore,parseReviewAction,ReviewError} from "../src/review-store.js";
import {admitForReview,prepareAdmission,replayObservation,kernelFingerprint,type StoredObservation} from "../src/admission.js";
import {buildConnectedCase} from "../src/workspace.js";
import {makeAuthUser,admitAuthConfig,readAuthConfig,type AuthConfig} from "../src/web/auth.js";
import {createApplicationServer,type ReleaseManifest} from "../src/web/application.js";
import {listenLocal} from "../src/web/server.js";
import type {ReviewCase} from "../src/model.js";
import {fingerprint} from "../src/model.js";

const now=Date.parse("2026-10-30T04:00:00Z");
const password="test-only-random-length-password-42";
const basic=(id:string,p=password)=>"Basic "+Buffer.from(id+":"+p).toString("base64");
const config:Promise<AuthConfig>=Promise.all([makeAuthUser("viewer","viewer",password),
  makeAuthUser("reviewer","reviewer",password),makeAuthUser("operator","operator",password)])
  .then(users=>admitAuthConfig({schema:"fde.lab-auth/v1",users}));
const release:ReleaseManifest={schema:"fde.release/v1",releaseId:"fde-0123456789abcdef",
  sourceRevision:"a".repeat(40),sourceTreeSha256:"b".repeat(64),kernelSha256:kernelFingerprint(),
  nodeVersion:process.version,builtAt:new Date(now).toISOString(),configurationSchema:"fde.private-lab/v1",files:{}};
function pair(offset=0,revision="native-v7"):ReviewCase{
  const p=synthetic();return {...p,erp:{...p.erp,revision,capture:{...p.erp.capture,observedAt:new Date(now+offset).toISOString()}},
    mes:{...p.mes,revision,capture:{...p.mes.capture,observedAt:new Date(now+offset).toISOString()}}};
}
function observation(p=pair()):StoredObservation{
  const view=buildConnectedCase(p),admission=prepareAdmission(p,view),snapshot=admitForReview(admission);
  return {schema:"fde.stored-observation/v1",view,admission,snapshot,releaseId:release.releaseId,kernelSha256:release.kernelSha256,acquiredAt:new Date(now).toISOString()};
}
function createStore(path:string,clock:()=>number=()=>now){const store=new ReviewStore(path,clock);store.registerRelease(release);return store;}
function temporary(t:TestContext):string{
  const dir=mkdtempSync(join(tmpdir(),"fde-review-test-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;
}
async function host(t:TestContext,source:()=>Promise<ReviewCase>=async()=>pair(),timeoutMs=1000){
  const directory=temporary(t),store=createStore(join(directory,"reviews.sqlite"),()=>now);
  const auth=await config,server=createApplicationServer({auth,store,release,source,now:()=>now,sourceTimeoutMs:timeoutMs});
  const port=await listenLocal(server,0);t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const url="http://127.0.0.1:"+port;
  const get=(path:string,id="viewer")=>fetch(url+path,{headers:{Authorization:basic(id)}});
  return {store,url,get};
}
const action=(id:string,version=0)=>({actionId:randomUUID(),observationId:id,expectedVersion:version,
  assignee:"reviewer",disposition:"reviewed" as const,note:"Investigated source evidence; reported quantities do not certify physical output."});

test("A01 authentication gates protected reads and exports before acquisition",async t=>{
  let calls=0;const {url,get}=await host(t,async()=>{calls++;return pair();});
  assert.equal((await fetch(url+"/health")).status,200);
  for(const path of ["/","/api/case","/api/export.json?observationId=obs-"+"0".repeat(64),"/ready","/api/version"])
    assert.equal((await fetch(url+path)).status,401,"A01 unauthorized path "+path);
  assert.equal(calls,0,"A01 unauthenticated requests never acquire");
  assert.equal((await fetch(url+"/api/case",{headers:{Authorization:basic("viewer","wrong")}})).status,401,"A01 wrong password");
  assert.equal((await fetch(url+"/api/case",{headers:{Authorization:basic("unknown")}})).status,401,"A01 unknown identity");
  assert.equal((await get("/api/case")).status,200,"A01 authenticated read");
  assert.equal(calls,1);
});
test("A02 viewer cannot write review or inspect operator status; reviewer writes application state only",async t=>{
  const {url,get,store}=await host(t),c=await(await get("/api/case")).json();
  assert.throws(()=>store.act({id:"viewer",role:"viewer"},action(c.observationId),new Set(["reviewer"])),/reviewer-role-required/,"A02 store requires reviewer role");
  const write=(id:string)=>fetch(url+"/api/review",{method:"POST",headers:{Authorization:basic(id),"Content-Type":"application/json","X-FDE-Request":"w1"},body:JSON.stringify(action(c.observationId))});
  assert.equal((await write("viewer")).status,403,"A02 viewer mutation denied");
  assert.equal((await get("/api/operations","reviewer")).status,403,"A02 operator scope");
  const accepted=await write("reviewer");assert.equal(accepted.status,200);
  const saved=await accepted.json();assert.equal(saved.review.version,1);assert.equal(saved.review.sourceWriteAllowed,false);
  assert.equal((await get("/api/operations","operator")).status,200);
  assert.equal((await fetch(url+"/api/stock/ack",{method:"POST",headers:{Authorization:basic("operator")}})).status,405);
});
test("A03 unsafe origins, missing CSRF header, duplicate JSON keys and extra fields refuse",async t=>{
  const {url,get}=await host(t),c=await(await get("/api/case")).json(),a=action(c.observationId);
  const post=(headers:Record<string,string>,text=JSON.stringify(a))=>fetch(url+"/api/review",{
    method:"POST",headers:{Authorization:basic("reviewer"),"Content-Type":"application/json",...headers},body:text});
  assert.equal((await post({"X-FDE-Request":"w1",Origin:"https://foreign.invalid"})).status,403,"A03 origin gate");
  assert.equal((await post({})).status,415,"A03 custom request header");
  assert.equal((await post({"X-FDE-Request":"w1"},'{"note":"a","note":"b"}')).status,400,"A03 duplicate keys");
  assert.equal((await post({"X-FDE-Request":"w1"},JSON.stringify({...a,postingPermitted:true}))).status,400,"A03 closed action");
  assert.equal((await post({"X-FDE-Request":"w1"})).status,200);
});
test("A04 pinned replay and exports survive restart and never read fresh sources",async t=>{
  const dir=temporary(t),path=join(dir,"reviews.sqlite"),saved=observation();
  const s1=createStore(path,()=>now);s1.put(saved);s1.act({id:"reviewer",role:"reviewer"},action(saved.view.observationId),new Set(["reviewer"]));s1.close();
  const s2=createStore(path,()=>now);t.after(()=>s2.close());
  const again=s2.get(saved.view.observationId);assert.deepEqual(again,saved,"A04 exact pinned bytes replay");
  assert.equal(s2.review(saved.view.observationId).version,1,"A04 review survives restart");
  assert.equal(s2.review(saved.view.observationId).audit.length,1);
  const bad=structuredClone(saved) as any;bad.snapshot.members[0].quantity="999";
  assert.throws(()=>replayObservation(bad),/admission|replay/,"A04 changed snapshot refuses");
  const db=new DatabaseSync(path);db.prepare("UPDATE observations SET body=? WHERE id=?").run(JSON.stringify(bad),saved.view.observationId);db.close();
  assert.throws(()=>s2.get(saved.view.observationId),/stored-evidence-corrupt/,"A04 corruption cannot replay");
  const rehash=new DatabaseSync(path);rehash.prepare("UPDATE observations SET digest=? WHERE id=?").run(fingerprint(bad),saved.view.observationId);rehash.close();
  assert.throws(()=>s2.get(saved.view.observationId),/admission|replay/,"A04 rehashed corrupt semantics refuse");
});
test("A05 concurrent version checks and idempotency preserve exactly one audit action",t=>{
  const store=createStore(join(temporary(t),"r.sqlite"),()=>now);t.after(()=>store.close());
  const saved=observation();store.put(saved);const a=action(saved.view.observationId),actor={id:"reviewer",role:"reviewer" as const};
  assert.equal(store.act(actor,a,new Set(["reviewer"])).duplicate,false);
  assert.equal(store.act(actor,a,new Set(["reviewer"])).duplicate,true,"A05 exact retry deduplicates");
  assert.throws(()=>store.act(actor,{...a,note:"changed"},new Set(["reviewer"])),/idempotency-key-reused/,"A05 mismatched retry refuses");
  assert.throws(()=>store.act(actor,{...a,actionId:randomUUID()},new Set(["reviewer"])),/review-version-conflict/,"A05 stale concurrent version refuses");
  assert.equal(store.review(saved.view.observationId).audit.length,1,"A05 one successful mutation");
  assert.equal(store.review(saved.view.observationId).version,1);
});
test("A06 source drift preserves old notes and prevents obsolete review being current",t=>{
  let clock=now;const store=createStore(join(temporary(t),"r.sqlite"),()=>clock);t.after(()=>store.close());
  const first=observation();store.put(first);const originalAction=action(first.view.observationId);
  store.act({id:"reviewer",role:"reviewer"},originalAction,new Set(["reviewer"]));
  clock+=1000;const repeat=observation(pair(1000));store.put(repeat);
  assert.equal(store.review(first.view.observationId).currentness,"same-source-case","A06 old pin not relabeled latest");
  assert.equal(store.review(first.view.observationId).observationAgeMs,1000,"A06 old pin age is preserved");
  clock+=1000;const second=observation(pair(2000,"native-v8"));store.put(second);
  assert.equal(store.review(first.view.observationId).currentness,"superseded","A06 drift flags old evidence");
  assert.equal(store.review(first.view.observationId).audit.length,1,"A06 preserves history");
  assert.equal(store.act({id:"reviewer",role:"reviewer"},originalAction,new Set(["reviewer"])).review.currentness,"superseded","A06 retry recomputes currentness");
  assert.equal(store.review(second.view.observationId).version,0);
  assert.throws(()=>store.act({id:"reviewer",role:"reviewer"},action(first.view.observationId,1),new Set(["reviewer"])),/no-longer-current/,"A06 old case refuses mutation");
  clock+=300001;
  assert.equal(store.review(second.view.observationId).currentness,"stale","A06 age is not hidden");
  assert.throws(()=>store.act({id:"reviewer",role:"reviewer"},action(second.view.observationId),new Set(["reviewer"])),/no-longer-current/);
});
test("A06-T equal-time sources remain unresolved and replay does not change head",t=>{
 const store=createStore(join(temporary(t),"tie.sqlite"),()=>now);t.after(()=>store.close());
 const a=observation(pair(0,"native-v7")),b=observation(pair(0,"native-v8"));
 assert.notEqual(a.view.observationId,b.view.observationId);
 store.put(a);store.put(b);
 for(const item of [a,b]){
  const r=store.review(item.view.observationId);
  assert.equal(r.currentness,"unresolved-tie");assert.equal(r.headTieCount,2);
  assert.equal(r.latestObservationId,a.view.observationId);
 }
 assert.throws(()=>store.act({id:"reviewer",role:"reviewer"},action(b.view.observationId),new Set(["reviewer"])),/no-longer-current/);
 assert.ok(store.list().filter(r=>[a.view.observationId,b.view.observationId].includes(String(r.observationId))).every(r=>r.latestCase===0));
 store.put(b);store.put(a);
 assert.equal(store.review(b.view.observationId).latestObservationId,a.view.observationId);
 const later=observation(pair(1000,"native-v9"));store.put(later);
 assert.equal(store.review(later.view.observationId).currentness,"latest-observed");
 assert.equal(store.review(later.view.observationId).headTieCount,1);
 assert.equal(store.review(a.view.observationId).currentness,"superseded");
});
test("A10 every source capture is checked independently against future time",t=>{
  const store=createStore(join(temporary(t),"r.sqlite"),()=>now);t.after(()=>store.close());
  const normal=observation();store.put(normal);assert.equal(store.get(normal.view.observationId).view.observationId,normal.view.observationId);
  const p=pair();const future={...p,mes:{...p.mes,capture:{...p.mes.capture,observedAt:new Date(now+60000).toISOString()}}};
  assert.throws(()=>store.put(observation(future)),/invalid-capture-time/,"A10 one future source must refuse");
});
test("A12 identical acquisition reuses its immutable admission and retains separate attempts",async t=>{
  let calls=0;const {get,store}=await host(t,async()=>{calls++;return pair();});
  const first=await get("/api/case");assert.equal(first.status,200);const view=await first.json();
  const original=store.get(view.observationId);
  const second=await get("/api/case");assert.equal(second.status,200,"A12 repeated source acquisition succeeds");
  assert.deepEqual(await second.json(),view);assert.deepEqual(store.get(view.observationId),original);
  assert.equal(store.counts().observations,1);assert.equal(store.counts().source_attempts,2);assert.equal(calls,2);
  assert.throws(()=>store.put({...original,acquiredAt:new Date(now+1).toISOString()}),/identity-collision/,"A12 conflicting record cannot overwrite a pin");
});
test("A16 model investigation request reserves before execution, deduplicates, and survives restart",async t=>{
  const dir=temporary(t),dbPath=join(dir,"investigation.sqlite"),store=createStore(dbPath,()=>now);
  const auth=await config;
  let calls=0,releaseModel:((value:void)=>void)|undefined;
  let started:()=>void=()=>{};
  const began=new Promise<void>(resolve=>{started=resolve;});
  const model=async()=>{calls++;started();await new Promise<void>(resolve=>{releaseModel=resolve;});
    return {selection:{evidenceOrder:["comparison"],questionIds:["receipt"],abstain:false},
      promptTokens:10,outputTokens:8,modelDigest:"a".repeat(64)};};
  const server=createApplicationServer({auth,store,release,now:()=>now,
    source:async()=>pair(),model});
  const port=await listenLocal(server,0);
  t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const url="http://127.0.0.1:"+port;
  const caseResponse=await fetch(url+"/api/case",{headers:{Authorization:basic("reviewer")}});
  const observed=await caseResponse.json();
  const requestId=randomUUID();
  const post=(key=requestId,observationId=observed.observationId,role="reviewer")=>fetch(url+"/api/investigation",{
    method:"POST",headers:{Authorization:basic(role),"Content-Type":"application/json","X-FDE-Request":"w1"},
    body:JSON.stringify({requestId:key,observationId})});
  const inspect=(role="reviewer")=>fetch(url+"/api/investigation-status?requestId="+requestId,
    {headers:{Authorization:basic(role)}});
  const first=post();
  await began;
  const unknown=await inspect();
  assert.equal(unknown.status,202);
  const pending=await unknown.json();
  assert.equal(pending.state,"pending");assert.equal(pending.execution,"unknown");
  assert.match(pending.next,/never re-dispatch/);
  const duplicate=await post();
  assert.equal(duplicate.status,202);
  assert.equal((await duplicate.json()).state,"pending");
  assert.equal(calls,1,"duplicate request never re-invokes model");
  assert.equal((await inspect("viewer")).status,403);
  const other=await post(requestId,observed.observationId,"operator");
  assert.equal(other.status,409,"key reuse by a different principal refuses");
  const reopened=createStore(dbPath,()=>now);t.after(()=>reopened.close());
  assert.equal(reopened.investigationStatus("reviewer",requestId).state,"pending",
    "durable pending state survives process restart without retry");
  releaseModel?.();
  const completed=await first;
  assert.equal(completed.status,200);
  const finished=await completed.json();
  assert.equal(finished.state,"completed");assert.ok(finished.draftId);
  assert.equal(finished.draft.schema,"fde.investigation-draft/v1");
  assert.equal(finished.draft.humanReviewRequired,true);
  assert.equal((await inspect()).status,200);
  assert.equal((await post()).status,200);
  assert.equal(calls,1,"completed replay cannot repeat provider call");
  assert.equal(reopened.investigationStatus("reviewer",requestId).state,"completed");
  assert.equal((await post(randomUUID(),observed.observationId,"viewer")).status,403);
});
test("A17 scoped step resolution requires exact read-only source pin",async t=>{
 const {get,store}=await host(t);
 const pin=await (await get("/api/case")).json();
 const url="/api/steps?observationId="+pin.observationId+"&resolution=";
 const response=await get(url+"summary");assert.equal(response.status,200);
 const summary=await response.json();
 assert.equal(summary.schema,"fde.step-readout/v1");assert.equal(summary.decision,"HUMAN REVIEW PENDING");
 assert.deepEqual(summary.ptq.map((x:{evidence:string})=>x.evidence),["known","known","unverified"]);
 assert.deepEqual(summary.effects,[]);
 assert.equal(summary.expanded,null);
 const source=await (await get(url+"sources")).json();
 assert.equal(source.expanded.distributedAtomicSnapshot,false);
 assert.equal(source.expanded.classification,undefined);
 const semantic=await (await get(url+"semantics")).json();
 assert.equal(semantic.expanded.businessTruthAdmitted,false);
 const human=await (await get(url+"review")).json();
 assert.equal(human.expanded.disposition,"open");
 assert.equal((await get(url+"publish")).status,400);
 assert.equal((await get("/api/steps?observationId="+pin.observationId)).status,400);
 assert.equal(store.counts().source_attempts,1);
});
test("A13 replay requires the exact pinned kernel and a registered release",t=>{
  const store=createStore(join(temporary(t),"r.sqlite"));t.after(()=>store.close());
  const saved=observation();store.put(saved);replayObservation(saved);
  assert.throws(()=>replayObservation({...saved,kernelSha256:"0".repeat(64)}),/pinned-kernel-unavailable/,"A13 changed compiler refuses");
  const forged={...saved,releaseId:"fde-ffffffffffffffff"};
  assert.throws(()=>store.put(forged),/unregistered-pinned-release/,"A13 unknown release refuses");
  assert.throws(()=>store.registerRelease({...release,kernelSha256:"0".repeat(64)}),/registration-collision/,"A13 registered release cannot be rebound");
});
test("A07 source failures and deadlines leave health alive without stale success",async t=>{
  let failSource=false,calls=0;
  const {url,get,store}=await host(t,async()=>{calls++;if(failSource)throw Error("private-password-must-not-leak");return pair();});
  const first=await(await get("/api/case")).json();failSource=true;
  const failure=await get("/api/case");assert.equal(failure.status,503,"A07 failed source status");
  assert.ok(!(await failure.text()).includes("password"),"A07 error sanitization");
  assert.equal((await fetch(url+"/health")).status,200);assert.equal((await get("/ready")).status,200);
  const exported=await get("/api/export.json?observationId="+first.observationId);
  assert.deepEqual(await exported.json(),first,"A07 prior export explicit pinned evidence");
  assert.equal(calls,2);assert.equal((store.sourceStatus().latest as any).outcome,"unavailable");
  const stalled=await host(t,()=>new Promise(()=>{}),20);
  assert.equal((await stalled.get("/api/case")).status,504,"A07 deadline");
  assert.equal((await stalled.get("/api/case")).status,504,"A07 timed-out acquisition remains blocked, no overlap");
});
test("A08 isolated backup restore preserves evidence and audit, private permissions refuse weakening",async t=>{
  const dir=temporary(t),store=createStore(join(dir,"r.sqlite"),()=>now);t.after(()=>store.close());
  const saved=observation();store.put(saved);store.act({id:"reviewer",role:"reviewer"},action(saved.view.observationId),new Set(["reviewer"]));
  const backup=join(dir,"backup.sqlite");await store.backupTo(backup);
  const restored=createStore(backup,()=>now);t.after(()=>restored.close());
  assert.equal(restored.ready(),true);assert.deepEqual(restored.get(saved.view.observationId),saved,"A08 restore replays");
  assert.equal(restored.review(saved.view.observationId).audit.length,1,"A08 audit restored");
  await assert.rejects(()=>store.backupTo(backup),/destination-exists/);
  const authPath=join(dir,"auth.json");writeFileSync(authPath,JSON.stringify(await config),{mode:0o600});
  assert.equal((await readAuthConfig(authPath)).users.length,3);
  chmodSync(authPath,0o644);await assert.rejects(()=>readAuthConfig(authPath),/custody-refused/,"A08 world-readable auth refuses");
  assert.ok(readFileSync(backup).length>0);
});
test("A09 review validation refuses invented fields, invalid assignees and unsupported dispositions",t=>{
  const store=createStore(join(temporary(t),"r.sqlite"),()=>now);t.after(()=>store.close());
  const saved=observation();store.put(saved);const a=action(saved.view.observationId);
  assert.deepEqual(parseReviewAction(a),a);
  assert.throws(()=>parseReviewAction({...a,disposition:"stock-posted"}),/invalid-review-action/,"A09 unsupported disposition");
  assert.throws(()=>parseReviewAction({...a,sourceWriteAllowed:true}),/closed-object/);
  assert.throws(()=>store.act({id:"reviewer",role:"reviewer"},{...a,assignee:"missing"},new Set(["reviewer"])),/unknown-review-assignee/);
  assert.throws(()=>store.act({id:"reviewer",role:"reviewer"},{...a,note:""},new Set(["reviewer"])),e=>e instanceof ReviewError&&e.status===400);
  assert.equal(store.review(saved.view.observationId).version,0);
});
