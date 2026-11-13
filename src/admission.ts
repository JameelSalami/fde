/** Host custody boundary for the finite W1 Haskell admission/replay protocol.
 * No HTTP body can supply a source receipt, mapping policy or admission request.
 */
import {randomUUID} from "node:crypto";
import {bundledSemanticRuntime,type SemanticRuntime} from "./semantic-runtime.js";
import type {CompanyBinding} from "./company-package.js";
import {admitCase,type ReviewCase,fingerprint,stableCase} from "./model.js";
import {object,parseStrictJson} from "./json.js";
import {verifyCompilerResponse,type CompiledDiagnostic} from "./compiler.js";
import {buildConnectedCase,type WorkspaceCase} from "./workspace.js";

export interface AdmissionRequest {
  readonly schema:"fde.w1-admission-request/v1";
  readonly context:Readonly<Record<string,string>>;
  readonly input:ReviewCase;
  readonly receipts:readonly Readonly<Record<string,string>>[];
  readonly members:readonly Readonly<Record<string,string>>[];
}
export interface AdmittedReview {
  readonly schema:"fde.w1-admitted-review/v1";
  readonly context:AdmissionRequest["context"];
  readonly input:ReviewCase;
  readonly receipts:AdmissionRequest["receipts"];
  readonly members:AdmissionRequest["members"];
  readonly grade:"authenticated-lab-review"|"fixture-demonstration";
  readonly authority:"none";
  readonly businessTruthSelected:false;
  readonly atomicSnapshot:false;
  readonly postingPermitted:false;
  readonly physicalProductionCertified:false;
  readonly decision:CompiledDiagnostic;
}
export interface StoredObservation {
  readonly schema:"fde.stored-observation/v1";
  readonly view:WorkspaceCase;
  readonly admission:AdmissionRequest;
  readonly snapshot:AdmittedReview;
  readonly releaseId:string;
  readonly kernelSha256:string;
  readonly acquiredAt:string;
  readonly semanticPackage?:CompanyBinding;
}
export function kernelFingerprint(runtime:SemanticRuntime=bundledSemanticRuntime()):string{return runtime.fingerprint();}
function invoke(request:unknown,runtime:SemanticRuntime,requiredKernel?:string):unknown{
  if(requiredKernel!==undefined&&kernelFingerprint(runtime)!==requiredKernel)throw Error("pinned-kernel-unavailable");
  const input=JSON.stringify(request);
  if(Buffer.byteLength(input)>131072)throw Error("admission-input-budget");
  parseStrictJson(input);
  const r=runtime.invoke(input,262144);
  if(r.error||r.status!==0||!r.stdout||r.stderr.length)throw Error("admission-kernel-unavailable");
  const raw=parseStrictJson(r.stdout);
  if((raw as {ok?:unknown}).ok!==true)throw Error("admission-kernel-refused");
  return object(raw,["ok","result"],"admission reply").result;
}
function same(a:unknown,b:unknown):boolean{return fingerprint(a)===fingerprint(b);}
export function prepareAdmission(raw:ReviewCase,view:WorkspaceCase):AdmissionRequest{
  const input=admitCase(raw),candidateSetId="cset-"+randomUUID();
  if(view.observationId!=="obs-"+fingerprint(input)||view.caseId!=="case-"+fingerprint(stableCase(input)))
    throw Error("admission-view-binding-refused");
  const receipts=(["erp","mes"] as const).map(role=>{
    const s=input[role];
    return {receiptId:"receipt-"+randomUUID(),role,sourceInstance:s.instance,
      sourceNativeId:s.nativeId,sourceRevision:s.revision,observedAt:s.capture.observedAt,
      querySha256:s.capture.querySha256,
      authentication:s.dataClass==="isolated-synthetic-native"?"tls13-read-only":"fixture"};
  });
  const members=([ ["erp","plan"],["erp","report"],["mes","plan"],["mes","report"] ] as const)
    .map(([role,kind])=>({candidateId:candidateSetId+"/"+role+"."+kind,role,kind,
      receiptId:receipts[role==="erp"?0:1]!.receiptId,sourceNativeId:input[role].nativeId,
      sourceRevision:input[role].revision,quantity:input[role][kind==="plan"?"planned":"reported"],
      unit:input[role].unit}));
  return {schema:"fde.w1-admission-request/v1",context:{caseId:view.caseId,candidateSetId,
    admissionId:"admission-"+randomUUID(),assessmentId:"assessment-"+randomUUID(),
    evaluationId:"evaluation-"+randomUUID(),policyId:"fde.w1.lab-review/v1",
    mappingId:"fde.w1.synthetic-pcs-Nos/v1",kernelContract:"fde.semantic-w1/v1"},input,receipts,members};
}
export function verifyAdmissionResponse(raw:unknown,request:AdmissionRequest):AdmittedReview{
  const r=object(raw,["schema","context","input","receipts","members","grade","authority",
    "businessTruthSelected","atomicSnapshot","postingPermitted","physicalProductionCertified","decision"],"admission result");
  if(r.schema!=="fde.w1-admitted-review/v1"||r.authority!=="none"||
     r.businessTruthSelected!==false||r.atomicSnapshot!==false||r.postingPermitted!==false||
     r.physicalProductionCertified!==false||
     !same(r.context,request.context)||!same(r.input,request.input)||
     !same(r.receipts,request.receipts)||!same(r.members,request.members)||
     r.grade!==(request.input.erp.dataClass==="isolated-synthetic-native"?"authenticated-lab-review":"fixture-demonstration"))
    throw Error("admission-receipt-refused");
  verifyCompilerResponse({ok:true,result:r.decision},request.input);
  return r as unknown as AdmittedReview;
}
export function admitForReview(request:AdmissionRequest,runtime:SemanticRuntime=bundledSemanticRuntime()):AdmittedReview{
  return verifyAdmissionResponse(invoke(request,runtime),request);
}
export function replayObservation(stored:StoredObservation,runtime:SemanticRuntime=bundledSemanticRuntime()):void{
  if(!runtime.matchesPackage(stored.semanticPackage))throw Error("pinned-company-package-unavailable");
  if(!/^fde-[a-f0-9]{16}$/.test(stored.releaseId)||!/^[a-f0-9]{64}$/.test(stored.kernelSha256)||
     kernelFingerprint(runtime)!==stored.kernelSha256)throw Error("pinned-kernel-unavailable");
  if(stored.schema!=="fde.stored-observation/v1"||
     stored.admission.context.caseId!==stored.view.caseId||
     stored.view.observationId!=="obs-"+fingerprint(stored.admission.input)||
     !same(stored.view,buildConnectedCase(stored.admission.input,runtime))||
     !same(stored.view.diagnostic,stored.snapshot.decision))throw Error("stored-observation-refused");
  verifyAdmissionResponse(stored.snapshot,stored.admission);
  const raw=invoke({schema:"fde.w1-replay-request/v1",admission:stored.admission,expected:stored.snapshot},runtime,stored.kernelSha256);
  const r=object(raw,["schema","matched","readsFreshSources","snapshot"],"replay result");
  if(r.schema!=="fde.w1-replay-result/v1"||r.matched!==true||r.readsFreshSources!==false||
     !same(r.snapshot,stored.snapshot))throw Error("pinned-replay-refused");
}
