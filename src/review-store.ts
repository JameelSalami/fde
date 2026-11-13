/** Durable, finite application workflow. SQL stores human review; Haskell owns meaning.
 * Local owner custody is the authenticity boundary; hashes detect corruption only.
 */
import {DatabaseSync,backup} from "node:sqlite";
import {chmodSync,existsSync,lstatSync,mkdirSync,openSync,closeSync,realpathSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {randomUUID} from "node:crypto";
import {fingerprint} from "./model.js";
import {object,parseStrictJson} from "./json.js";
import {replayObservation,type StoredObservation} from "./admission.js";
import type {Principal} from "./web/auth.js";
import {canonical,type CompanyBinding} from "./company-package.js";

export class ReviewError extends Error {
  constructor(readonly status:number,readonly code:string){super(code);}
}
export interface ReviewAction {
  readonly actionId:string;readonly observationId:string;readonly expectedVersion:number;
  readonly assignee:string|null;readonly disposition:"open"|"needs-investigation"|"reviewed";
  readonly note:string;
}
export interface ReviewState {
  readonly schema:"fde.review-state/v1";readonly caseId:string;readonly observationId:string;
  readonly version:number;readonly assignee:string|null;readonly disposition:string;
  readonly currentness:"latest-observed"|"same-source-case"|"superseded"|"stale"|"unresolved-tie";
  readonly latestObservationId:string;readonly headTieCount:number;readonly observationAgeMs:number;
  readonly audit:readonly Record<string,unknown>[];readonly auditTotal:number;readonly auditTruncated:boolean;
  readonly authority:"human-review-only";readonly sourceWriteAllowed:false;
}
type Row=Record<string,string|number|bigint|Uint8Array|null>;
export function parseReviewAction(raw:unknown):ReviewAction{
  const a=object(raw,["actionId","observationId","expectedVersion","assignee","disposition","note"],"review action");
  if(typeof a.actionId!=="string"||!/^[a-f0-9-]{36}$/.test(a.actionId)||
     typeof a.observationId!=="string"||!/^obs-[a-f0-9]{64}$/.test(a.observationId)||
     !Number.isSafeInteger(a.expectedVersion)||Number(a.expectedVersion)<0||
     !(a.assignee===null||typeof a.assignee==="string"&&/^[a-z][a-z0-9_-]{0,47}$/.test(a.assignee))||
     !["open","needs-investigation","reviewed"].includes(a.disposition as string)||
     typeof a.note!=="string"||a.note.length>2000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(a.note))
    throw new ReviewError(400,"invalid-review-action");
  return a as unknown as ReviewAction;
}
function workflowKey(s:StoredObservation):string{
  return "workflow-"+fingerprint({erp:{instance:s.view.sources.erp.instance,nativeId:s.view.sources.erp.nativeId},
    mes:{instance:s.view.sources.mes.instance,nativeId:s.view.sources.mes.nativeId},mappingId:s.admission.context.mappingId});
}

export interface InvestigationRequestView {
  readonly schema:"fde.investigation-request/v1";
  readonly authority:"none";
  readonly sourceWriteAllowed:false;
  readonly requestId:string;
  readonly observationId:string;
  readonly state:"pending"|"completed"|"failed";
  readonly draftId:string|null;
  readonly draft:unknown|null;
  readonly startedAt:string;
  readonly completedAt:string|null;
  readonly execution:"unknown"|"observed";
  readonly qualification:"human-review-required";
  readonly next:string;
}
const investigationId=(value:string):void=>{
  if(typeof value!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new ReviewError(400,"investigation-request-id-required");
};

export class ReviewStore {
  private readonly db:DatabaseSync;
  constructor(readonly path:string,private readonly now:()=>number=Date.now,
    private readonly verify:(s:StoredObservation)=>void=replayObservation){
    if(path!==":memory:"){
      const parent=dirname(resolve(path));mkdirSync(parent,{recursive:true,mode:0o700});
      const ps=lstatSync(parent);
      if(ps.isSymbolicLink()||realpathSync(parent)!==parent||(ps.mode&0o077)!==0||
         (process.getuid&&ps.uid!==process.getuid()))throw Error("review-directory-custody-refused");
      if(!existsSync(path)){const fd=openSync(path,"wx",0o600);closeSync(fd);}
      const st=lstatSync(path);
      if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||
         (process.getuid&&st.uid!==process.getuid()))throw Error("review-store-custody-refused");
    }
    this.db=new DatabaseSync(path,{enableForeignKeyConstraints:true,allowExtension:false});
    this.db.exec("PRAGMA busy_timeout=2000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const schema=this.db.prepare("PRAGMA user_version").get() as Row;
    if(Number(schema.user_version)>2)throw Error("review-schema-incompatible");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,case_id TEXT NOT NULL,workflow_key TEXT NOT NULL,
        captured_at INTEGER NOT NULL,acquired_at INTEGER NOT NULL,body TEXT NOT NULL,digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS semantic_context (
        id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY,kernel_sha256 TEXT NOT NULL,source_revision TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS heads (
        workflow_key TEXT PRIMARY KEY,observation_id TEXT NOT NULL REFERENCES observations(id),case_id TEXT NOT NULL,captured_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS reviews (
        case_id TEXT PRIMARY KEY,version INTEGER NOT NULL,assignee TEXT,disposition TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS review_actions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,action_id TEXT NOT NULL UNIQUE,case_id TEXT NOT NULL,
        observation_id TEXT NOT NULL REFERENCES observations(id),actor TEXT NOT NULL,actor_role TEXT NOT NULL,
        version INTEGER NOT NULL,created_at TEXT NOT NULL,request_digest TEXT NOT NULL,request TEXT NOT NULL,response TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_attempts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,outcome TEXT NOT NULL,release_id TEXT NOT NULL,duration_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS investigation_drafts (
        id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,observation_id TEXT NOT NULL REFERENCES observations(id),
        outcome TEXT NOT NULL,payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS investigation_requests (
        request_id TEXT PRIMARY KEY,actor TEXT NOT NULL,observation_id TEXT NOT NULL REFERENCES observations(id),
        request_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','completed','failed')),
        draft_id TEXT, result_json TEXT, started_at TEXT NOT NULL, completed_at TEXT
      ) STRICT;
    `);
    if(Number(schema.user_version)===0)this.db.exec("PRAGMA user_version=1;");
    // Existing v1 observations are the bundled W1 scope. Company activation must
    // use new state; it cannot inherit a previous package's human disposition.
    if(Number((this.db.prepare("SELECT COUNT(*) AS n FROM observations").get() as Row).n)>0)
      this.db.prepare("INSERT OR IGNORE INTO semantic_context VALUES (1,'null')").run();
  }
  close():void{this.db.close();}
  bindSemanticPackage(binding:CompanyBinding|undefined):void{
    const encoded=canonical(binding??null);
    const check=(row:Row)=>{if(row.binding!==encoded)throw new ReviewError(503,"company-state-binding-refused");};
    const prior=this.db.prepare("SELECT binding FROM semantic_context WHERE id=1").get() as Row|undefined;
    if(prior){check(prior);return;}
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const locked=this.db.prepare("SELECT binding FROM semantic_context WHERE id=1").get() as Row|undefined;
      if(locked)check(locked);
      else this.db.prepare("INSERT INTO semantic_context VALUES (1,?)").run(encoded);
      // A pre-company executable must refuse these databases, not ignore approval identity.
      if(binding)this.db.exec("PRAGMA user_version=2;");
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  registerRelease(release:{releaseId:string;kernelSha256:string;sourceRevision:string}):void{
    if(!/^fde-[a-f0-9]{16}$/.test(release.releaseId)||!/^[a-f0-9]{64}$/.test(release.kernelSha256)||!/^[a-f0-9]{40}$/.test(release.sourceRevision))throw Error("release-registration-refused");
    const prior=this.db.prepare("SELECT kernel_sha256,source_revision FROM releases WHERE id=?").get(release.releaseId) as Row|undefined;
    if(prior&&(prior.kernel_sha256!==release.kernelSha256||prior.source_revision!==release.sourceRevision))throw Error("release-registration-collision");
    this.db.prepare("INSERT OR IGNORE INTO releases VALUES (?,?,?)").run(release.releaseId,release.kernelSha256,release.sourceRevision);
  }
  private verifyRelease(stored:StoredObservation):void{
    const release=this.db.prepare("SELECT kernel_sha256 FROM releases WHERE id=?").get(stored.releaseId) as Row|undefined;
    if(!release||release.kernel_sha256!==stored.kernelSha256)throw new ReviewError(503,"unregistered-pinned-release");
  }
  ready():boolean{return (this.db.prepare("PRAGMA quick_check").get() as Row).quick_check==="ok";}
  counts():Record<string,number>{
    return Object.fromEntries(["observations","reviews","review_actions","source_attempts"].map(table=>
      [table,Number((this.db.prepare("SELECT COUNT(*) AS n FROM "+table).get() as Row).n)]));
  }
  recordAttempt(outcome:"ok"|"unavailable"|"invalid"|"timeout",releaseId:string,durationMs:number):void{
    this.db.prepare("INSERT INTO source_attempts(at,outcome,release_id,duration_ms) VALUES (?,?,?,?)")
      .run(new Date(this.now()).toISOString(),outcome,releaseId,Math.max(0,Math.round(durationMs)));
  }
  sourceStatus():Record<string,unknown>{
    const latest=this.db.prepare("SELECT at,outcome,release_id,duration_ms FROM source_attempts ORDER BY seq DESC LIMIT 1").get();
    return {schema:"fde.source-status/v1",latest:latest??null,
      currentness:"last-observed-only",distributedAtomicSnapshot:false};
  }
  recordDraft(actor:string,observationId:string,outcome:"ok"|"failed",payload:unknown):string{
    const id="draft-"+randomUUID();
    this.db.prepare("INSERT INTO investigation_drafts VALUES (?,?,?,?,?,?)")
      .run(id,new Date(this.now()).toISOString(),actor,observationId,outcome,JSON.stringify(payload));
    return id;
  }
  /** A durable, one-use reservation; duplicated requests never call the model. */
  beginInvestigation(actor:string,requestId:string,observationId:string):{started:boolean;view:InvestigationRequestView}{
    investigationId(requestId);
    if(!/^obs-[a-f0-9]{64}$/.test(observationId))throw new ReviewError(400,"invalid-investigation-observation");
    this.get(observationId);
    const requestDigest=fingerprint({action:"draft-investigation",actor,observationId});
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const prior=this.db.prepare("SELECT * FROM investigation_requests WHERE request_id=?").get(requestId) as Row|undefined;
      if(prior){
        if(prior.actor!==actor||prior.observation_id!==observationId||prior.request_digest!==requestDigest)
          throw new ReviewError(409,"idempotency-key-reused");
        this.db.exec("COMMIT");
        return {started:false,view:this.investigationStatus(actor,requestId)};
      }
      this.db.prepare("INSERT INTO investigation_requests VALUES (?,?,?,?,'pending',NULL,NULL,?,NULL)").run(
        requestId,actor,observationId,requestDigest,new Date(this.now()).toISOString());
      this.db.exec("COMMIT");
      return {started:true,view:this.investigationStatus(actor,requestId)};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  investigationStatus(actor:string,requestId:string):InvestigationRequestView{
    investigationId(requestId);
    const r=this.db.prepare("SELECT * FROM investigation_requests WHERE request_id=?").get(requestId) as Row|undefined;
    if(!r||r.actor!==actor)throw new ReviewError(404,"investigation-request-not-found");
    if(!["pending","completed","failed"].includes(String(r.state)))throw new ReviewError(503,"investigation-state-corrupt");
    const state=String(r.state) as InvestigationRequestView["state"];
    const original=r.result_json===null?null:parseStrictJson(String(r.result_json));
    return {schema:"fde.investigation-request/v1",authority:"none",sourceWriteAllowed:false,
      requestId,observationId:String(r.observation_id),state,
      draftId:r.draft_id===null?null:String(r.draft_id),
      draft:state==="completed"?original:null,startedAt:String(r.started_at),
      completedAt:r.completed_at===null?null:String(r.completed_at),
      execution:state==="pending"?"unknown":"observed",qualification:"human-review-required",
      next:state==="pending"?"Outcome unknown or in progress; inspect status, never re-dispatch this request.":
        state==="failed"?"Attempt ended without a qualified draft; a fresh request requires a new ID.":
        "Read the original pinned candidate; a draft is not human review or vendor action."};
  }
  finishInvestigation(actor:string,requestId:string,observationId:string,
    outcome:"completed"|"failed",draft:unknown=null):InvestigationRequestView{
    investigationId(requestId);
    if(outcome==="completed"&&(!draft||typeof draft!=="object"||(draft as Record<string,unknown>).schema!=="fde.investigation-draft/v1"||
      (draft as Record<string,unknown>).observationId!==observationId||
      (draft as Record<string,unknown>).authority!=="none"||
      (draft as Record<string,unknown>).sourceWriteAllowed!==false||
      (draft as Record<string,unknown>).humanReviewRequired!==true))
      throw new ReviewError(422,"investigation-draft-refused");
    const encoded=outcome==="completed"?JSON.stringify(draft):JSON.stringify({code:"model-draft-refused"});
    if(Buffer.byteLength(encoded)>131072)throw new ReviewError(413,"investigation-result-budget");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const prior=this.db.prepare("SELECT * FROM investigation_requests WHERE request_id=?").get(requestId) as Row|undefined;
      if(!prior||prior.actor!==actor||prior.observation_id!==observationId)
        throw new ReviewError(403,"investigation-owner-refused");
      if(prior.state!=="pending"){
        this.db.exec("COMMIT");
        return this.investigationStatus(actor,requestId);
      }
      const draftId="draft-"+randomUUID(),at=new Date(this.now()).toISOString();
      this.db.prepare("INSERT INTO investigation_drafts VALUES (?,?,?,?,?,?)").run(
        draftId,at,actor,observationId,outcome==="completed"?"ok":"failed",encoded);
      this.db.prepare("UPDATE investigation_requests SET state=?,draft_id=?,result_json=?,completed_at=? WHERE request_id=? AND state='pending'").run(
        outcome,draftId,encoded,at,requestId);
      this.db.exec("COMMIT");
      return this.investigationStatus(actor,requestId);
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  put(stored:StoredObservation):void{
    this.verifyRelease(stored);
    this.verify(stored);
    this.bindSemanticPackage(stored.semanticPackage);
    const times=[Date.parse(stored.view.sources.erp.capture.observedAt),Date.parse(stored.view.sources.mes.capture.observedAt)];
    const time=Math.min(...times);
    const acquiredAt=Date.parse(stored.acquiredAt);
    if(times.some(t=>!Number.isFinite(t)||t>this.now()+5000)||!Number.isFinite(acquiredAt)||acquiredAt>this.now()+5000)
      throw new ReviewError(422,"invalid-capture-time");
    const body=JSON.stringify(stored),digest=fingerprint(stored),key=workflowKey(stored),id=stored.view.observationId;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const existing=this.db.prepare("SELECT digest FROM observations WHERE id=?").get(id) as Row|undefined;
      if(existing&&existing.digest!==digest)throw new ReviewError(409,"observation-identity-collision");
      if(!existing)this.db.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?)")
        .run(id,stored.view.caseId,key,time,acquiredAt,body,digest);
      this.db.prepare("INSERT OR IGNORE INTO reviews VALUES (?,0,NULL,'open')").run(stored.view.caseId);
      this.db.prepare(`INSERT INTO heads VALUES (?,?,?,?) ON CONFLICT(workflow_key) DO UPDATE SET
        observation_id=excluded.observation_id,case_id=excluded.case_id,captured_at=excluded.captured_at
        WHERE excluded.captured_at>heads.captured_at`).run(key,id,stored.view.caseId,time);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  get(id:string):StoredObservation{
    const row=this.db.prepare("SELECT body,digest FROM observations WHERE id=?").get(id) as Row|undefined;
    if(!row)throw new ReviewError(404,"observation-not-found");
    const stored=parseStrictJson(String(row.body)) as unknown as StoredObservation;
    if(fingerprint(stored)!==row.digest)throw new ReviewError(503,"stored-evidence-corrupt");
    if(stored.view?.observationId!==id)throw new ReviewError(503,"stored-observation-id-mismatch");
    this.verifyRelease(stored);
    this.bindSemanticPackage(stored.semanticPackage);
    this.verify(stored);
    return stored;
  }
  list():readonly Record<string,unknown>[] {
    return this.db.prepare(`SELECT o.id AS observationId,o.case_id AS caseId,o.captured_at AS capturedAt,
      r.version,r.assignee,r.disposition,
        (h.case_id=o.case_id AND NOT EXISTS (SELECT 1 FROM observations tie
          WHERE tie.workflow_key=h.workflow_key AND tie.captured_at=h.captured_at
            AND tie.id<>h.observation_id)) AS latestCase,
        CASE WHEN EXISTS (SELECT 1 FROM observations tie
          WHERE tie.workflow_key=h.workflow_key AND tie.captured_at=h.captured_at
            AND tie.id<>h.observation_id)
          THEN 'unresolved-tie' ELSE 'ordered-by-capture' END AS sourceHeadStatus
      FROM observations o JOIN reviews r ON r.case_id=o.case_id JOIN heads h ON h.workflow_key=o.workflow_key
      ORDER BY o.acquired_at DESC LIMIT 100`).all();
  }
  review(id:string):ReviewState{
    const stored=this.get(id),head=this.db.prepare("SELECT * FROM heads WHERE workflow_key=?").get(workflowKey(stored)) as Row;
    const row=this.db.prepare("SELECT * FROM reviews WHERE case_id=?").get(stored.view.caseId) as Row;
    const capturedAt=Math.min(Date.parse(stored.view.sources.erp.capture.observedAt),Date.parse(stored.view.sources.mes.capture.observedAt));
    const age=Math.max(0,this.now()-capturedAt);
    const headTieCount=Number((this.db.prepare(
      "SELECT COUNT(*) AS n FROM observations WHERE workflow_key=? AND captured_at=?"
    ).get(workflowKey(stored),Number(head.captured_at)) as Row).n);
    const currentness=headTieCount>1?"unresolved-tie":
      head.case_id!==stored.view.caseId?"superseded":age>300000?"stale":
      head.observation_id===id?"latest-observed":"same-source-case";
    const auditTotal=Number((this.db.prepare("SELECT COUNT(*) AS n FROM review_actions WHERE case_id=?").get(stored.view.caseId) as Row).n);
    const audit=this.db.prepare(`SELECT seq,action_id AS actionId,observation_id AS observationId,actor,actor_role AS actorRole,
      version,created_at AS createdAt,request FROM review_actions WHERE case_id=? ORDER BY seq DESC LIMIT 100`).all(stored.view.caseId).reverse()
      .map(row=>({...row,request:parseStrictJson(String(row.request))}));
    return {schema:"fde.review-state/v1",caseId:stored.view.caseId,observationId:id,
      version:Number(row.version),assignee:row.assignee as string|null,disposition:String(row.disposition),
      currentness,latestObservationId:String(head.observation_id),headTieCount,observationAgeMs:age,audit,auditTotal,auditTruncated:auditTotal>audit.length,
      authority:"human-review-only",sourceWriteAllowed:false};
  }
  act(principal:Principal,action:ReviewAction,allowedAssignees:ReadonlySet<string>):{duplicate:boolean;review:ReviewState}{
    if(principal.role!=="reviewer"&&principal.role!=="operator")throw new ReviewError(403,"reviewer-role-required");
    if(action.assignee!==null&&!allowedAssignees.has(action.assignee))throw new ReviewError(400,"unknown-review-assignee");
    const digest=fingerprint({actor:principal.id,role:principal.role,action});
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const prior=this.db.prepare("SELECT request_digest,response FROM review_actions WHERE action_id=?").get(action.actionId) as Row|undefined;
      if(prior){
        if(prior.request_digest!==digest)throw new ReviewError(409,"idempotency-key-reused");
        // Idempotency confirms the old action; currentness is observed again.
        const review=this.review(action.observationId);
        this.db.exec("COMMIT");return {duplicate:true,review};
      }
      const before=this.review(action.observationId);
      if(before.currentness!=="latest-observed"&&before.currentness!=="same-source-case")throw new ReviewError(409,"observation-no-longer-current");
      if(before.version!==action.expectedVersion)throw new ReviewError(409,"review-version-conflict");
      if(action.disposition!=="open"&&!action.note.trim())throw new ReviewError(400,"disposition-note-required");
      const version=before.version+1;
      const changed=this.db.prepare("UPDATE reviews SET version=?,assignee=?,disposition=? WHERE case_id=? AND version=?")
        .run(version,action.assignee,action.disposition,before.caseId,before.version);
      if(Number(changed.changes)!==1)throw new ReviewError(409,"review-version-conflict");
      // Audit insertion and state update are one local transaction. No vendor transaction occurs.
      this.db.prepare(`INSERT INTO review_actions(action_id,case_id,observation_id,actor,actor_role,version,created_at,request_digest,request,response)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(action.actionId,before.caseId,action.observationId,principal.id,principal.role,
        version,new Date(this.now()).toISOString(),digest,JSON.stringify(action),"{}");
      const review=this.review(action.observationId);
      this.db.prepare("UPDATE review_actions SET response=? WHERE action_id=?").run(JSON.stringify(review),action.actionId);
      this.db.exec("COMMIT");return {duplicate:false,review};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  async backupTo(destination:string):Promise<void>{
    if(destination===this.path||existsSync(destination))throw Error("backup-destination-exists");
    const p=dirname(resolve(destination));mkdirSync(p,{recursive:true,mode:0o700});
    const st=lstatSync(p);
    if(st.isSymbolicLink()||realpathSync(p)!==p||(st.mode&0o077)!==0||
       (process.getuid&&st.uid!==process.getuid()))throw Error("backup-custody-refused");
    await backup(this.db,destination);chmodSync(destination,0o600);
    const restored=new DatabaseSync(destination,{readOnly:true});
    try{if((restored.prepare("PRAGMA integrity_check").get() as Row).integrity_check!=="ok")throw Error("backup-integrity-refused");}
    finally{restored.close();}
  }
}
