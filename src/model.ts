import {createHash} from "node:crypto";
import {detach,digest,identity,object,reject,string} from "./json.js";

export type Vendor="erpnext"|"openmes";
export type Role="erp"|"mes";
export type DataClass="handwritten-fixture"|"isolated-synthetic-native";
export interface NativeObservation {
  readonly schema:"fde.native-observation/v1";
  readonly dataClass:DataClass;
  readonly role:Role;
  readonly vendor:Vendor;
  readonly instance:string;
  readonly nativeId:string;
  readonly businessId:string;
  readonly revision:string; // opaque source equality witness, NOT a trusted clock
  readonly nativeState:string;
  readonly planned:string;
  readonly reported:string;
  readonly unit:"Nos"|"pcs";
  readonly coverage:{
    readonly order:"exact-native-row";
    readonly receipt:"not-covered";
    readonly ledger:"not-covered";
    readonly physical:"not-covered";
  };
  readonly capture:{
    readonly observedAt:string; // host capture, not a cross-system snapshot
    readonly querySha256:string;
    readonly mode:"source-read-only"|"fixture";
    readonly transport:"TLSv1.3"|"not-applicable";
  };
}
export interface NativeBinding {
  readonly schema:"fde.native-binding/v1";
  readonly grade:string;
  readonly erp:{readonly instance:string;readonly nativeId:string};
  readonly mes:{readonly instance:string;readonly nativeId:string};
  readonly unit:string;
}
export interface ReviewCase {
  readonly schema:"fde.case/v1";
  readonly erp:NativeObservation;
  readonly mes:NativeObservation;
  readonly binding:NativeBinding;
}
const srcKeys=[
  "schema","dataClass","role","vendor","instance","nativeId","businessId",
  "revision","nativeState","planned","reported","unit","coverage","capture"
];
const bKeys=["schema","grade","erp","mes","unit"];
const caseKeys=["schema","erp","mes","binding"];
const safeTime=(raw:unknown):string=>{
  const s=string(raw,"observedAt",40);
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s)||
     !Number.isFinite(Date.parse(s)))
    reject("invalid-observation-time","capture time is not ISO UTC");
  return s;
};
const exactDecimal=(raw:unknown,label:string):string=>{
  if(typeof raw!=="string"||
     !/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,12})?$/.test(raw))
    reject("invalid-decimal",label);
  return raw;
};
export function admitSource(raw:unknown):NativeObservation {
  const v=object(detach(raw),srcKeys,"source");
  if(v.schema!=="fde.native-observation/v1")reject("invalid-schema","source");
  if(v.dataClass!=="handwritten-fixture"&&v.dataClass!=="isolated-synthetic-native")
    reject("invalid-data-class","source");
  if(v.role!=="erp"&&v.role!=="mes")reject("invalid-role","source");
  if(v.vendor!==(v.role==="erp"?"erpnext":"openmes"))reject("wrong-vendor","source");
  const unit=v.role==="erp"?"Nos":"pcs";
  if(v.unit!==unit)reject("wrong-unit","native unit");
  const coverage=object(v.coverage,["order","receipt","ledger","physical"],"coverage");
  if(coverage.order!=="exact-native-row"||coverage.receipt!=="not-covered"||
     coverage.ledger!=="not-covered"||coverage.physical!=="not-covered")
    reject("unsupported-coverage","unqualified document or physical facts");
  const capture=object(v.capture,["observedAt","querySha256","mode","transport"],"capture");
  if(capture.mode!=="fixture"&&capture.mode!=="source-read-only")
    reject("invalid-read-mode","mode");
  if(capture.transport!==(capture.mode==="fixture"?"not-applicable":"TLSv1.3"))
    reject("invalid-transport","source/fixture mode");
  if(v.dataClass!==(capture.mode==="fixture"?"handwritten-fixture":"isolated-synthetic-native"))
    reject("invalid-source-grade","capture grade");
  return Object.freeze({
    schema:"fde.native-observation/v1" as const,dataClass:v.dataClass,
    role:v.role,vendor:v.vendor,instance:identity(v.instance,"instance"),
    nativeId:identity(v.nativeId,"nativeId"),
    businessId:identity(v.businessId,"businessId"),
    revision:string(v.revision,"revision",256),
    nativeState:string(v.nativeState,"nativeState",100),
    planned:exactDecimal(v.planned,"planned"),
    reported:exactDecimal(v.reported,"reported"),
    unit,
    coverage:Object.freeze({
      order:"exact-native-row" as const,receipt:"not-covered" as const,
      ledger:"not-covered" as const,physical:"not-covered" as const
    }),
    capture:Object.freeze({
      observedAt:safeTime(capture.observedAt),
      querySha256:digest(capture.querySha256,"query"),
      mode:capture.mode,transport:capture.transport
    })
  }) as NativeObservation;
}
export function admitBinding(raw:unknown):NativeBinding{
  const b=object(detach(raw),bKeys,"binding");
  if(b.schema!=="fde.native-binding/v1")
    reject("invalid-binding","unknown binding envelope");
  const erp=object(b.erp,["instance","nativeId"],"binding.erp");
  const mes=object(b.mes,["instance","nativeId"],"binding.mes");
  return Object.freeze({
    schema:"fde.native-binding/v1" as const,
    grade:string(b.grade,"binding.grade",96),
    unit:string(b.unit,"binding.unit",96),
    erp:Object.freeze({instance:identity(erp.instance,"binding.erp.instance"),
      nativeId:identity(erp.nativeId,"binding.erp.nativeId")}),
    mes:Object.freeze({instance:identity(mes.instance,"binding.mes.instance"),
      nativeId:identity(mes.nativeId,"binding.mes.nativeId")})
  });
}
export function admitCase(raw:unknown):ReviewCase {
  const v=object(detach(raw),caseKeys,"case");
  if(v.schema!=="fde.case/v1")reject("invalid-schema","case");
  const erp=admitSource(v.erp),mes=admitSource(v.mes),binding=admitBinding(v.binding);
  if(erp.role!=="erp"||mes.role!=="mes")reject("wrong-source-role","case");
  return Object.freeze({schema:"fde.case/v1" as const,erp,mes,binding});
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object"){
    const out:Record<string,unknown>={};
    for(const key of Object.keys(value).sort())
      out[key]=canonical((value as Record<string,unknown>)[key]);
    return out;
  }
  return value;
}
export function fingerprint(input:unknown):string {
  return createHash("sha256").update(JSON.stringify(canonical(detach(input)))).digest("hex");
}
export function stableSource(source:NativeObservation):unknown {
  const {capture,...rest}=source;
  return {...rest,capture:{querySha256:capture.querySha256,
    mode:capture.mode,transport:capture.transport}};
}
export function stableCase(pair:ReviewCase):unknown {
  return {schema:pair.schema,binding:pair.binding,
    erp:stableSource(pair.erp),mes:stableSource(pair.mes)};
}