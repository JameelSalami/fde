/** Local-only, non-authoritative FDE W1 HTTP host.
 * Vendor reads and compiled meaning are supplied by the injected source provider.
 * There are no mutation, authentication management, SQL, upload or stock endpoints.
 */
import {createServer,type IncomingMessage,type Server,type ServerResponse} from "node:http";
import {readFile} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {exportEvidenceJson,exportExcelCsv} from "../export.js";
import type {WorkspaceCase} from "../workspace.js";

export type CaseProvider=()=>Promise<WorkspaceCase>;
export interface WorkspaceServerOptions{
  readonly host?:"127.0.0.1";
  readonly port?:number;
}
const staticDir=resolve(dirname(fileURLToPath(import.meta.url)),"../../../web");
const files=new Map<string,{file:string;type:string}>([
  ["/",{file:"index.html",type:"text/html; charset=utf-8"}],
  ["/app.js",{file:"app.js",type:"text/javascript; charset=utf-8"}],
  ["/styles.css",{file:"styles.css",type:"text/css; charset=utf-8"}],
  ["/workbench",{file:"workbench.html",type:"text/html; charset=utf-8"}],
  ["/workbench.js",{file:"workbench.js",type:"text/javascript; charset=utf-8"}],
  ["/workbench.css",{file:"workbench.css",type:"text/css; charset=utf-8"}]
]);
const csp="default-src 'none'; script-src 'self'; style-src 'self'; "+
 "connect-src 'self'; img-src 'self' data:; font-src 'none'; "+
 "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function validateLocalRequest(req:IncomingMessage):boolean {
  const port=req.socket.localPort;
  const allowed=new Set(["localhost:"+port,"127.0.0.1:"+port]);
  if(!allowed.has(req.headers.host??""))return false;
  const origin=req.headers.origin;
  if(origin!==undefined&&
     ![...allowed].some(host=>origin==="http://"+host))return false;
  if(req.headers["sec-fetch-site"]==="cross-site")return false;
  return true;
}
function send(res:ServerResponse,status:number,type:string,body:string|Buffer,head=false,
              extra:Readonly<Record<string,string>>={}){
  const payload=Buffer.isBuffer(body)?body:Buffer.from(body,"utf8");
  res.writeHead(status,{
    "Content-Type":type,
    "Cache-Control":"no-store, max-age=0",
    "X-Content-Type-Options":"nosniff",
    "X-Frame-Options":"DENY",
    "Referrer-Policy":"no-referrer",
    "Content-Security-Policy":csp,
    "Content-Length":String(head?0:payload.length),
    ...extra
  });
  res.end(head?undefined:payload);
}
function refusal(res:ServerResponse,status:number,code:string){
  send(res,status,"application/json; charset=utf-8",
    JSON.stringify({schema:"fde.local-error/v1",code,authority:"none"})+"\n");
}
export function createWorkspaceHandler(provider:CaseProvider){
  let pending:Promise<WorkspaceCase>|undefined;
  const snapshots=new Map<string,{caseView:WorkspaceCase;storedAt:number}>();
  const store=(c:WorkspaceCase)=>{
    if(c.schema!=="fde.connected-case/v1"||c.authority!=="none"||
       c.observationScope.sourceWriteAllowed!==false)
      throw Error("not-an-admitted-display-facet");
    const now=Date.now();
    for(const [id,value] of snapshots)if(now-value.storedAt>900000)
      snapshots.delete(id);
    snapshots.delete(c.observationId);
    snapshots.set(c.observationId,{caseView:c,storedAt:now});
    while(snapshots.size>8)snapshots.delete(snapshots.keys().next().value!);
  };
  async function current():Promise<WorkspaceCase>{
    if(pending)return pending;
    pending=provider().then(c=>{store(c);return c;}).finally(()=>{pending=undefined;});
    return pending;
  }
  return async function handler(req:IncomingMessage,res:ServerResponse):Promise<void>{
    if(!validateLocalRequest(req)){refusal(res,403,"local-origin-required");return;}
    if(req.method!=="GET"&&req.method!=="HEAD"){
      refusal(res,405,"read-only-routes");return;
    }
    let url:URL;
    try{url=new URL(req.url??"/","http://127.0.0.1");}
    catch{refusal(res,400,"invalid-path");return;}
    const staticFile=files.get(url.pathname);
    if(staticFile){
      if(url.search){refusal(res,400,"unexpected-query");return;}
      try{
        const contents=await readFile(resolve(staticDir,staticFile.file));
        send(res,200,staticFile.type,contents,req.method==="HEAD");
      }catch{refusal(res,503,"asset-unavailable");}
      return;
    }
    if(url.pathname==="/health"){
      if(url.search){refusal(res,400,"unexpected-query");return;}
      send(res,200,"application/json; charset=utf-8",
        JSON.stringify({schema:"fde.web-health/v1",status:"local-demo-ready",
          authority:"none",vendorWriteCapability:false})+"\n",
          req.method==="HEAD");
      return;
    }
    if(req.method==="HEAD"){refusal(res,405,"get-only-route");return;}
    if(url.pathname==="/api/case"){
      if(url.search){refusal(res,400,"unexpected-query");return;}
      try{
        const c=await current();
        send(res,200,"application/json; charset=utf-8",exportEvidenceJson(c));
      }catch{refusal(res,503,"source-observation-unavailable");}
      return;
    }
    if(url.pathname==="/api/export.csv"||url.pathname==="/api/export.json"){
      const entries=[...url.searchParams.entries()];
      if(entries.length!==1||entries[0]?.[0]!=="observationId"||
         !/^obs-[a-f0-9]{64}$/.test(entries[0][1])){
        refusal(res,400,"observation-id-required");return;
      }
      const c=snapshots.get(entries[0][1]);
      if(!c||Date.now()-c.storedAt>900000){
        refusal(res,410,"observation-expired");return;
      }
      try{
        const isCsv=url.pathname.endsWith(".csv");
        const payload=isCsv?exportExcelCsv(c.caseView):exportEvidenceJson(c.caseView);
        send(res,200,isCsv?"text/csv; charset=utf-8":"application/json; charset=utf-8",
          payload,false,{
            "Content-Disposition":isCsv?
              'attachment; filename="fde-case-evidence.csv"':
              'attachment; filename="fde-case-evidence.json"'
          });
      }catch{refusal(res,503,"export-refused");}
      return;
    }
    refusal(res,404,"unknown-read-only-route");
  };
}
export function createWorkspaceServer(provider:CaseProvider,
   options:WorkspaceServerOptions={}):Server {
  if(options.host!==undefined&&options.host!=="127.0.0.1")
    throw Error("fde-web-requires-loopback-host");
  if(options.port!==undefined&&
     (!Number.isSafeInteger(options.port)||options.port<0||options.port>65535))
    throw Error("fde-web-invalid-port");
  const handler=createWorkspaceHandler(provider);
  return createServer((req,res)=>{
    void handler(req,res).catch(()=>{if(!res.headersSent)refusal(res,503,"workspace-unavailable");else res.end();});
  });
}
export async function listenLocal(server:Server,port:number):Promise<number>{
  if(!Number.isSafeInteger(port)||port<0||port>65535)
    throw Error("fde-web-invalid-port");
  return new Promise((resolve,reject)=>{
    server.once("error",reject);
    server.listen(port,"127.0.0.1",()=>{
      server.removeListener("error",reject);
      const addr=server.address();
      if(!addr||typeof addr==="string")reject(Error("unexpected-server-address"));
      else resolve(addr.port);
    });
  });
}
