/** Non-authoritative, source-linked W1 application projection.
 * The pure display adapter never computes semantic outcomes or vendor status.
 */
import {admitCase,fingerprint,stableCase,type NativeObservation} from "./model.js";
import {compileSemantic,type CompiledDiagnostic} from "./compiler.js";
import {bundledSemanticRuntime,type SemanticRuntime} from "./semantic-runtime.js";

interface SourceFacet {
  readonly vendor:string;
  readonly instance:string;
  readonly nativeId:string;
  readonly businessId:string;
  readonly revision:string;
  readonly nativeState:string;
  readonly planned:string;
  readonly reported:string;
  readonly unit:string;
  readonly capture:NativeObservation["capture"];
  readonly coverage:NativeObservation["coverage"];
}
interface EvidenceLink {
  readonly id:string;
  readonly claim:string;
  readonly compilerValue:string;
  readonly inputCandidates:readonly number[];
  readonly sourceNativeIds:readonly string[];
  readonly sourceRevisions:readonly string[];
  readonly sourceQueries:readonly string[];
  readonly interpretation:"compiled-diagnostic-not-cause";
}
export interface WorkspaceCase {
  readonly schema:"fde.connected-case/v1";
  readonly authority:"none";
  readonly observationId:string;
  readonly caseId:string;
  readonly dataClass:"handwritten-fixture"|"isolated-synthetic-native";
  readonly question:"What do ERPNext and OpenMES report about this order?";
  readonly observationScope:{
    readonly readPattern:"two-independent-source-transactions";
    readonly distributedAtomicSnapshot:false;
    readonly sourceWriteAllowed:false;
    readonly businessTruthAdmitted:false;
    readonly physicalProductionCertified:false;
  };
  readonly sources:{
    readonly erp:SourceFacet;
    readonly mes:SourceFacet;
  };
  readonly binding:{
    readonly grade:string;
    readonly unit:string;
    readonly erp:Readonly<{instance:string;nativeId:string}>;
    readonly mes:Readonly<{instance:string;nativeId:string}>;
  };
  readonly diagnostic:CompiledDiagnostic;
  readonly why:readonly EvidenceLink[];
  readonly limitations:readonly string[];
}
const facet=(s:NativeObservation):SourceFacet=>Object.freeze({
  vendor:s.vendor,instance:s.instance,nativeId:s.nativeId,businessId:s.businessId,
  revision:s.revision,nativeState:s.nativeState,planned:s.planned,
  reported:s.reported,unit:s.unit,
  capture:s.capture,coverage:s.coverage
});
const explanations=[
 {id:"plan",claim:"The reported plan comparison is source-bound",key:"plannedDelta",
   refs:[0,1] as const},
 {id:"quantity",claim:"The reported quantity comparison is source-bound",key:"reportedDelta",
   refs:[2,3] as const},
] as const;

export function buildConnectedCase(raw:unknown,runtime:SemanticRuntime=bundledSemanticRuntime()):WorkspaceCase {
  const p=admitCase(raw);
  // Only Haskell is allowed to compute a semantic comparison.
  const diagnostic=compileSemantic(p,runtime);
  const why=explanations.map(spec=>{
    const candidates=spec.refs.map(i=>diagnostic.candidates[i]!);
    return Object.freeze({
      id:spec.id,claim:spec.claim,
      compilerValue:diagnostic[spec.key],
      inputCandidates:Object.freeze([...spec.refs]),
      sourceNativeIds:Object.freeze(candidates.map(c=>c.sourceNativeId)),
      sourceRevisions:Object.freeze(candidates.map(c=>c.sourceRevision)),
      sourceQueries:Object.freeze(candidates.map(c=>c.sourceQueryDigest)),
      interpretation:"compiled-diagnostic-not-cause" as const
    });
  });
  return Object.freeze({
    schema:"fde.connected-case/v1" as const,
    authority:"none" as const,
    observationId:"obs-"+fingerprint(p),
    caseId:"case-"+fingerprint(stableCase(p)),
    dataClass:diagnostic.sourceClass,
    question:"What do ERPNext and OpenMES report about this order?" as const,
    observationScope:Object.freeze({
      readPattern:"two-independent-source-transactions" as const,
      distributedAtomicSnapshot:false as const,sourceWriteAllowed:false as const,
      businessTruthAdmitted:false as const,physicalProductionCertified:false as const
    }),
    sources:Object.freeze({erp:facet(p.erp),mes:facet(p.mes)}),
    binding:p.binding,
    diagnostic,
    why:Object.freeze(why),
    limitations:Object.freeze([
      "Two independent reads do not establish a simultaneous ERP/MES snapshot.",
      "The mapping is specific to this isolated synthetic reference case.",
      "Reported quantities are not witnessed execution intervals or physical output.",
      "Receipt, ledger, quality, and accounting evidence are not covered.",
      "This compiled result is a diagnostic candidate, not admitted business truth.",
      "No application control grants ERP/MES write or acknowledgment authority."
    ])
  });
}
