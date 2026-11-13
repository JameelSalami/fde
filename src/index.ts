/** Pure FDE source/host boundaries. Haskell is the sole semantic owner. */
export {FdeInputError,parseStrictJson,detach} from "./json.js";
export {admitSource,admitBinding,admitCase,fingerprint,stableSource,stableCase,
  type NativeObservation,type NativeBinding,type ReviewCase,
  type Vendor,type Role,type DataClass} from "./model.js";
export {compareReadObservations} from "./host-currentness.js";
export {projectFdeNativeEvidencePair,formatFdeNativeEvidencePair,prepareFdeNativePairContext,
  type FdeNativeEvidencePair,type FdeNativeEvidenceSlot} from "./evidence-pair.js";
export {compileSemantic,verifyCompilerResponse,
  type CompiledDiagnostic,type Classification,type SemanticCandidate} from "./compiler.js";
export {formatDiagnostic} from "./presentation.js";

export {compileSemanticCatalog,compileSemanticPackage,assessSemanticClaim} from "./semantic-client.js";
export {compileOperationalPackage,renderOperationalPackageArtifacts} from "./package.js";


export {SemanticRuntime,bundledSemanticRuntime,loadCompanySemanticRuntime} from "./semantic-runtime.js";
export {parseCompanyManifest,parseCompanyPolicy,companyManifestDigest,signCompanyManifest,verifyCompanyManifest,exportCompanyPackage,type CompanyManifest,type CompanyPayload,type CompanyPolicy,type CompanyBinding} from "./company-package.js";
