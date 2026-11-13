#!/usr/bin/env node
// Local preview only. No public listener, user account administration or source effects.
import {readExistingLab} from "../dist/src/enterprise/probe.js";
import {buildConnectedCase} from "../dist/src/workspace.js";
import {createWorkspaceServer,listenLocal} from "../dist/src/web/server.js";

const raw=process.env.FDE_WEB_PORT??"4186";
if(!/^[0-9]{1,5}$/.test(raw))throw Error("invalid local port");
const port=Number(raw);
const server=createWorkspaceServer(async()=>{
  const sources=await readExistingLab();
  return buildConnectedCase(sources);
},{host:"127.0.0.1",port});
server.requestTimeout=10000;
server.headersTimeout=15000;
server.keepAliveTimeout=5000;
try{
  const active=await listenLocal(server,port);
  console.log("FDE connected W1 workbench — LOCAL ONLY");
  console.log("http://127.0.0.1:"+active);
  console.log("Existing ERPNext/OpenMES READ ONLY lab; no writes; no user/IAM login");
}catch{
  console.error("fde-web: local preview could not bind; no external listener opened");
  process.exitCode=2;
}
