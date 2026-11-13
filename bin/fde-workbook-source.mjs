#!/usr/bin/env node
/**
 * FDE-owned, read-only handoff bridge.
 * A saved connected case is NOT trusted until original FDE/compiled-Haskell
 * interpretation and exact role-source bindings have been reproduced.
 * No provider, vendor, or source write is possible on this path.
 */
import {readFileSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, constants} from "node:fs";
import {resolve, isAbsolute} from "node:path";
import {createHash} from "node:crypto";
import {parseStrictJson} from "../dist/src/json.js";
import {buildConnectedCase} from "../dist/src/workspace.js";
import {projectFdeNativeGarEvidence} from "../dist/src/gar-support.js";
import {projectFdeNativeEvidencePair, prepareFdeNativePairContext} from "../dist/src/evidence-pair.js";
import {bundledSemanticRuntime} from "../dist/src/semantic-runtime.js";
import {canonical} from "../dist/src/company-package.js";

const sha256=x=>createHash("sha256").update(x).digest("hex");
const fail=()=>{console.error("fde-workbook-source refused: invalid, incomplete or changed saved evidence");process.exitCode=2;};

function load(rawPath){
  if(typeof rawPath!=="string"||!isAbsolute(rawPath)||resolve(rawPath)!==rawPath||realpathSync(rawPath)!==rawPath)throw Error("path");
  const st=lstatSync(rawPath);
  if(!st.isFile()||st.isSymbolicLink()||st.size===0||st.size>262144)throw Error("custody");
  const fd=openSync(rawPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.ino!==st.ino||opened.dev!==st.dev||opened.size!==st.size)
      throw Error("source-file-changed");
    bytes=readFileSync(fd);
  } finally {closeSync(fd);}
  const saved=parseStrictJson(bytes.toString("utf8"));
  if(saved?.schema!=="fde.connected-case/v1"||saved.authority!=="none"||!saved.sources||!saved.binding)throw Error("schema");
  const native={
    schema:"fde.case/v1",
    erp:{schema:"fde.native-observation/v1",dataClass:saved.dataClass,role:"erp",...saved.sources.erp},
    mes:{schema:"fde.native-observation/v1",dataClass:saved.dataClass,role:"mes",...saved.sources.mes},
    binding:{schema:"fde.native-binding/v1",...saved.binding}
  };
  const kernel=bundledSemanticRuntime();
  const current=buildConnectedCase(native,kernel);
  // Tampering with previously serialized derived fields must not silently pass.
  if(canonical(current)!==canonical(saved))throw Error("changed-saved-interpretation");
  const witnesses=projectFdeNativeGarEvidence(current);
  const pair=projectFdeNativeEvidencePair(current,witnesses);
  const context=prepareFdeNativePairContext(current,witnesses);
  if(pair.status!=="complete-pair"||!pair.sources.erp.evidence||!pair.sources.mes.evidence||
      pair.observationId!==current.observationId||context.sourceIds.length!==2)throw Error("incomplete");
  const evidenceInputSha256=sha256(bytes);
  return {
    schema:"fde.workbook-evidence/v1",authority:"none",sourceWriteAllowed:false,
    physicalProductionCertified:false,sourceCurrentness:"not-verified",
    dataClass:current.dataClass,caseId:current.caseId,observationId:current.observationId,
    inputSha256:evidenceInputSha256,kernelSha256:kernel.fingerprint(),
    question:current.question,observationScope:current.observationScope,
    nativePair:pair,modelContextSourceIds:context.sourceIds,
    diagnostic:current.diagnostic,why:current.why,limitations:current.limitations
  };
}
try{
  if(process.argv.length!==3)throw Error("arguments");
  console.log(JSON.stringify(load(process.argv[2])));
}catch{fail();}
