#!/usr/bin/env node
/** Read-only source role inspector for an explicit existing FDE connected-case JSON file. */
import {readFileSync,lstatSync,realpathSync} from "node:fs";
import path from "node:path";
import {parseStrictJson} from "../dist/src/json.js";
import {buildConnectedCase} from "../dist/src/workspace.js";
import {projectFdeNativeGarEvidence} from "../dist/src/gar-support.js";
import {projectFdeNativeEvidencePair,formatFdeNativeEvidencePair,
  prepareFdeNativePairContext} from "../dist/src/evidence-pair.js";

const usage="fde-evidence inspect /absolute/connected-case.json [erp|mes|both] [--json] | context /absolute/connected-case.json";
function caseFile(filename){
  if(typeof filename!=="string"||!path.isAbsolute(filename)||
     path.resolve(filename)!==filename||realpathSync(filename)!==filename)
    throw Error("path-refused");
  const stat=lstatSync(filename);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>262144)
    throw Error("file-refused");
  const value=parseStrictJson(readFileSync(filename,"utf8"));
  if(!value||typeof value!=="object"||Array.isArray(value)||
     value.schema!=="fde.connected-case/v1"||value.authority!=="none"||
     !value.sources||!value.binding)
    throw Error("not-connected-case");
  const input={
    schema:"fde.case/v1",
    erp:{schema:"fde.native-observation/v1",dataClass:value.dataClass,
      role:"erp",...value.sources.erp},
    mes:{schema:"fde.native-observation/v1",dataClass:value.dataClass,
      role:"mes",...value.sources.mes},
    binding:{schema:"fde.native-binding/v1",...value.binding}
  };
  // All source/binding semantics and the Haskell diagnostic are rechecked in FDE,
  // not inferred from a saved model, display string or runner receipt.
  const connected=buildConnectedCase(input);
  if(connected.observationId!==value.observationId||
     connected.caseId!==value.caseId||
     connected.dataClass!==value.dataClass)
    throw Error("connected-case-source-identity-changed");
  return connected;
}
function main(){
  const [command,filename,choice="both",format] = process.argv.slice(2);
  if(command==="help"&&process.argv.length===3){console.log(usage);return;}
  if(!["inspect","context"].includes(command)||!filename||
     (command==="context"&&(process.argv.length!==4))||
     (command==="inspect"&&(!["erp","mes","both"].includes(choice)||
       ![undefined,"--json"].includes(format)||process.argv.length>6)))
    throw Error("invalid-arguments");
  const c=caseFile(filename);
  const native=projectFdeNativeGarEvidence(c);
  const chosen=choice==="both"?native:choice==="erp"?native.slice(0,1):native.slice(1);
  const pair=projectFdeNativeEvidencePair(c,chosen);
  if(command==="context"){
    console.log(JSON.stringify(prepareFdeNativePairContext(c,chosen),null,2));return;
  }
  console.log(format==="--json"?JSON.stringify(pair,null,2):formatFdeNativeEvidencePair(pair));
}
try{main();}catch{
  console.error("fde-evidence refused: invalid, changed, unavailable or incomplete evidence input");
  process.exitCode=2;
}
