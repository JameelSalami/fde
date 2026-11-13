/** Durable application records and diagnostic pins. Owner custody, not a hash, is the security boundary. */
import {DatabaseSync,backup} from "node:sqlite";
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,realpathSync,chmodSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomUUID,createHash} from "node:crypto";
import {canonical,type CompanyBinding} from "./company-package.js";
import {detach,parseStrictJson,detachIndustrialResponse,parseIndustrialResponseJson} from "./json.js";
import {ReviewError} from "./review-store.js";
import {parseWorkbenchDocument,parseActionId,parseCaseId,parseExpectedVersion,parsePrivateNote,workbenchAssessmentRequest,type WorkbenchDocument} from "./workbench-model.js";
import type {Principal} from "./web/auth.js";

type Row=Record<string,string|number|bigint|Uint8Array|null>;
export interface WorkbenchCase {readonly schema:"fde.workbench-case/v1";readonly caseId:string;readonly version:number;
  readonly document:WorkbenchDocument;readonly createdAt:string;readonly updatedAt:string;
  readonly authority:"application-record-only";readonly sourceWriteAllowed:false}
export interface CaseAction {readonly actionId:string;readonly caseId:string;readonly expectedVersion:number}
export interface WorkbenchEvaluation {readonly schema:"fde.workbench-evaluation/v1";readonly evaluationId:string;
  readonly caseId:string;readonly caseVersion:number;readonly input:unknown;readonly result:unknown;readonly kernelSha256:string;
  readonly createdAt:string;readonly actor:string;readonly authority:"non-authoritative-diagnostic";readonly sourceWriteAllowed:false}
export interface PinnedW1Import {readonly schema:"fde.workbench-w1-import/v1";readonly importId:string;readonly caseId:string;
  readonly caseVersion:number;readonly sourceId:string;readonly observationId:string;readonly receipt:unknown;
  readonly createdAt:string;readonly actor:string;readonly origin:"host-pinned-w1";readonly sourceWriteAllowed:false}
export const workbenchDigest=(value:unknown):string=>createHash("sha256").update(canonical(value)).digest("hex");
function canEdit(p:Principal):void{if(p.role!=="reviewer"&&p.role!=="operator")throw new ReviewError(403,"reviewer-role-required");}
function isOperator(p:Principal):void{if(p.role!=="operator")throw new ReviewError(403,"operator-role-required");}
function validAction(a:CaseAction):void{parseActionId(a.actionId);parseCaseId(a.caseId);parseExpectedVersion(a.expectedVersion);}
function packed(value:unknown):string{const body=JSON.stringify(detach(value));if(Buffer.byteLength(body)>262144)throw new ReviewError(413,"workbench-record-budget");return body;}
function packedIndustrialResult(value:unknown):string{const body=JSON.stringify(detachIndustrialResponse(value));if(Buffer.byteLength(body)>2097152)throw new ReviewError(503,"workbench-result-budget");return body;}

