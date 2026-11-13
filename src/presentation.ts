/** Pure formatting of independently checked Haskell output; no second semantic evaluator. */
import type {CompiledDiagnostic} from "./compiler.js";

export function formatDiagnostic(d:CompiledDiagnostic):string{
  return [
    "FDE | compiled Haskell semantic candidates | authority:none",
    "ERP native "+d.erpNativeId+" (rev "+d.erpRevision+")",
    "MES native "+d.mesNativeId+" (rev "+d.mesRevision+")",
    "Analysis "+d.classification+" | plan delta "+d.plannedDelta+
      " | reported delta "+d.reportedDelta,
    "Source grade "+d.sourceClass+" | admitted truth: NO",
    "Coverage: receipt "+d.receiptCoverage+", ledger "+d.ledgerCoverage+
      ", physical "+d.physicalCoverage,
    "Source reads: two independent READ ONLY transactions, not an atomic pair",
    "Mutation proposal executable: false | source posting: prohibited",
  ].join("\n");
}
