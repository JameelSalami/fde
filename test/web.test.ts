import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {request} from "node:http";
import {createWorkspaceServer,listenLocal} from "../src/web/server.js";
import {buildConnectedCase,type WorkspaceCase} from "../src/workspace.js";
import {synthetic,changed} from "./fixtures.js";

async function start(t:TestContext,
  source:()=>Promise<WorkspaceCase>){
  const server=createWorkspaceServer(source);
  const port=await listenLocal(server,0);
  t.after(()=>{server.closeAllConnections();server.close();});
  return {server,port,url:"http://127.0.0.1:"+port};
}
async function rawRequest(port:number,path:string,method:string,
  headers:Record<string,string>={}):Promise<{status:number;body:string}>{
  return new Promise((resolve,reject)=>{
    const r=request({host:"127.0.0.1",port,path,method,headers},res=>{
      const chunks:Buffer[]=[];
      res.on("data",chunk=>chunks.push(Buffer.from(chunk)));
      res.on("end",()=>resolve({status:res.statusCode??0,
        body:Buffer.concat(chunks).toString("utf8")}));
    });
    r.on("error",reject);r.end();
  });
}
test("W18 read-only local web host and origin gate close cross-origin, POST and unknown paths",async t=>{
  const {port,url}=await start(t,async()=>buildConnectedCase(synthetic()));
  const html=await fetch(url+"/");
  assert.equal(html.status,200);
  assert.match(await html.text(),/FDE — Connected Workbench/);
  assert.match(html.headers.get("content-security-policy")??"",/default-src 'none'/);
  assert.equal(html.headers.get("cache-control"),"no-store, max-age=0");
  const css=await fetch(url+"/styles.css");
  assert.equal(css.status,200);
  assert.match(await css.text(),/workspace-panel/);
  const js=await fetch(url+"/app.js");
  assert.equal(js.status,200);
  assert.match(await js.text(),/state.settings.note/);
  const hostileHost=await rawRequest(port,"/api/case","GET",{Host:"external.example"});
  assert.equal(hostileHost.status,403);
  const hostileOrigin=await rawRequest(port,"/api/case","GET",
    {Origin:"https://external.example"});
  assert.equal(hostileOrigin.status,403);
  const post=await rawRequest(port,"/api/case","POST");
  assert.equal(post.status,405);
  const arbitrary=await rawRequest(port,"/api/admin/write","GET");
  assert.equal(arbitrary.status,404);
});
test("W19 source failure refuses with sanitized error, no false empty/stale success",async t=>{
  let calls=0;
  const {url}=await start(t,async()=>{
    calls++;
    if(calls===1)return buildConnectedCase(synthetic());
    throw Error("secret-native-db-password-this-must-not-leak");
  });
  const first=await fetch(url+"/api/case");
  assert.equal(first.status,200);
  const second=await fetch(url+"/api/case");
  assert.equal(second.status,503);
  const body=await second.text();
  assert.match(body,/source-observation-unavailable/);
  assert.ok(!body.includes("secret-native"));
  assert.equal(JSON.parse(body).authority,"none");
  assert.equal(calls,2);
});
test("W20 Excel and JSON exports pin the exact already-observed snapshot",async t=>{
  let calls=0;
  const {url}=await start(t,async()=>{
    calls++;
    const input=changed(synthetic());
    (input.erp.capture as unknown as {observedAt:string}).observedAt=
      "2026-10-29T19:00:00.000Z";
    return buildConnectedCase(input);
  });
  const got=await fetch(url+"/api/case");
  assert.equal(got.status,200);
  const caseView=await got.json() as WorkspaceCase;
  assert.match(caseView.observationId,/^obs-[a-f0-9]{64}$/);
  const search="?observationId="+encodeURIComponent(caseView.observationId);
  const csv=await fetch(url+"/api/export.csv"+search);
  assert.equal(csv.status,200);
  assert.match(csv.headers.get("content-type")??"",/text\/csv/);
  const bytes=Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0,3)],[239,187,191]);
  const text=bytes.toString("utf8");
  assert.ok(text.includes(caseView.sources.erp.nativeId));
  assert.equal(text.split("\r\n").filter(Boolean).length,5);
  const json=await fetch(url+"/api/export.json"+search);
  assert.equal(json.status,200);
  const exported=await json.json();
  assert.deepEqual(exported,caseView);
  assert.equal(calls,1,"exact pinned exports do not re-query vendor sources");
  const unknown=await fetch(url+"/api/export.csv?observationId=obs-"+
    "0".repeat(64));
  assert.equal(unknown.status,410);
  const malformed=await fetch(url+"/api/export.csv?observationId=other");
  assert.equal(malformed.status,400);
  assert.equal(calls,1);
});
test("W17 no HTTP API permits vendor effects or claims enterprise administration",async t=>{
  const {port,url}=await start(t,async()=>buildConnectedCase(synthetic()));
  const h=await fetch(url+"/health");
  const status=await h.json();
  assert.equal(status.vendorWriteCapability,false);
  assert.equal(status.authority,"none");
  assert.equal(status.status,"local-demo-ready");
  assert.equal((await rawRequest(port,"/api/stock/ack","POST")).status,405);
  assert.equal((await rawRequest(port,"/api/semantic/admit","GET")).status,404);
});
test("W24 web server binding is loopback only and cannot be widened by options",async t=>{
  assert.throws(()=>createWorkspaceServer(
    async()=>buildConnectedCase(synthetic()),{host:"0.0.0.0" as never}),
    /loopback-host/);
  const {server}=await start(t,async()=>buildConnectedCase(synthetic()));
  const address=server.address();
  assert.ok(address&&typeof address!=="string");
  if(address&&typeof address!=="string")assert.equal(address.address,"127.0.0.1");
});