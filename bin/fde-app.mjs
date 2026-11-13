#!/usr/bin/env node
// Private host entry point. Configuration contains paths only; no secret is logged.
import {resolve} from "node:path";
import {lstatSync,readFileSync} from "node:fs";
import {readAuthConfig} from "../dist/src/web/auth.js";
import {ReviewStore} from "../dist/src/review-store.js";
import {WorkbenchStore} from "../dist/src/workbench-store.js";
import {readWorkbenchSourcePolicy} from "../dist/src/workbench-policy.js";
import {createApplicationServer,readRelease,selectedApplicationRelease} from "../dist/src/web/application.js";
import {loadCompanySemanticRuntime,bundledSemanticRuntime} from "../dist/src/semantic-runtime.js";
import {replayObservation} from "../dist/src/admission.js";
import {listenLocal} from "../dist/src/web/server.js";
import {readExistingLab} from "../dist/src/enterprise/probe.js";
import {admitModelConfig,createLocalModel} from "../dist/src/investigation.js";
import {parseStrictJson} from "../dist/src/json.js";

process.umask(0o077);
const state=process.env.FDE_STATE_DIR;
const rawPort=process.env.FDE_APP_PORT??"4187";
if(!state||!state.startsWith("/")||!/^[0-9]{1,5}$/.test(rawPort))throw Error("private-lab-configuration-required");
const selection=process.env.FDE_COMPANY_SELECTION,policy=process.env.FDE_COMPANY_POLICY;
const companyConfigured=selection!==undefined||policy!==undefined;
if(companyConfigured&&(!selection||!policy))throw Error("company-selection-and-policy-required");
const auth=await readAuthConfig(resolve(state,"auth.json"));
const release=readRelease();
const semanticRuntime=selection?loadCompanySemanticRuntime(selection,policy):bundledSemanticRuntime();
const activeRelease=selectedApplicationRelease(release,semanticRuntime);
const store=new ReviewStore(resolve(state,"reviews.sqlite"),Date.now,s=>replayObservation(s,semanticRuntime));
const workbenchStore=new WorkbenchStore(resolve(state,"workbench.sqlite"));
const workbenchPolicy=process.env.FDE_WORKBENCH_SOURCE_POLICY;
if(workbenchPolicy!==undefined&&(!workbenchPolicy||!workbenchPolicy.startsWith("/")))throw Error("absolute-workbench-source-policy-required");
if(workbenchPolicy)readWorkbenchSourcePolicy(workbenchPolicy);
let model;
if(process.env.FDE_AI_CONFIG){
  const path=process.env.FDE_AI_CONFIG,st=lstatSync(path);
  if(!path.startsWith("/")||st.isSymbolicLink()||!st.isFile()||(st.mode&0o077)!==0||st.uid!==process.getuid())throw Error("model-config-custody-refused");
  model=createLocalModel(admitModelConfig(parseStrictJson(readFileSync(path,"utf8"))));
}
const server=createApplicationServer({auth,store,release,source:readExistingLab,model,semanticRuntime,workbenchStore,
  ...(workbenchPolicy?{workbenchSourceGrants:()=>readWorkbenchSourcePolicy(workbenchPolicy)}:{})});
const port=await listenLocal(server,Number(rawPort));
console.log(JSON.stringify({event:"fde-started",releaseId:activeRelease.releaseId,hostReleaseId:release.releaseId,semanticPackage:semanticRuntime.companyPackage,host:"127.0.0.1",port,
  environment:"private-synthetic-lab",vendorWriteCapability:false}));
let stopping=false;
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>{
  if(stopping)return;stopping=true;
  server.close(()=>{workbenchStore.close();store.close();process.exit(0);});
  setTimeout(()=>{server.closeAllConnections();},18000).unref();
});
