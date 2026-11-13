/** Authenticated finite workbench routes. The caller authenticates before invoking this handler. */
import type {IncomingMessage,ServerResponse} from "node:http";
import {createHash} from "node:crypto";
import type {IndustrialCatalog} from "../industrial-client.js";
import {buildIndustrySet,buildIndustryBrief,formatIndustryBriefMarkdown} from "../industry-set.js";
import {object,parseStrictJson,FdeInputError} from "../json.js";
import {ReviewError} from "../review-store.js";
import {emptyWorkbenchDocument,parseActionId,parseCaseId,parseExpectedVersion,workbenchAssessmentRequest} from "../workbench-model.js";
import {WorkbenchStore,workbenchDigest,type CaseAction,type PinnedW1Import} from "../workbench-store.js";
import type {Principal} from "./auth.js";
import type {CompanyBinding} from "../company-package.js";

/** Owner-provisioned policy. A case permission record cannot create or change this policy. */
export interface WorkbenchSourceGrant {readonly sourceId:string;readonly principals:readonly string[];
  readonly action:"read-pinned-w1";readonly validFrom:string;readonly validUntil:string;readonly revoked:boolean}
export interface WorkbenchHandlerOptions {
  readonly store:WorkbenchStore;
  readonly assess:(input:unknown)=>unknown|Promise<unknown>;
  readonly catalog:()=>unknown|Promise<unknown>;
  readonly kernelSha256:()=>string;
  readonly companyPackage?:CompanyBinding;
  readonly now?:()=>number;
  readonly sourceGrants?:()=>readonly WorkbenchSourceGrant[];
  /** Read already-admitted W1 evidence only. Never acquire fresh sources or accept arbitrary locations here. */
  readonly importPinnedW1?:(sourceId:string,observationId:string)=>unknown|Promise<unknown>;
}
function send(res:ServerResponse,status:number,value:unknown,extra:Record<string,string>={}):void{
  const body=JSON.stringify(value)+"\n";res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store, max-age=0",
    "X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'","Content-Length":Buffer.byteLength(body),...extra});res.end(body);
}
async function streamLine(res:ServerResponse,line:string):Promise<void>{
  if(res.destroyed)throw Error("workbench-export-client-closed");if(res.write(line))return;
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{res.off("drain",drain);res.off("close",close);res.off("error",error);};
    const drain=()=>{cleanup();resolve();},close=()=>{cleanup();reject(Error("workbench-export-client-closed"));},error=(e:Error)=>{cleanup();reject(e);};
    res.once("drain",drain);res.once("close",close);res.once("error",error);
  });
}
function editable(p:Principal):void{if(p.role!=="reviewer"&&p.role!=="operator")throw new ReviewError(403,"reviewer-role-required");}
async function body(req:IncomingMessage):Promise<unknown>{
  if(req.headers["content-type"]!=="application/json"||req.headers["x-fde-request"]!=="workbench")throw new ReviewError(415,"json-and-workbench-header-required");
  const announced=Number(req.headers["content-length"]??0);if(!Number.isSafeInteger(announced)||announced<0||announced>114688)throw new ReviewError(413,"workbench-request-budget");
  const chunks:Buffer[]=[];let size=0;for await(const part of req){size+=part.length;if(size>114688)throw new ReviewError(413,"workbench-request-budget");chunks.push(Buffer.from(part));}
  try{return parseStrictJson(Buffer.concat(chunks).toString("utf8"));}catch{throw new ReviewError(400,"invalid-json-body");}
}
function fields(raw:unknown,keys:readonly string[]):Record<string,unknown>{try{return object(raw,keys,"workbench request");}catch{throw new ReviewError(400,"invalid-workbench-request");}}
function action(raw:Record<string,unknown>):CaseAction{return {actionId:parseActionId(raw.actionId),caseId:parseCaseId(raw.caseId),expectedVersion:parseExpectedVersion(raw.expectedVersion)};}
function query(url:URL,allowed:readonly string[],required:readonly string[]):Record<string,string>{
  const result:Record<string,string>={};for(const [key,value] of url.searchParams){if(!allowed.includes(key)||Object.hasOwn(result,key)||!value)throw new ReviewError(400,"invalid-workbench-query");result[key]=value;}
  if(required.some(key=>!Object.hasOwn(result,key)))throw new ReviewError(400,"invalid-workbench-query");return result;
}
export function assertWorkbenchSourceGrant(principal:Principal,sourceId:string,grants:readonly WorkbenchSourceGrant[],now:number):void{
  const matching=grants.filter(g=>g.sourceId===sourceId&&g.action==="read-pinned-w1"&&g.principals.includes(principal.id));
  // Any explicit revocation for this subject/action defeats stale overlapping grants.
  if(matching.length===0||matching.some(g=>g.revoked)||!matching.some(g=>{
    const start=Date.parse(g.validFrom),end=Date.parse(g.validUntil);return Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end;
  }))throw new ReviewError(403,"workbench-source-permission-required");
}
export function createWorkbenchHandler(options:WorkbenchHandlerOptions){
  const {store}=options,now=options.now??Date.now;
  store.bindSemanticPackage(options.companyPackage);
  function visibleImport(principal:Principal,pin:PinnedW1Import):Record<string,unknown>{
    try{assertWorkbenchSourceGrant(principal,pin.sourceId,options.sourceGrants?.()??[],now());return {...pin,access:"permitted"};}
    catch(error){
      if(!(error instanceof ReviewError&&error.status===403))throw error;
      return {...pin,receipt:null,access:"withheld-current-permission"};
    }
  }
  return async(req:IncomingMessage,res:ServerResponse,principal:Principal):Promise<boolean>=>{
    const url=new URL(req.url??"/","http://127.0.0.1");if(!url.pathname.startsWith("/api/workbench/"))return false;
    try{
      if(req.method==="GET"){
        if(url.pathname==="/api/workbench/catalog"){
          query(url,[],[]);const catalog=object(await options.catalog(),["schema","entries","authority"],"industrial catalog");
          if(catalog.schema!=="fde.industrial-catalog/v1"||!Array.isArray(catalog.entries)||catalog.authority!=="none")throw new ReviewError(503,"workbench-catalog-refused");
          // Preserve legacy/mock catalog reads; mark the optional industry set unverified
          // when this host has not supplied Haskell's full eight-family catalog.
          let industrySet:ReturnType<typeof buildIndustrySet>|null=null;
          try{industrySet=buildIndustrySet(catalog as unknown as IndustrialCatalog);}
          catch(error){if(!(error instanceof TypeError))throw error;}
          send(res,200,{schema:"fde.workbench-catalog/v1",entries:catalog.entries,emptyDocument:emptyWorkbenchDocument(),
            industrySet,industrySetStatus:industrySet?"available":"unverified",
            sourceImportsEnabled:options.importPinnedW1!==undefined,privateNotesAllowed:principal.role==="operator",authority:"investigation-guidance-only",sourceWriteAllowed:false});return true;
        }
        if(url.pathname==="/api/workbench/industry-set"){
          query(url,[],[]);send(res,200,buildIndustrySet(await options.catalog() as IndustrialCatalog));return true;
        }
        if(url.pathname==="/api/workbench/industry-brief"){
          const q=query(url,["caseId","format"],["caseId"]),caseId=parseCaseId(q.caseId);
          const format=q.format??"json";
          if(format!=="json"&&format!=="markdown")throw new ReviewError(400,"invalid-industry-brief-format");
          const saved=store.get(caseId),kernel=options.kernelSha256();
          const brief=buildIndustryBrief(saved,await options.catalog() as IndustrialCatalog,
            store.evaluations(caseId),kernel);
          if(store.get(caseId).version!==saved.version||kernel!==options.kernelSha256())
            throw new ReviewError(409,"industry-brief-source-changed");
          if(format==="json"){send(res,200,brief);return true;}
          const markdown=formatIndustryBriefMarkdown(brief);
          res.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8",
            "Content-Disposition":'attachment; filename="fde-industry-brief.md"',
            "Cache-Control":"no-store, max-age=0","X-Content-Type-Options":"nosniff",
            "X-Frame-Options":"DENY","Referrer-Policy":"no-referrer",
            "Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'",
            "X-FDE-Case-Version":String(saved.version),"Content-Length":Buffer.byteLength(markdown)});
          res.end(markdown);return true;
        }
        if(url.pathname==="/api/workbench/cases"){
          const q=query(url,["q","offset"],[]);send(res,200,{schema:"fde.workbench-case-list/v1",...store.listPage(q.q??"",q.offset===undefined?0:Number(q.offset))});return true;
        }
        if(url.pathname==="/api/workbench/case"){
          const q=query(url,["id"],["id"]),caseId=parseCaseId(q.id),handoff=store.handoff(caseId);
          send(res,200,{case:handoff.case,evaluations:handoff.evaluations,imports:(handoff.imports as readonly PinnedW1Import[]).map(pin=>visibleImport(principal,pin)),evaluationTotal:handoff.evaluationTotal,importTotal:handoff.importTotal,
            evaluationsTruncated:handoff.evaluationsTruncated,importsTruncated:handoff.importsTruncated});return true;
        }
        if(url.pathname==="/api/workbench/history"){
          const q=query(url,["caseId","afterVersion"],["caseId"]);send(res,200,{schema:"fde.workbench-history/v1",caseId:q.caseId,...store.history(parseCaseId(q.caseId),q.afterVersion===undefined?-1:Number(q.afterVersion))});return true;
        }
        if(url.pathname==="/api/workbench/export"){
          const q=query(url,["caseId"],["caseId"]),records=store.handoffRecords(parseCaseId(q.caseId)),first=records.next(),digest=createHash("sha256");let withheldImports=0;
          try{
            if(first.done)throw new ReviewError(503,"workbench-export-empty");
            res.writeHead(200,{"Content-Type":"application/x-ndjson; charset=utf-8","Content-Disposition":'attachment; filename="fde-workbench-handoff.jsonl"',
              "Cache-Control":"no-store, max-age=0","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'"});
            const emit=async(raw:Record<string,unknown>)=>{
              let record=raw;
              if(raw.recordType==="import"){
                const imported=visibleImport(principal,raw.import as PinnedW1Import);if(imported.access!=="permitted")withheldImports++;
                record={...raw,import:imported};
              }
              if(raw.recordType==="end")record={...raw,withheldImports,contentSha256:digest.digest("hex")};
              const line=JSON.stringify(record)+"\n";if(raw.recordType!=="end")digest.update(line);await streamLine(res,line);
            };
            await emit(first.value);for(const record of records)await emit(record);res.end();
          }catch(error){if(res.headersSent){res.destroy(error instanceof Error?error:undefined);return true;}throw error;}
          finally{records.return(undefined);}
          return true;
        }
        if(url.pathname==="/api/workbench/replay"){
          const q=query(url,["evaluationId"],["evaluationId"]),pin=store.evaluation(q.evaluationId!);
          if(pin.kernelSha256!==options.kernelSha256())throw new ReviewError(409,"workbench-pinned-kernel-unavailable");
          const result=await options.assess(pin.input);if(workbenchDigest(result)!==workbenchDigest(pin.result))throw new ReviewError(409,"workbench-replay-mismatch");
          if(pin.kernelSha256!==options.kernelSha256())throw new ReviewError(409,"workbench-kernel-changed-during-replay");
          send(res,200,{schema:"fde.workbench-replay/v1",evaluationId:pin.evaluationId,matched:true,readsFreshSources:false,
            evaluatedCaseVersion:pin.caseVersion,currentCaseVersion:store.get(pin.caseId).version,authority:"non-authoritative-diagnostic",sourceWriteAllowed:false});return true;
        }
        if(url.pathname==="/api/workbench/private-note"){
          const q=query(url,["caseId"],["caseId"]);send(res,200,{privateNote:store.privateNote(principal,parseCaseId(q.caseId))});return true;
        }
      }
      if(req.method==="POST"){
        query(url,[],[]);editable(principal);
        if(url.pathname==="/api/workbench/cases"){
          const v=fields(await body(req),["actionId","document"]);send(res,200,store.create(principal,parseActionId(v.actionId),v.document));return true;
        }
        if(url.pathname==="/api/workbench/case"){
          const v=fields(await body(req),["actionId","caseId","expectedVersion","document"]);send(res,200,store.update(principal,action(v),v.document));return true;
        }
        if(url.pathname==="/api/workbench/evaluate"){
          const v=fields(await body(req),["actionId","caseId","expectedVersion"]),a=action(v),prior=store.evaluationRetry(principal,a);
          if(prior){send(res,200,{duplicate:true,evaluation:prior});return true;}
          const current=store.get(a.caseId);if(current.version!==a.expectedVersion)throw new ReviewError(409,"workbench-version-conflict");
          const input=workbenchAssessmentRequest(current.document),kernel=options.kernelSha256(),result=await options.assess(input);
          if(kernel!==options.kernelSha256())throw new ReviewError(409,"workbench-kernel-changed-during-evaluation");
          send(res,200,store.recordEvaluation(principal,a,input,result,kernel));return true;
        }
        if(url.pathname==="/api/workbench/import-w1"){
          const v=fields(await body(req),["actionId","caseId","expectedVersion","sourceId","observationId"]),a=action(v);
          if(typeof v.sourceId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v.sourceId)||typeof v.observationId!=="string"||!/^obs-[a-f0-9]{64}$/.test(v.observationId))throw new ReviewError(400,"invalid-w1-import-reference");
          assertWorkbenchSourceGrant(principal,v.sourceId,options.sourceGrants?.()??[],now());
          if(!options.importPinnedW1)throw new ReviewError(503,"workbench-source-import-disabled");
          const prior=store.importRetry(principal,a,v.sourceId,v.observationId);if(prior){send(res,200,{duplicate:true,import:prior});return true;}
          if(store.get(a.caseId).version!==a.expectedVersion)throw new ReviewError(409,"workbench-version-conflict");
          const receipt=await options.importPinnedW1(v.sourceId,v.observationId);
          assertWorkbenchSourceGrant(principal,v.sourceId,options.sourceGrants?.()??[],now());
          send(res,200,store.recordImport(principal,a,v.sourceId,v.observationId,receipt));return true;
        }
        if(url.pathname==="/api/workbench/private-note"){
          if(principal.role!=="operator")throw new ReviewError(403,"operator-role-required");
          const v=fields(await body(req),["actionId","caseId","expectedVersion","note"]);send(res,200,store.savePrivateNote(principal,action(v),v.note));return true;
        }
      }
      throw new ReviewError(req.method==="GET"||req.method==="POST"?404:405,"unknown-workbench-route");
    }catch(error){
      if(res.headersSent){res.end();return true;}
      if(error instanceof FdeInputError&&["industrial-input-refused","industrial-input-budget"].includes(error.code)&&req.method==="POST"&&url.pathname==="/api/workbench/evaluate"){
        const status=error.code==="industrial-input-budget"?413:422;
        send(res,status,{schema:"fde.application-error/v1",code:error.code,detail:error.message.slice(0,300),authority:"none"});
      }
      else if(error instanceof FdeInputError&&["industrial-input-refused","industrial-input-budget"].includes(error.code)&&req.method==="GET"&&url.pathname==="/api/workbench/replay")
        send(res,409,{schema:"fde.application-error/v1",code:"workbench-pinned-input-no-longer-replays",authority:"none"});
      else if(error instanceof ReviewError)send(res,error.status,{schema:"fde.application-error/v1",code:error.code,authority:"none"});
      else send(res,503,{schema:"fde.application-error/v1",code:"workbench-operation-unavailable",authority:"none"});
      return true;
    }
  };
}
