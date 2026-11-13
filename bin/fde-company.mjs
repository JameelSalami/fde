#!/usr/bin/env node
// Employee-side local author/reviewer utility; no key generation or activation.
import {readFileSync,writeFileSync,renameSync} from "node:fs";
import {resolve,dirname,join} from "node:path";
import {parseStrictJson} from "../dist/src/json.js";
import {parseCompanyManifest,signCompanyManifest,companyManifestDigest,readCompanyFile,readSelectedCompanyPackage,exportCompanyPackage,sha256,canonical} from "../dist/src/company-package.js";
process.umask(0o077);
const [command,...args]=process.argv.slice(2);
function privateJson(path){return parseStrictJson(readCompanyFile(resolve(path)).toString("utf8"));}
if(command==="draft"&&args.length===3){
  const [payloadPath,artifactPath,output]=args;
  const payload=privateJson(payloadPath);
  const manifest=parseCompanyManifest({schema:"fde.company-semantic/v1",payload:{...payload,artifactSha256:sha256(readCompanyFile(resolve(artifactPath),64*1024*1024))},author:null,reviewer:null});
  writeFileSync(resolve(output),canonical(manifest)+"\n",{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({status:"draft",manifestSha256:companyManifestDigest(manifest)}));
}else if(["sign-author","sign-reviewer"].includes(command)&&args.length===3){
  const [path,id,keyPath]=args,absolute=resolve(path),role=command==="sign-author"?"author":"reviewer";
  const manifest=signCompanyManifest(privateJson(path),role,id,readCompanyFile(resolve(keyPath),8192).toString("utf8"));
  const temporary=join(dirname(absolute),".manifest-"+process.pid+".tmp");
  writeFileSync(temporary,canonical(manifest)+"\n",{mode:0o600,flag:"wx"});renameSync(temporary,absolute);
  console.log(JSON.stringify({status:role+"-signed",manifestSha256:companyManifestDigest(manifest)}));
}else if(command==="verify"&&args.length===2){
  console.log(JSON.stringify({status:"approved",...readSelectedCompanyPackage(resolve(args[0]),resolve(args[1])).binding}));
}else if(command==="export"&&args.length===3){
  console.log(JSON.stringify({status:"exported",...exportCompanyPackage(resolve(args[0]),resolve(args[1]),resolve(args[2]))}));
}else{
  throw Error("usage: fde-company draft PAYLOAD ARTIFACT NEW_MANIFEST | sign-author MANIFEST ID PRIVATE_KEY | sign-reviewer MANIFEST ID PRIVATE_KEY | verify SELECTION POLICY | export SELECTION POLICY NEW_DIRECTORY");
}
