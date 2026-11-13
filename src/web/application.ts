/** Authenticated single-organization W1 host. Source effects have no route. */
import {createServer,type IncomingMessage,type ServerResponse,type Server} from "node:http";
import {readFileSync,existsSync,readdirSync,lstatSync} from "node:fs";
import {dirname,resolve,join,relative} from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {performance} from "node:perf_hooks";
import {bundledSemanticRuntime,type SemanticRuntime} from "../semantic-runtime.js";
import {canonical,type CompanyBinding} from "../company-package.js";
import {admitCase,type ReviewCase} from "../model.js";
import {buildConnectedCase} from "../workspace.js";
import {admitForReview,prepareAdmission,kernelFingerprint,type StoredObservation} from "../admission.js";
import {ReviewStore,ReviewError,parseReviewAction} from "../review-store.js";
import {projectFdeSteps} from "../step-readout.js";
import {parseStrictJson,object} from "../json.js";
import {exportExcelCsv,exportEvidenceJson} from "../export.js";
import {createAuthenticator,type AuthConfig} from "./auth.js";
import {createWorkspaceHandler,validateLocalRequest} from "./server.js";
import {guidedBaselineInvestigation,draftInvestigation,type ModelCall} from "../investigation.js";
import {WorkbenchStore} from "../workbench-store.js";
import {createWorkbenchHandler,assertWorkbenchSourceGrant,type WorkbenchSourceGrant} from "./workbench.js";
import {assessIndustrial,industrialCatalog} from "../industrial-client.js";

