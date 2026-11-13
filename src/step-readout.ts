/** FDE display-only projection: owner source, Haskell interpretation, human review stay distinct. */
import type {StoredObservation} from "./admission.js";
import type {ReviewState} from "./review-store.js";
export type StepResolution="summary"|"sources"|"semantics"|"review";
export function projectFdeSteps(stored:StoredObservation,review:ReviewState,resolution:StepResolution="summary"){
  if(!["summary","sources","semantics","review"].includes(resolution)||
    stored?.schema!=="fde.stored-observation/v1"||
    stored.view?.schema!=="fde.connected-case/v1"||stored.view.authority!=="none"||
    stored.view.observationScope.sourceWriteAllowed!==false||
    stored.view.observationScope.distributedAtomicSnapshot!==false||
    review?.schema!=="fde.review-state/v1"||
    review.observationId!==stored.view.observationId||
    review.authority!=="human-review-only"||review.sourceWriteAllowed!==false)
    throw new TypeError("exact FDE source and review evidence required");
  const view=stored.view,tied=review.currentness==="unresolved-tie",
    historical=review.currentness==="stale"||review.currentness==="superseded";
  const decision=tied?"SOURCE ORDER UNRESOLVED":historical?"HISTORICAL OR STALE EVIDENCE":
    review.disposition==="open"?"HUMAN REVIEW PENDING":
    review.disposition==="needs-investigation"?"INVESTIGATION REQUIRED":
    "HUMAN REVIEW RECORDED — NO VENDOR EFFECT";
  const steps=[
    {id:"sources",evidence:tied||historical?"unverified":"known",
      status:tied?"Equal-time source tie without unique latest":"Two independent source receipts",
      next:tied?"Obtain later separately ordered evidence; do not select a tie winner.":
      historical?"Preserve history and refresh the exact source.":
      "Check original native revisions and independent capture times."},
    {id:"semantics",evidence:"known",status:"Compiled Haskell candidate: "+view.diagnostic.classification,
      next:"Review candidate limits; no business truth admitted."},
    {id:"review",evidence:"known",status:"Human-review record: "+review.disposition,
      next:"Local review state never authorizes vendor posting or physical production."},
    {id:"vendor-effects",evidence:"unknown",status:"No vendor posting or physical outcome observed",
      next:"Vendor actions require a separate authorized enterprise host."}
  ] as const;
  let expanded:Readonly<Record<string,unknown>>|null=null;
  if(resolution==="sources")expanded={
    readPattern:view.observationScope.readPattern,distributedAtomicSnapshot:false,
    erp:{nativeId:view.sources.erp.nativeId,revision:view.sources.erp.revision,
      observedAt:view.sources.erp.capture.observedAt,querySha256:view.sources.erp.capture.querySha256},
    mes:{nativeId:view.sources.mes.nativeId,revision:view.sources.mes.revision,
      observedAt:view.sources.mes.capture.observedAt,querySha256:view.sources.mes.capture.querySha256},
    currentness:review.currentness,headTieCount:review.headTieCount};
  if(resolution==="semantics")expanded={
    compiler:"Haskell",classification:view.diagnostic.classification,
    mappingGrade:view.binding.grade,kernelSha256:stored.kernelSha256,
    admissionGrade:stored.snapshot.grade,businessTruthAdmitted:false,
    physicalProductionCertified:false,limitations:view.limitations.slice(0,6)};
  if(resolution==="review")expanded={
    disposition:review.disposition,version:review.version,assignee:review.assignee,
    currentness:review.currentness,headTieCount:review.headTieCount,
    auditTotal:review.auditTotal,auditTruncated:review.auditTruncated,
    authority:review.authority,sourceWriteAllowed:false};
  return {schema:"fde.step-readout/v1" as const,authority:"none" as const,
    effects:[] as const,sourceWriteAllowed:false as const,
    observationId:view.observationId,resolution,decision,
    ptq:[
      {stage:"P",evidence:tied||historical?"unverified":"known",
        fact:"Pinned native observations exist; no cross-system atomicity claim."},
      {stage:"T",evidence:"known",fact:"Haskell candidate and review state observed; no vendor transition."},
      {stage:"Q",evidence:"unverified",fact:"No business, physical or vendor-posting qualification."}
    ],
    steps,expanded,note:"Read-only projection; no fresh source acquisition or authority transfer."};
}
