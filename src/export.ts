/** Excel-compatible CSV and lossless JSON from ONE pinned case observation.
 * CSV is a non-authoritative projection; never back-imported to the vendors.
 */
import type {WorkspaceCase} from "./workspace.js";

const headers=[
  "Observation ID","Case ID","Semantic candidate","Native vendor",
  "Source instance","Native record ID","Source business ID","Native revision",
  "Native state","Source property","Quantity (exact text)","Native unit",
  "Source read captured UTC","Source query SHA-256","Evidence grade",
  "Binding grade","Haskell classification","Plan difference (exact text)",
  "Reported difference (exact text)","Receipt coverage","Ledger coverage",
  "Physical coverage","Atomic ERP/MES snapshot","Write permitted"
] as const;
/** Treat IDs as text, not as Excel-auto-converted numbers. Escape formulas. */
export function csvCell(value:unknown,identifier=false):string {
  const raw=String(value??"");
  // Quotes alone do NOT neutralize spreadsheet formulas.
  const safe=identifier||/^[\t\r\n ]*[=+\-@]/.test(raw)||
    /^[\t\r\n]/.test(raw)?"'"+raw:raw;
  return '"'+safe.replace(/"/g,'""')+'"';
}
function entry(c:WorkspaceCase,i:number):readonly string[]{
  const claim=c.diagnostic.candidates[i]!;
  const origin=claim.sourceVendor==="erpnext"?c.sources.erp:c.sources.mes;
  return [
    c.observationId,c.caseId,claim.family+" / "+claim.rootKind,
    origin.vendor,origin.instance,origin.nativeId,origin.businessId,
    origin.revision,origin.nativeState,claim.property,claim.quantity,
    claim.unit,origin.capture.observedAt,origin.capture.querySha256,
    c.dataClass,c.binding.grade,c.diagnostic.classification,
    c.diagnostic.plannedDelta,c.diagnostic.reportedDelta,
    c.diagnostic.receiptCoverage,c.diagnostic.ledgerCoverage,
    c.diagnostic.physicalCoverage,String(c.observationScope.distributedAtomicSnapshot),
    String(c.observationScope.sourceWriteAllowed)
  ];
}
export function exportExcelCsv(c:WorkspaceCase):string {
  if(c.schema!=="fde.connected-case/v1"||c.authority!=="none"||
     c.observationScope.sourceWriteAllowed!==false ||
     c.diagnostic.candidates.length!==4)
    throw Error("unverified-workspace-export");
  const rows=[headers.map(k=>csvCell(k)).join(",")];
  for(let i=0;i<c.diagnostic.candidates.length;i++){
    const values=entry(c,i);
    rows.push(values.map((v,n)=>csvCell(v,[0,1,4,5,6,7,10,12,13,17,18].includes(n))).join(","));
  }
  return "\uFEFF"+rows.join("\r\n")+"\r\n";
}
export function exportEvidenceJson(c:WorkspaceCase):string {
  if(c.schema!=="fde.connected-case/v1"||c.authority!=="none"||
     c.observationScope.sourceWriteAllowed!==false)
    throw Error("unverified-workspace-export");
  return JSON.stringify(c,null,2)+"\n";
}