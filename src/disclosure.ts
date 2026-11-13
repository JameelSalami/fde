/** No claim or source receipt may become automatic publication permission. */
export function disclosure(){
  return Object.freeze({
    schema:"fde.disclosure/v1" as const,
    state:"owner-review-required" as const,
    authority:"none" as const,
    reasons:Object.freeze([
      "Publication license not selected",
      "External consortium rights and participation not verified",
      "Prior project IP and source disclosure not cleared",
      "Independent external implementation and real-factory assessment not established"
    ])
  });
}
