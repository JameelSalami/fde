/** Qualification addendum only; deployed application modules remain unchanged. */
import assert from "node:assert/strict";
import test from "node:test";
import {request} from "node:http";
import {synthetic} from "./fixtures.js";
import type {ReviewCase} from "../src/model.js";
import {buildConnectedCase} from "../src/workspace.js";
import {admitForReview,prepareAdmission,kernelFingerprint,type StoredObservation} from "../src/admission.js";
import {ReviewStore} from "../src/review-store.js";
import {admitAuthConfig,makeAuthUser} from "../src/web/auth.js";
import {createApplicationServer,type ReleaseManifest} from "../src/web/application.js";
import {listenLocal} from "../src/web/server.js";

const epoch=Date.parse("2026-10-30T04:00:00.000Z");
const release:ReleaseManifest={schema:"fde.release/v1",releaseId:"fde-2468ace02468ace0",
  sourceRevision:"a".repeat(40),sourceTreeSha256:"b".repeat(64),kernelSha256:kernelFingerprint(),
  nodeVersion:process.version,builtAt:new Date(epoch).toISOString(),configurationSchema:"fde.private-lab/v1",files:{}};

function pair(offset:number,revision:string):ReviewCase{
  const input=synthetic(),observedAt=new Date(epoch+offset).toISOString();
  return {...input,erp:{...input.erp,revision,capture:{...input.erp.capture,observedAt}},
    mes:{...input.mes,revision,capture:{...input.mes.capture,observedAt}}};
}
function observation(input:ReviewCase):StoredObservation{
  const view=buildConnectedCase(input),admission=prepareAdmission(input,view);
  return {schema:"fde.stored-observation/v1",view,admission,snapshot:admitForReview(admission),
    releaseId:release.releaseId,kernelSha256:release.kernelSha256,acquiredAt:new Date(epoch+3000).toISOString()};
}

/** A raw header array preserves duplicate fields on the wire. fetch/objects cannot. */
function readWithRawHeaders(port:number,headers:readonly string[]):Promise<{status:number;body:string}>{
  return new Promise((resolve,reject)=>{
    const req=request({host:"127.0.0.1",port,path:"/api/case",method:"GET",agent:false,
      headers:["Host","127.0.0.1:"+port,...headers]},res=>{
      const chunks:Buffer[]=[];let bytes=0;
      res.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>262144){res.destroy(Error("response-budget"));return;}chunks.push(chunk);});
      res.on("error",reject);
      res.on("end",()=>resolve({status:res.statusCode??0,body:Buffer.concat(chunks).toString("utf8")}));
    });
    req.on("error",reject);req.setTimeout(5000,()=>req.destroy(Error("request-timeout")));req.end();
  });
}

test("A14 duplicate raw Authorization headers refuse before acquisition",async t=>{
  const password="qualification-only-valid-password-1234",id="qualification-viewer";
  const auth=admitAuthConfig({schema:"fde.lab-auth/v1",users:[await makeAuthUser(id,"viewer",password)]});
  const store=new ReviewStore(":memory:",()=>epoch+3000);let calls=0;
  const server=createApplicationServer({auth,store,release,now:()=>epoch+3000,
    source:async()=>{calls++;return pair(0,"native-v7");}});
  t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>(done=>server.close(()=>done()));store.close();});
  const port=await listenLocal(server,0);
  const good="Basic "+Buffer.from(id+":"+password).toString("base64");
  const wrong="Basic "+Buffer.from(id+":qualification-only-wrong-password-1234").toString("base64");
  const single=await readWithRawHeaders(port,["Authorization",good]);
  assert.equal(single.status,200,"A14 one valid raw Authorization header succeeds");
  assert.equal(JSON.parse(single.body).schema,"fde.connected-case/v1");
  assert.equal(calls,1,"A14 positive control acquires exactly once");

  // The first value is valid: merely accepting Node's first normalized value is unsafe.
  const conflicting=await readWithRawHeaders(port,["Authorization",good,"Authorization",wrong]);
  assert.equal(conflicting.status,401,"A14 duplicate raw Authorization headers refuse");
  assert.equal(JSON.parse(conflicting.body).code,"authentication-required");
  const repeated=await readWithRawHeaders(port,["Authorization",good,"Authorization",good]);
  assert.equal(repeated.status,401,"A14 identical duplicate credentials also refuse");
  assert.equal(calls,1,"A14 duplicate headers never acquire");
  assert.equal(store.counts().observations,1,"A14 duplicate headers add no observation");
  assert.equal(store.counts().source_attempts,1,"A14 duplicate headers add no source attempt");
});

test("A15 regressed capture retains history without replacing the newer workflow head",t=>{
  const store=new ReviewStore(":memory:",()=>epoch+3000);t.after(()=>store.close());store.registerRelease(release);
  // The three capture times and source revisions are independently chosen here.
  // Expected head identities come from the explicitly newer input, not store output.
  const initial=observation(pair(0,"native-v7"));store.put(initial);
  const newer=observation(pair(2000,"native-v8"));store.put(newer);
  assert.notEqual(newer.view.caseId,initial.view.caseId);
  assert.equal(store.review(initial.view.observationId).latestObservationId,newer.view.observationId,
    "A15 ordinary newer capture advances the head");
  assert.equal(store.review(newer.view.observationId).currentness,"latest-observed",
    "A15 ordinary newer capture is current");

  const regressed=observation(pair(1000,"native-v7"));store.put(regressed);
  const current=store.review(newer.view.observationId);
  assert.equal(current.latestObservationId,newer.view.observationId,
    "A15 regressed capture cannot replace the newer head");
  assert.equal(current.currentness,"latest-observed","A15 newer case stays current");
  const historical=store.review(regressed.view.observationId);
  assert.equal(historical.currentness,"superseded","A15 regressed case remains historical");
  assert.equal(historical.latestObservationId,newer.view.observationId);
  assert.equal(store.get(regressed.view.observationId).view.observationId,regressed.view.observationId,
    "A15 regressed observation is retained under its own pin");
  assert.equal(store.counts().observations,3,"A15 all three captured observations are retained");
});