export class WorkbenchStore {
  private readonly db:DatabaseSync;
  constructor(readonly path:string,private readonly now:()=>number=Date.now,readOnlySnapshot=false){
    if(path!==":memory:"){
      const parent=dirname(resolve(path));mkdirSync(parent,{recursive:true,mode:0o700});
      const ps=lstatSync(parent);
      if(ps.isSymbolicLink()||realpathSync(parent)!==parent||(ps.mode&0o077)!==0||(process.getuid&&ps.uid!==process.getuid()))throw Error("workbench-directory-custody-refused");
      if(!existsSync(path)){if(readOnlySnapshot)throw Error("workbench-snapshot-source-missing");const fd=openSync(path,"wx",0o600);closeSync(fd);}
      const st=lstatSync(path);
      if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw Error("workbench-store-custody-refused");
    }
    this.db=new DatabaseSync(path,{enableForeignKeyConstraints:true,allowExtension:false,readOnly:readOnlySnapshot});
    if(readOnlySnapshot){
      this.db.exec("PRAGMA busy_timeout=2000; BEGIN DEFERRED;");
      if(Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version)!==1){this.db.close();throw Error("workbench-schema-incompatible");}
      return;
    }
    this.db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const version=Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if(version!==0&&version!==1){this.db.close();throw Error("workbench-schema-incompatible");}
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workbench_cases(case_id TEXT PRIMARY KEY,version INTEGER NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL,phase TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,document TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_semantic_context(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_revisions(case_id TEXT NOT NULL REFERENCES workbench_cases(case_id),version INTEGER NOT NULL,actor TEXT NOT NULL,actor_role TEXT NOT NULL,created_at TEXT NOT NULL,document TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(case_id,version)) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_actions(action_id TEXT PRIMARY KEY,kind TEXT NOT NULL,case_id TEXT NOT NULL REFERENCES workbench_cases(case_id),request_digest TEXT NOT NULL,result_id TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_evaluations(evaluation_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES workbench_cases(case_id),case_version INTEGER NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,kernel_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_w1_imports(import_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES workbench_cases(case_id),case_version INTEGER NOT NULL,source_id TEXT NOT NULL,observation_id TEXT NOT NULL,receipt TEXT NOT NULL,created_at TEXT NOT NULL,actor TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_private_notes(case_id TEXT PRIMARY KEY REFERENCES workbench_cases(case_id),version INTEGER NOT NULL,note TEXT NOT NULL,updated_at TEXT NOT NULL,actor TEXT NOT NULL,digest TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS workbench_private_actions(action_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES workbench_cases(case_id),request_digest TEXT NOT NULL) STRICT;
      PRAGMA user_version=1;
    `);
    if(Number((this.db.prepare("SELECT COUNT(*) AS n FROM workbench_cases").get() as Row).n)>0)
      this.db.prepare("INSERT OR IGNORE INTO workbench_semantic_context VALUES (1,'null')").run();
  }
  close():void{this.db.close();}
  ready():boolean{return (this.db.prepare("PRAGMA quick_check").get() as Row).quick_check==="ok";}
  private transaction<T>(f:()=>T):T{this.db.exec("BEGIN IMMEDIATE");try{const r=f();this.db.exec("COMMIT");return r;}catch(error){this.db.exec("ROLLBACK");throw error;}}
  private time():string{return new Date(this.now()).toISOString();}
  bindSemanticPackage(binding:CompanyBinding|undefined):void{
    const encoded=canonical(binding??null);
    this.transaction(()=>{
      const row=this.db.prepare("SELECT binding FROM workbench_semantic_context WHERE id=1").get() as Row|undefined;
      if(row){if(row.binding!==encoded)throw new ReviewError(503,"workbench-company-state-binding-refused");}
      else this.db.prepare("INSERT INTO workbench_semantic_context VALUES (1,?)").run(encoded);
    });
  }
  private actionDigest(principal:Principal,kind:string,request:unknown):string{return workbenchDigest({principal,kind,request});}
  private prior(actionId:string,digest:string):Row|undefined{
    const prior=this.db.prepare("SELECT kind,case_id,request_digest,result_id FROM workbench_actions WHERE action_id=?").get(actionId) as Row|undefined;
    if(prior&&prior.request_digest!==digest)throw new ReviewError(409,"idempotency-key-reused");return prior;
  }
  private recordAction(actionId:string,kind:string,caseId:string,digest:string,resultId:string):void{
    this.db.prepare("INSERT INTO workbench_actions VALUES (?,?,?,?,?)").run(actionId,kind,caseId,digest,resultId);
  }
  get(caseId:string):WorkbenchCase{
    parseCaseId(caseId);const row=this.db.prepare("SELECT * FROM workbench_cases WHERE case_id=?").get(caseId) as Row|undefined;
    if(!row)throw new ReviewError(404,"workbench-case-not-found");
    const document=parseWorkbenchDocument(parseStrictJson(String(row.document)));
    if(workbenchDigest(document)!==row.digest)throw new ReviewError(503,"workbench-document-corrupt");
    return {schema:"fde.workbench-case/v1",caseId,version:Number(row.version),document,createdAt:String(row.created_at),updatedAt:String(row.updated_at),authority:"application-record-only",sourceWriteAllowed:false};
  }
  list(query="",offset=0):readonly Record<string,unknown>[]{
    if(query.length>160)throw new ReviewError(400,"workbench-query-budget");
    if(!Number.isSafeInteger(offset)||offset<0)throw new ReviewError(400,"invalid-workbench-list-offset");
    return this.db.prepare("SELECT case_id AS caseId,version,title,kind,phase,created_at AS createdAt,updated_at AS updatedAt FROM workbench_cases WHERE instr(lower(title),lower(?))>0 ORDER BY updated_at DESC,case_id LIMIT 100 OFFSET ?").all(query,offset);
  }
  listPage(query="",offset=0):Record<string,unknown>{
    const cases=this.list(query,offset),total=Number((this.db.prepare("SELECT COUNT(*) AS n FROM workbench_cases WHERE instr(lower(title),lower(?))>0").get(query) as Row).n);
    const hasMore=offset+cases.length<total;return {cases,total,offset,limit:100,hasMore,nextOffset:hasMore?offset+cases.length:null};
  }
  create(principal:Principal,actionId:string,raw:unknown):{duplicate:boolean;case:WorkbenchCase}{
    canEdit(principal);parseActionId(actionId);const document=parseWorkbenchDocument(raw),request={actionId,document};
    const digest=this.actionDigest(principal,"create",request);
    return this.transaction(()=>{
      const prior=this.prior(actionId,digest);if(prior)return {duplicate:true,case:this.get(String(prior.case_id))};
      this.db.prepare("INSERT OR IGNORE INTO workbench_semantic_context VALUES (1,'null')").run();
      const caseId="case-"+randomUUID(),at=this.time(),body=packed(document),docDigest=workbenchDigest(document);
      this.db.prepare("INSERT INTO workbench_cases VALUES (?,0,?,?,?,?,?,?,?)").run(caseId,document.title,document.investigation.kind,document.investigation.phase,at,at,body,docDigest);
      this.db.prepare("INSERT INTO workbench_revisions VALUES (?,0,?,?,?,?,?)").run(caseId,principal.id,principal.role,at,body,docDigest);
      this.recordAction(actionId,"create",caseId,digest,caseId);return {duplicate:false,case:this.get(caseId)};
    });
  }
  update(principal:Principal,action:CaseAction,raw:unknown):{duplicate:boolean;case:WorkbenchCase}{
    canEdit(principal);validAction(action);const document=parseWorkbenchDocument(raw),digest=this.actionDigest(principal,"update",{...action,document});
    return this.transaction(()=>{
      const prior=this.prior(action.actionId,digest);if(prior)return {duplicate:true,case:this.get(String(prior.case_id))};
      const before=this.get(action.caseId);if(before.version!==action.expectedVersion)throw new ReviewError(409,"workbench-version-conflict");
      const version=before.version+1,at=this.time(),body=packed(document),docDigest=workbenchDigest(document);
      const result=this.db.prepare("UPDATE workbench_cases SET version=?,title=?,kind=?,phase=?,updated_at=?,document=?,digest=? WHERE case_id=? AND version=?").run(version,document.title,document.investigation.kind,document.investigation.phase,at,body,docDigest,action.caseId,action.expectedVersion);
      if(Number(result.changes)!==1)throw new ReviewError(409,"workbench-version-conflict");
      this.db.prepare("INSERT INTO workbench_revisions VALUES (?,?,?,?,?,?,?)").run(action.caseId,version,principal.id,principal.role,at,body,docDigest);
      this.recordAction(action.actionId,"update",action.caseId,digest,action.caseId);return {duplicate:false,case:this.get(action.caseId)};
    });
  }
  evaluationRetry(principal:Principal,action:CaseAction):WorkbenchEvaluation|undefined{
    canEdit(principal);validAction(action);const prior=this.prior(action.actionId,this.actionDigest(principal,"evaluate",action));
    return prior?this.evaluation(String(prior.result_id)):undefined;
  }
  recordEvaluation(principal:Principal,action:CaseAction,input:unknown,result:unknown,kernelSha256:string):{duplicate:boolean;evaluation:WorkbenchEvaluation}{
    canEdit(principal);validAction(action);if(!/^[a-f0-9]{64}$/.test(kernelSha256))throw new ReviewError(503,"workbench-kernel-identity-required");
    const digest=this.actionDigest(principal,"evaluate",action),inputBody=packed(input),resultBody=packedIndustrialResult(result);
    return this.transaction(()=>{
      const prior=this.prior(action.actionId,digest);if(prior)return {duplicate:true,evaluation:this.evaluation(String(prior.result_id))};
      const current=this.get(action.caseId);
      if(current.version!==action.expectedVersion||canonical(workbenchAssessmentRequest(current.document))!==canonical(input))throw new ReviewError(409,"workbench-version-conflict");
      const id="eval-"+randomUUID(),at=this.time();
      const pin={caseId:action.caseId,caseVersion:current.version,input,result,kernelSha256,createdAt:at,actor:principal.id};
      this.db.prepare("INSERT INTO workbench_evaluations VALUES (?,?,?,?,?,?,?,?,?)").run(id,action.caseId,current.version,inputBody,resultBody,kernelSha256,at,principal.id,workbenchDigest(pin));
      this.recordAction(action.actionId,"evaluate",action.caseId,digest,id);return {duplicate:false,evaluation:this.evaluation(id)};
    });
  }
  evaluation(id:string):WorkbenchEvaluation{
    if(!/^eval-[a-f0-9-]{36}$/.test(id))throw new ReviewError(400,"invalid-workbench-evaluation-id");
    const row=this.db.prepare("SELECT * FROM workbench_evaluations WHERE evaluation_id=?").get(id) as Row|undefined;
    if(!row)throw new ReviewError(404,"workbench-evaluation-not-found");
    const pin={caseId:String(row.case_id),caseVersion:Number(row.case_version),input:parseStrictJson(String(row.input)),result:parseIndustrialResponseJson(String(row.result)),kernelSha256:String(row.kernel_sha256),createdAt:String(row.created_at),actor:String(row.actor)};
    if(workbenchDigest(pin)!==row.digest)throw new ReviewError(503,"workbench-evaluation-corrupt");
    return {schema:"fde.workbench-evaluation/v1",evaluationId:id,...pin,authority:"non-authoritative-diagnostic",sourceWriteAllowed:false};
  }
  evaluations(caseId:string):readonly WorkbenchEvaluation[]{
    this.get(caseId);return this.db.prepare("SELECT evaluation_id FROM workbench_evaluations WHERE case_id=? ORDER BY rowid DESC LIMIT 128").all(caseId).reverse().map(row=>this.evaluation(String(row.evaluation_id)));
  }
  history(caseId:string,afterVersion=-1):{revisions:readonly Record<string,unknown>[];hasMore:boolean;nextAfterVersion:number|null}{
    this.get(caseId);if(!Number.isSafeInteger(afterVersion)||afterVersion< -1)throw new ReviewError(400,"invalid-history-cursor");
    const rows=this.db.prepare("SELECT version,actor,actor_role,created_at,document,digest FROM workbench_revisions WHERE case_id=? AND version>? ORDER BY version LIMIT 21").all(caseId,afterVersion) as Row[];
    const revisions=rows.slice(0,20).map(row=>{const document=parseWorkbenchDocument(parseStrictJson(String(row.document)));if(workbenchDigest(document)!==row.digest)throw new ReviewError(503,"workbench-history-corrupt");return {version:Number(row.version),actor:row.actor,actorRole:row.actor_role,createdAt:row.created_at,document};});
    return {revisions,hasMore:rows.length>20,nextAfterVersion:rows.length>20?Number(revisions.at(-1)!.version):null};
  }
  importRetry(principal:Principal,action:CaseAction,sourceId:string,observationId:string):PinnedW1Import|undefined{
    canEdit(principal);validAction(action);const prior=this.prior(action.actionId,this.actionDigest(principal,"import-w1",{...action,sourceId,observationId}));
    return prior?this.imported(String(prior.result_id)):undefined;
  }
  recordImport(principal:Principal,action:CaseAction,sourceId:string,observationId:string,receipt:unknown):{duplicate:boolean;import:PinnedW1Import}{
    canEdit(principal);validAction(action);
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(sourceId)||!/^obs-[a-f0-9]{64}$/.test(observationId))throw new ReviewError(400,"invalid-w1-import-reference");
    const digest=this.actionDigest(principal,"import-w1",{...action,sourceId,observationId}),body=packed(receipt);
    return this.transaction(()=>{
      const prior=this.prior(action.actionId,digest);if(prior)return {duplicate:true,import:this.imported(String(prior.result_id))};
      const current=this.get(action.caseId);if(current.version!==action.expectedVersion)throw new ReviewError(409,"workbench-version-conflict");
      const id="import-"+randomUUID(),at=this.time(),pin={caseId:action.caseId,caseVersion:current.version,sourceId,observationId,receipt,createdAt:at,actor:principal.id};
      this.db.prepare("INSERT INTO workbench_w1_imports VALUES (?,?,?,?,?,?,?,?,?)").run(id,action.caseId,current.version,sourceId,observationId,body,at,principal.id,workbenchDigest(pin));
      this.recordAction(action.actionId,"import-w1",action.caseId,digest,id);return {duplicate:false,import:this.imported(id)};
    });
  }
  imported(id:string):PinnedW1Import{
    if(!/^import-[a-f0-9-]{36}$/.test(id))throw new ReviewError(400,"invalid-workbench-import-id");
    const row=this.db.prepare("SELECT * FROM workbench_w1_imports WHERE import_id=?").get(id) as Row|undefined;
    if(!row)throw new ReviewError(404,"workbench-import-not-found");
    const pin={caseId:String(row.case_id),caseVersion:Number(row.case_version),sourceId:String(row.source_id),observationId:String(row.observation_id),receipt:parseStrictJson(String(row.receipt)),createdAt:String(row.created_at),actor:String(row.actor)};
    if(workbenchDigest(pin)!==row.digest)throw new ReviewError(503,"workbench-import-corrupt");
    return {schema:"fde.workbench-w1-import/v1",importId:id,...pin,origin:"host-pinned-w1",sourceWriteAllowed:false};
  }
  imports(caseId:string):readonly PinnedW1Import[]{this.get(caseId);return this.db.prepare("SELECT import_id FROM workbench_w1_imports WHERE case_id=? ORDER BY rowid DESC LIMIT 128").all(caseId).reverse().map(row=>this.imported(String(row.import_id)));}
  privateNote(principal:Principal,caseId:string):{caseId:string;version:number;note:string;updatedAt:string|null}{
    isOperator(principal);this.get(caseId);const row=this.db.prepare("SELECT * FROM workbench_private_notes WHERE case_id=?").get(caseId) as Row|undefined;
    if(!row)return {caseId,version:0,note:"",updatedAt:null};
    if(workbenchDigest({note:row.note,version:Number(row.version)})!==row.digest)throw new ReviewError(503,"workbench-private-note-corrupt");
    return {caseId,version:Number(row.version),note:String(row.note),updatedAt:String(row.updated_at)};
  }
  savePrivateNote(principal:Principal,action:CaseAction,rawNote:unknown):{duplicate:boolean;privateNote:ReturnType<WorkbenchStore["privateNote"]>}{
    isOperator(principal);validAction(action);const note=parsePrivateNote(rawNote),digest=this.actionDigest(principal,"private-note",{...action,note});
    return this.transaction(()=>{
      const prior=this.db.prepare("SELECT request_digest FROM workbench_private_actions WHERE action_id=?").get(action.actionId) as Row|undefined;
      if(prior){if(prior.request_digest!==digest)throw new ReviewError(409,"idempotency-key-reused");return {duplicate:true,privateNote:this.privateNote(principal,action.caseId)};}
      const before=this.privateNote(principal,action.caseId);if(before.version!==action.expectedVersion)throw new ReviewError(409,"workbench-private-note-version-conflict");
      const version=before.version+1,at=this.time();
      this.db.prepare("INSERT INTO workbench_private_notes VALUES (?,?,?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET version=excluded.version,note=excluded.note,updated_at=excluded.updated_at,actor=excluded.actor,digest=excluded.digest").run(action.caseId,version,note,at,principal.id,workbenchDigest({note,version}));
      this.db.prepare("INSERT INTO workbench_private_actions VALUES (?,?,?)").run(action.actionId,action.caseId,digest);
      return {duplicate:false,privateNote:this.privateNote(principal,action.caseId)};
    });
  }
  handoff(caseId:string):Record<string,unknown>{
    const current=this.get(caseId),history=this.history(caseId),evaluations=this.evaluations(caseId),imports=this.imports(caseId);
    const counts=this.db.prepare("SELECT (SELECT COUNT(*) FROM workbench_evaluations WHERE case_id=?) AS evaluations,(SELECT COUNT(*) FROM workbench_w1_imports WHERE case_id=?) AS imports").get(caseId,caseId) as Row;
    const context=this.db.prepare("SELECT binding FROM workbench_semantic_context WHERE id=1").get() as Row;
    return {schema:"fde.workbench-handoff/v1",case:current,history,evaluations,imports,semanticPackage:parseStrictJson(String(context.binding)),evaluationTotal:Number(counts.evaluations),importTotal:Number(counts.imports),
      evaluationsTruncated:Number(counts.evaluations)>evaluations.length,importsTruncated:Number(counts.imports)>imports.length,
      privateWorkerNotesIncluded:false,generatedAt:this.time(),authority:"application-records-and-diagnostics-only",sourceWriteAllowed:false,
      limitations:["Human entries and diagnostic results do not establish source truth, permission, physical acceptance, or delivered benefits.","Host-pinned W1 receipts are separate records; manual evidence cannot claim their provenance.","Follow history.nextAfterVersion to obtain additional historical revisions when history.hasMore is true."]};
  }
  /** A separate SQLite read transaction pins all exported records without blocking this store's WAL writers. */
  *handoffRecords(caseId:string):Generator<Record<string,unknown>>{
    parseCaseId(caseId);if(this.path===":memory:")throw new ReviewError(503,"workbench-export-requires-persistent-store");
    const snapshot=new WorkbenchStore(this.path,this.now,true);
    try{
      const current=snapshot.get(caseId),context=snapshot.db.prepare("SELECT binding FROM workbench_semantic_context WHERE id=1").get() as Row;
      const rawCounts=snapshot.db.prepare("SELECT (SELECT COUNT(*) FROM workbench_revisions WHERE case_id=?) AS revisions,(SELECT COUNT(*) FROM workbench_evaluations WHERE case_id=?) AS evaluations,(SELECT COUNT(*) FROM workbench_w1_imports WHERE case_id=?) AS imports").get(caseId,caseId,caseId) as Row;
      const counts={revisions:Number(rawCounts.revisions),evaluations:Number(rawCounts.evaluations),imports:Number(rawCounts.imports)};
      yield {schema:"fde.workbench-handoff-stream/v1",recordType:"manifest",caseId,caseVersion:current.version,generatedAt:this.time(),semanticPackage:parseStrictJson(String(context.binding)),counts,
        privateWorkerNotesIncluded:false,authority:"application-records-and-diagnostics-only",sourceWriteAllowed:false,
        limitations:["Input records and diagnostics do not establish source truth, physical acceptance, or delivered worker benefits.","Source import receipt content is withheld when the current reader lacks a valid grant.","A complete export ends with an end record and a digest of all preceding UTF-8 lines; hashes are not independent authenticity."]};
      yield {recordType:"case",case:current};
      for(const row of snapshot.db.prepare("SELECT version,actor,actor_role,created_at,document,digest FROM workbench_revisions WHERE case_id=? ORDER BY version").iterate(caseId)){
        const document=parseWorkbenchDocument(parseStrictJson(String(row.document)));if(workbenchDigest(document)!==row.digest)throw new ReviewError(503,"workbench-history-corrupt");
        yield {recordType:"revision",revision:{version:Number(row.version),actor:row.actor,actorRole:row.actor_role,createdAt:row.created_at,document}};
      }
      for(const row of snapshot.db.prepare("SELECT evaluation_id FROM workbench_evaluations WHERE case_id=? ORDER BY rowid").iterate(caseId))yield {recordType:"evaluation",evaluation:snapshot.evaluation(String(row.evaluation_id))};
      for(const row of snapshot.db.prepare("SELECT import_id FROM workbench_w1_imports WHERE case_id=? ORDER BY rowid").iterate(caseId))yield {recordType:"import",import:snapshot.imported(String(row.import_id))};
      yield {recordType:"end",caseId,caseVersion:current.version,complete:true,counts};
    }finally{snapshot.close();}
  }
  async backup(destination:string):Promise<void>{
    const parent=dirname(resolve(destination));mkdirSync(parent,{recursive:true,mode:0o700});
    const st=lstatSync(parent);if(st.isSymbolicLink()||realpathSync(parent)!==parent||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid())||existsSync(destination))throw new ReviewError(409,"workbench-backup-destination-refused");
    const fd=openSync(destination,"wx",0o600);closeSync(fd);await backup(this.db,destination);chmodSync(destination,0o600);
  }
}
