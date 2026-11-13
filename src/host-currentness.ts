/** Host-level source observation drift only. This is not vendor CAS. */
import {admitCase,stableCase,fingerprint} from "./model.js";
export function compareReadObservations(before:unknown,after:unknown){
  const a=admitCase(before),b=admitCase(after);
  return Object.freeze({
    schema:"fde.host-source-read-comparison/v1" as const,
    result:fingerprint(stableCase(a))===fingerprint(stableCase(b))?
      "same-observed-inputs" as const:"changed-observed-inputs" as const,
    authority:"none" as const,
    vendorSideCAS:false as const,
    distributedAtomicSnapshot:false as const
  });
}