export interface ReleaseManifest {
  readonly schema:"fde.release/v1";readonly releaseId:string;readonly sourceRevision:string;
  readonly sourceTreeSha256:string;readonly kernelSha256:string;readonly nodeVersion:string;
  readonly builtAt:string;readonly configurationSchema:"fde.private-lab/v1";
  readonly files:Readonly<Record<string,string>>;
}
export interface ApplicationOptions {
  readonly auth:AuthConfig;readonly store:ReviewStore;readonly release:ReleaseManifest;
  readonly source:()=>Promise<ReviewCase>;
  readonly sourceTimeoutMs?:number;
  readonly now?:()=>number;
  readonly model?:ModelCall;
  readonly semanticRuntime?:SemanticRuntime;
  readonly workbenchStore?:WorkbenchStore;
  readonly workbenchSourceGrants?:()=>readonly WorkbenchSourceGrant[];
}
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
export function readRelease(path=resolve(root,"release.json")):ReleaseManifest{
  const r=object(parseStrictJson(readFileSync(path,"utf8")),
    ["schema","releaseId","sourceRevision","sourceTreeSha256","kernelSha256","nodeVersion","builtAt","configurationSchema","files"],"release");
  if(r.schema!=="fde.release/v1"||r.configurationSchema!=="fde.private-lab/v1"||
     typeof r.releaseId!=="string"||!/^fde-[a-f0-9]{16}$/.test(r.releaseId)||
     typeof r.sourceRevision!=="string"||!/^[a-f0-9]{40}$/.test(r.sourceRevision)||
     typeof r.sourceTreeSha256!=="string"||!/^[a-f0-9]{64}$/.test(r.sourceTreeSha256)||
     typeof r.kernelSha256!=="string"||!/^[a-f0-9]{64}$/.test(r.kernelSha256)||
     r.nodeVersion!==process.version||typeof r.builtAt!=="string"||!Number.isFinite(Date.parse(r.builtAt))||
     !r.files||typeof r.files!=="object"||Array.isArray(r.files))throw Error("release-manifest-refused");
  const releaseRoot=dirname(resolve(path));
  const inventory=(directory:string,skipBin=false):string[]=>readdirSync(directory).sort().flatMap(name=>{
    if(skipBin&&name===".bin")return [];
    const full=join(directory,name),st=lstatSync(full);
    if(st.isSymbolicLink())throw Error("release-symlink-refused");
    return st.isDirectory()?inventory(full,skipBin):st.isFile()?[relative(releaseRoot,full)]:[];
  });
  const expected=[...inventory(join(releaseRoot,"dist")),...inventory(join(releaseRoot,"bin")),
    ...inventory(join(releaseRoot,"web")),...inventory(join(releaseRoot,"kernel")),"package.json","package-lock.json","dependency-manifest.json"].sort();
  if(JSON.stringify(Object.keys(r.files).sort())!==JSON.stringify(expected))throw Error("release-inventory-incomplete");
  for(const [file,hash] of Object.entries(r.files)){
    if(!/^(?:dist\/|bin\/|web\/|kernel\/bin\/|package|dependency-manifest\.json$)/.test(file)||file.includes("..")||
       typeof hash!=="string"||!/^[a-f0-9]{64}$/.test(hash))throw Error("release-file-scope-refused");
    const actual=createHash("sha256").update(readFileSync(resolve(releaseRoot,file))).digest("hex");
    if(actual!==hash)throw Error("release-file-integrity-refused");
  }
  if((r.files as Record<string,string>)["kernel/bin/fde-semantic"]!==r.kernelSha256||
     !existsSync(resolve(releaseRoot,"dist/src/web/application.js")))throw Error("release-kernel-binding-refused");
  const dependencyText=readFileSync(join(releaseRoot,"dependency-manifest.json"),"utf8");
  if(Buffer.byteLength(dependencyText)>2097152)throw Error("dependency-manifest-budget");
  const dependencies=object(JSON.parse(dependencyText),["schema","files"],"dependency manifest");
  if(dependencies.schema!=="fde.dependencies/v1"||!dependencies.files||typeof dependencies.files!=="object"||Array.isArray(dependencies.files))throw Error("dependency-manifest-refused");
  if(JSON.stringify(Object.keys(dependencies.files).sort())!==JSON.stringify(inventory(join(releaseRoot,"node_modules"),true).sort()))throw Error("dependency-inventory-incomplete");
  for(const [file,hash] of Object.entries(dependencies.files)){
    if(typeof hash!=="string"||createHash("sha256").update(readFileSync(join(releaseRoot,file))).digest("hex")!==hash)throw Error("dependency-integrity-refused");
  }
  const releaseId="fde-"+createHash("sha256").update(JSON.stringify({revision:r.sourceRevision,sourceTreeSha256:r.sourceTreeSha256,files:r.files})).digest("hex").slice(0,16);
  if(releaseId!==r.releaseId)throw Error("release-identity-refused");
  return r as unknown as ReleaseManifest;
}
function send(res:ServerResponse,status:number,body:unknown,extra:Record<string,string>={}){
  const text=JSON.stringify(body)+"\n";
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store, max-age=0",
    "X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer",
    "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","Content-Length":Buffer.byteLength(text),...extra});
  res.end(text);
}
function fail(res:ServerResponse,status:number,code:string){send(res,status,{schema:"fde.application-error/v1",code,authority:"none"});}
function observationId(url:URL):string{
  const values=[...url.searchParams];
  if(values.length!==1||values[0]?.[0]!=="observationId"||!/^obs-[a-f0-9]{64}$/.test(values[0][1]))
    throw new ReviewError(400,"observation-id-required");
  return values[0][1];
}
async function body(req:IncomingMessage):Promise<unknown>{
  if(req.headers["content-type"]!=="application/json"||req.headers["x-fde-request"]!=="w1")
    throw new ReviewError(415,"json-and-request-header-required");
  const announced=Number(req.headers["content-length"]??0);
  if(!Number.isSafeInteger(announced)||announced<0||announced>16384)throw new ReviewError(413,"request-budget");
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>16384)throw new ReviewError(413,"request-budget");chunks.push(Buffer.from(chunk));}
  try{return parseStrictJson(Buffer.concat(chunks).toString("utf8"));}
  catch{throw new ReviewError(400,"invalid-json-body");}
}
export interface CompanyApplicationRuntime {
  readonly schema:"fde.application-runtime/v1";readonly releaseId:string;
  readonly hostReleaseId:string;readonly hostRelease:ReleaseManifest;
  readonly sourceRevision:string;readonly kernelSha256:string;readonly semanticPackage:CompanyBinding;
}
export function selectedApplicationRelease(base:ReleaseManifest,runtime:SemanticRuntime):ReleaseManifest|CompanyApplicationRuntime{
  const kernelSha256=kernelFingerprint(runtime);
  if(!runtime.companyPackage){
    if(kernelSha256!==base.kernelSha256)throw Error("release-kernel-mismatch");
    return base;
  }
  const binding={hostReleaseId:base.releaseId,kernelSha256,semanticPackage:runtime.companyPackage};
  const releaseId="fde-"+createHash("sha256").update(canonical(binding)).digest("hex").slice(0,16);
  return {schema:"fde.application-runtime/v1",...binding,releaseId,hostRelease:base,sourceRevision:base.sourceRevision};
}
export function createApplicationServer(options:ApplicationOptions):Server{
  const {store}=options,now=options.now??Date.now;
  const runtime=options.semanticRuntime??bundledSemanticRuntime();
  const release=selectedApplicationRelease(options.release,runtime);
  store.bindSemanticPackage(runtime.companyPackage);
  store.registerRelease(release);
  const authenticate=createAuthenticator(options.auth);
  const reviewers=new Set(options.auth.users.filter(u=>u.role!=="viewer").map(u=>u.id));
  const assets=createWorkspaceHandler(async()=>{throw Error("asset-handler-cannot-acquire");});
  const workbench=options.workbenchStore?createWorkbenchHandler({
    store:options.workbenchStore,now,companyPackage:runtime.companyPackage,
    assess:input=>assessIndustrial(input,runtime),catalog:()=>industrialCatalog(runtime),
    kernelSha256:()=>runtime.fingerprint(),sourceGrants:options.workbenchSourceGrants,
    ...(options.workbenchSourceGrants?{importPinnedW1:(sourceId:string,id:string)=>{
      if(sourceId!=="w1-observations")throw new ReviewError(403,"workbench-source-not-configured");
      const pin=store.get(id);
      return {schema:"fde.workbench-w1-receipt/v1",observationId:id,view:pin.view,admission:pin.snapshot,
        releaseId:pin.releaseId,kernelSha256:pin.kernelSha256,acquiredAt:pin.acquiredAt,sourceWriteAllowed:false};
    }}:{})
  }):undefined;
  let pending:Promise<StoredObservation>|undefined;
  let lastAcquisition:StoredObservation|undefined;
  async function acquire():Promise<StoredObservation>{
    if(pending)return pending;
    const started=performance.now();
    let expired=false;
    const operation=(async()=>{
      let raw:ReviewCase;
      try{raw=await options.source();}
      catch{if(!expired)store.recordAttempt("unavailable",release.releaseId,performance.now()-started);throw new ReviewError(503,"source-observation-unavailable");}
      if(expired)throw new ReviewError(504,"source-observation-timeout");
      try{
        const input=admitCase(raw),view=buildConnectedCase(input,runtime);
        let existing:StoredObservation|undefined;
        try{existing=store.get(view.observationId);}catch(error){if(!(error instanceof ReviewError&&error.status===404))throw error;}
        if(existing){store.recordAttempt("ok",release.releaseId,performance.now()-started);lastAcquisition=existing;return existing;}
        const admission=prepareAdmission(input,view);
        const snapshot=admitForReview(admission,runtime);
        const saved:StoredObservation={schema:"fde.stored-observation/v1",view,admission,snapshot,
          releaseId:release.releaseId,kernelSha256:release.kernelSha256,acquiredAt:new Date(now()).toISOString(),
          ...(runtime.companyPackage?{semanticPackage:runtime.companyPackage}:{})};
        store.put(saved);store.recordAttempt("ok",release.releaseId,performance.now()-started);
        lastAcquisition=saved;return saved;
      }catch{store.recordAttempt("invalid",release.releaseId,performance.now()-started);throw new ReviewError(503,"source-validation-refused");}
    })();
    // Keep the operation in flight until its source actually settles; a timeout does
    // not authorize a second overlapping read, and late results cannot become current.
    let timer:NodeJS.Timeout|undefined;
    const timeout=new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>{expired=true;store.recordAttempt("timeout",release.releaseId,performance.now()-started);
        reject(new ReviewError(504,"source-observation-timeout"));},options.sourceTimeoutMs??15000);
    });
    const exposed=Promise.race([operation,timeout]);
    pending=exposed;
    void operation.finally(()=>{if(timer)clearTimeout(timer);pending=undefined;}).catch(()=>{});
    return exposed;
  }
  const server=createServer((req,res)=>{
    void (async()=>{
      if(!validateLocalRequest(req)){fail(res,403,"local-origin-required");return;}
      const url=new URL(req.url??"/","http://127.0.0.1");
      if(url.pathname==="/health"&&url.search===""&&(req.method==="GET"||req.method==="HEAD")){
        send(res,200,{schema:"fde.application-health/v1",status:"alive",releaseId:release.releaseId,
          readiness:"not-asserted",sourceCurrentness:"not-asserted",vendorWriteCapability:false,authority:"none"});return;
      }
      const principal=await authenticate(req);
      if(!principal){send(res,401,{schema:"fde.application-error/v1",code:"authentication-required",authority:"none"},
        {"WWW-Authenticate":'Basic realm="FDE private lab", charset="UTF-8"'});return;}
      if((req.method==="GET"||req.method==="HEAD")&&["/","/app.js","/styles.css","/workbench","/workbench.js","/workbench.css"].includes(url.pathname)){
        await assets(req,res);return;
      }
      if(workbench&&await workbench(req,res,principal))return;
      // A provisioned source policy applies to every path disclosing the same W1
      // evidence, including legacy routes. A narrower page cannot secure a broad API.
      if(options.workbenchSourceGrants&&["/api/case","/api/cases","/api/review","/api/replay","/api/investigation","/api/investigation-status","/api/steps","/api/export.json","/api/export.csv","/api/handoff.json","/api/source-status","/api/operations"].includes(url.pathname)){
        assertWorkbenchSourceGrant(principal,"w1-observations",options.workbenchSourceGrants(),now());
        if(url.pathname==="/api/case")throw new ReviewError(403,"fresh-source-acquisition-not-authorized-by-pinned-read-policy");
      }
      if(req.method==="POST"&&url.pathname==="/api/review"&&url.search===""){
        if(principal.role==="viewer"){fail(res,403,"reviewer-role-required");return;}
        let action;
        try{action=parseReviewAction(await body(req));}
        catch(error){if(error instanceof ReviewError)throw error;throw new ReviewError(400,"invalid-review-action");}
        send(res,200,store.act(principal,action,reviewers));return;
      }
      if(req.method==="POST"&&url.pathname==="/api/investigation"&&url.search===""){
        if(principal.role==="viewer"){fail(res,403,"reviewer-role-required");return;}
        let id:string,requestId:string;
        try{const input=object(await body(req),["observationId","requestId"],"investigation input");
          if(typeof input.observationId!=="string"||!/^obs-[a-f0-9]{64}$/.test(input.observationId)||
             typeof input.requestId!=="string")throw Error("invalid-id");
          id=input.observationId;requestId=input.requestId;
        }catch(error){if(error instanceof ReviewError)throw error;throw new ReviewError(400,"invalid-investigation-request");}
        const stored=store.get(id);
        if(!options.model){send(res,503,{code:"local-model-not-enabled",baseline:guidedBaselineInvestigation(stored.view)});return;}
        const reservation=store.beginInvestigation(principal.id,requestId,id);
        if(!reservation.started){
          send(res,reservation.view.state==="pending"?202:200,{...reservation.view,duplicate:true});return;
        }
        try{const draft=await draftInvestigation(stored.view,options.model);
          send(res,200,store.finishInvestigation(principal.id,requestId,id,"completed",draft));
        }catch{
          send(res,503,store.finishInvestigation(principal.id,requestId,id,"failed"));
        }
        return;
      }
      if(req.method!=="GET"){fail(res,405,"method-not-permitted");return;}
      if(url.pathname==="/api/session"&&url.search===""){
        send(res,200,{principal,assignees:[...reviewers],authentication:"rfc7617-over-loopback-ssh",
          deployment:"private-single-organization-lab",modelEnabled:options.model!==undefined,sourceWriteAllowed:false});return;
      }
      if(url.pathname==="/api/version"&&url.search===""){
        send(res,200,release.schema==="fde.application-runtime/v1"?
          {...release,hostRelease:{...release.hostRelease,files:undefined}}:{...release,files:undefined});return;
      }
      if(url.pathname==="/ready"&&url.search===""){
        const ready=store.ready()&&(options.workbenchStore?.ready()??true)&&kernelFingerprint(runtime)===release.kernelSha256;
        send(res,ready?200:503,{schema:"fde.application-readiness/v1",status:ready?"ready":"not-ready",
          releaseId:release.releaseId,sourceAvailability:"checked-separately",store:ready?"available":"unavailable"});return;
      }
      if(url.pathname==="/api/source-status"&&url.search===""){
        send(res,200,{...store.sourceStatus(),releaseId:release.releaseId,
          lastObservationId:lastAcquisition?.view.observationId??null});return;
      }
      if(url.pathname==="/api/case"&&url.search===""){
        const stored=await acquire();send(res,200,stored.view,{"X-FDE-Release":release.releaseId});return;
      }
      if(url.pathname==="/api/cases"&&url.search===""){
        send(res,200,{schema:"fde.observation-list/v1",observations:store.list()});return;
      }
      if(url.pathname==="/api/review"){
        send(res,200,store.review(observationId(url)));return;
      }
      if(url.pathname==="/api/steps"){
        const entries=[...url.searchParams.entries()];
        if(entries.length!==2||!url.searchParams.has("observationId")||
          !url.searchParams.has("resolution"))
          throw new ReviewError(400,"step-resolution-required");
        const resolution=url.searchParams.get("resolution");
        if(!["summary","sources","semantics","review"].includes(resolution??""))
          throw new ReviewError(400,"unsupported-step-resolution");
        const id=url.searchParams.get("observationId");
        if(!id||!/^obs-[a-f0-9]{64}$/.test(id))
          throw new ReviewError(400,"observation-id-required");
        send(res,200,projectFdeSteps(store.get(id),store.review(id),resolution as
          "summary"|"sources"|"semantics"|"review"));return;
      }
      if(url.pathname==="/api/replay"){
        const stored=store.get(observationId(url));
        send(res,200,{schema:"fde.pinned-replay/v1",matched:true,readsFreshSources:false,
          observationId:stored.view.observationId,admissionId:stored.snapshot.context.admissionId,
          grade:stored.snapshot.grade,recordedReleaseId:stored.releaseId,executingReleaseId:release.releaseId,
          authority:"none",businessTruthSelected:false,sourceWriteAllowed:false});return;
      }
      if(url.pathname==="/api/investigation-status"){
        if(principal.role==="viewer")throw new ReviewError(403,"reviewer-role-required");
        const entries=[...url.searchParams.entries()];
        if(entries.length!==1||entries[0]?.[0]!=="requestId")
          throw new ReviewError(400,"investigation-request-id-required");
        const state=store.investigationStatus(principal.id,entries[0][1]);
        send(res,state.state==="pending"?202:200,state);return;
      }
      if(url.pathname==="/api/investigation"){
        send(res,200,guidedBaselineInvestigation(store.get(observationId(url)).view));return;
      }
      if(url.pathname==="/api/export.json"||url.pathname==="/api/export.csv"){
        const stored=store.get(observationId(url)),csv=url.pathname.endsWith(".csv");
        const payload=csv?exportExcelCsv(stored.view):exportEvidenceJson(stored.view);
        res.writeHead(200,{"Content-Type":csv?"text/csv; charset=utf-8":"application/json; charset=utf-8",
          "Content-Disposition":'attachment; filename="fde-case-evidence.'+(csv?"csv":"json")+'"',
          "Cache-Control":"no-store, max-age=0","X-Content-Type-Options":"nosniff","X-FDE-Release":release.releaseId,
          "X-FDE-Observation":stored.view.observationId,"Content-Length":Buffer.byteLength(payload)});
        res.end(payload);return;
      }
      if(url.pathname==="/api/handoff.json"){
        const stored=store.get(observationId(url));
        send(res,200,{schema:"fde.review-handoff/v1",evidence:stored.view,admission:stored.snapshot,
          review:store.review(stored.view.observationId),recordedReleaseId:stored.releaseId,
          authority:"none",sourceWriteAllowed:false},{"Content-Disposition":'attachment; filename="fde-review-handoff.json"'});return;
      }
      if(url.pathname==="/api/operations"&&url.search===""){
        if(principal.role!=="operator"){fail(res,403,"operator-role-required");return;}
        send(res,200,{releaseId:release.releaseId,counts:store.counts(),sourceStatus:store.sourceStatus(),lifecycleControl:false});return;
      }
      fail(res,404,"unknown-route");
    })().catch(error=>{
      if(res.headersSent){res.end();return;}
      if(error instanceof ReviewError)fail(res,error.status,error.code);
      else fail(res,503,"application-unavailable");
    });
  });
  server.requestTimeout=20000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  return server;
}
