import type {NativeObservation,NativeBinding,ReviewCase} from "../src/model.js";
export function synthetic():ReviewCase {
  const observation=(role:"erp"|"mes",instance:string,nativeId:string,
      businessId:string,nativeState:string,planned:string,reported:string):NativeObservation=>({
    schema:"fde.native-observation/v1",dataClass:"handwritten-fixture",
    role,vendor:role==="erp"?"erpnext":"openmes",
    instance,nativeId,businessId,revision:"native-v7",
    nativeState,planned,reported,unit:role==="erp"?"Nos":"pcs",
    coverage:{order:"exact-native-row",receipt:"not-covered",
      ledger:"not-covered",physical:"not-covered"},
    capture:{observedAt:"2026-10-29T09:07:00.000Z",
      querySha256:"b".repeat(64),mode:"fixture",transport:"not-applicable"}
  });
  const erp=observation("erp","erp-scenario-41","QA-WO-41",
    "QA-WO-41","In Process","8.000","2.125");
  const mes=observation("mes","mes-scenario-42","419",
    "MES-QA-41","IN_PROGRESS","8","3.250");
  const binding:NativeBinding={
    schema:"fde.native-binding/v1",
    grade:"synthetic-native-import-reviewed",
    erp:{instance:"erp-scenario-41",nativeId:"QA-WO-41"},
    mes:{instance:"mes-scenario-42",nativeId:"419"},
    unit:"synthetic-pcs-equals-Nos"
  };
  return {schema:"fde.case/v1",erp,mes,binding};
}
export const changed=(f:ReviewCase):ReviewCase=>structuredClone(f);
