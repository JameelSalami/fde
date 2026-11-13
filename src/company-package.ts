/** Company-owned W1 artifact custody. Signatures establish approval by keys in
 * an owner-provisioned policy; source/build digests remain signed claims.
 * No request body can provision the policy or activate an executable. */
import {createHash,createPublicKey,createPrivateKey,sign,verify} from "node:crypto";
import {readFileSync,lstatSync,realpathSync,mkdirSync,writeFileSync} from "node:fs";
import {resolve,dirname,join,isAbsolute} from "node:path";
import {object,parseStrictJson,detach} from "./json.js";

export interface CompanyPayload {
  readonly companyId:string;readonly packageId:string;readonly version:string;
  readonly contract:"fde.semantic-w1/v1";readonly sourceTreeSha256:string;
  readonly verificationSha256:string;readonly buildId:string;readonly artifactSha256:string;
}
export interface CompanySignature {readonly id:string;readonly signature:string;}
export interface CompanyManifest {
  readonly schema:"fde.company-semantic/v1";readonly payload:CompanyPayload;
  readonly author:CompanySignature|null;readonly reviewer:CompanySignature|null;
}
export interface CompanyPolicy {
  readonly schema:"fde.company-policy/v1";readonly companyId:string;
  readonly authors:readonly Readonly<{id:string;publicKeyPem:string}>[];
  readonly reviewers:readonly Readonly<{id:string;publicKeyPem:string}>[];
}
export interface CompanyBinding {
  readonly companyId:string;readonly packageId:string;readonly version:string;
  readonly manifestSha256:string;readonly policySha256:string;
}
export const sha256=(bytes:string|Buffer):string=>createHash("sha256").update(bytes).digest("hex");
export function canonical(value:unknown):string{
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical((value as Record<string,unknown>)[k])).join(",")+"}";
}
const digest=(value:unknown)=>sha256(canonical(value));
const identifier=(v:unknown)=>typeof v==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(v);
const hash=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
function signature(raw:unknown):CompanySignature|null{
  if(raw===null)return null;
  const r=object(raw,["id","signature"],"company signature");
  if(!identifier(r.id)||typeof r.signature!=="string"||!/^[A-Za-z0-9+/]{86}==$/.test(r.signature))
    throw Error("company-signature-shape-refused");
  return Object.freeze(r) as unknown as CompanySignature;
}
export function parseCompanyManifest(raw:unknown):CompanyManifest{
  const m=object(detach(raw),["schema","payload","author","reviewer"],"company manifest");
  const p=object(m.payload,["companyId","packageId","version","contract","sourceTreeSha256","verificationSha256","buildId","artifactSha256"],"company payload");
  if(m.schema!=="fde.company-semantic/v1"||!identifier(p.companyId)||!identifier(p.packageId)||
     !identifier(p.version)||!identifier(p.buildId)||p.contract!=="fde.semantic-w1/v1"||
     !hash(p.sourceTreeSha256)||!hash(p.verificationSha256)||!hash(p.artifactSha256))
    throw Error("company-manifest-refused");
  return Object.freeze({schema:"fde.company-semantic/v1",payload:Object.freeze(p) as unknown as CompanyPayload,
    author:signature(m.author),reviewer:signature(m.reviewer)});
}
export function companyManifestDigest(raw:unknown):string{return digest(parseCompanyManifest(raw));}
function publicKey(pem:unknown){
  if(typeof pem!=="string"||pem.length>1024||!/^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem))throw Error("company-key-refused");
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=="ed25519")throw Error("company-key-refused");
  return key;
}
export function parseCompanyPolicy(raw:unknown):CompanyPolicy{
  const p=object(detach(raw),["schema","companyId","authors","reviewers"],"company policy");
  if(p.schema!=="fde.company-policy/v1"||!identifier(p.companyId))throw Error("company-policy-refused");
  const identities=new Set<string>(),keys=new Set<string>();
  const list=(rawList:unknown)=>{
    if(!Array.isArray(rawList)||rawList.length<1||rawList.length>32)throw Error("company-policy-membership-refused");
    return Object.freeze(rawList.map(rawEntry=>{
      const e=object(rawEntry,["id","publicKeyPem"],"company principal");
      if(!identifier(e.id))throw Error("company-policy-principal-refused");
      const key=publicKey(e.publicKeyPem),identity=String(e.id);
      const fingerprint=sha256(key.export({format:"der",type:"spki"}));
      if(identities.has(identity)||keys.has(fingerprint))throw Error("company-policy-separation-refused");
      identities.add(identity);keys.add(fingerprint);
      return Object.freeze({id:identity,publicKeyPem:key.export({format:"pem",type:"spki"}).toString()});
    }));
  };
  return Object.freeze({schema:"fde.company-policy/v1",companyId:String(p.companyId),authors:list(p.authors),reviewers:list(p.reviewers)});
}
function message(manifest:CompanyManifest,role:"author"|"reviewer"):Buffer{
  return Buffer.from("fde.company-semantic/v1/"+role+"\n"+canonical(role==="author"?manifest.payload:{payload:manifest.payload,author:manifest.author}));
}
/** Signing is an employee-side authoring utility. Runtime trust comes only from policy. */
export function signCompanyManifest(raw:unknown,role:"author"|"reviewer",id:string,privateKeyPem:string):CompanyManifest{
  const m=parseCompanyManifest(raw),key=createPrivateKey(privateKeyPem);
  if(!identifier(id)||key.asymmetricKeyType!=="ed25519"||(role!=="author"&&role!=="reviewer"))throw Error("company-signer-refused");
  if(role==="reviewer"&&(!m.author||m.author.id===id))throw Error("company-review-separation-refused");
  const signed={id,signature:sign(null,message(m,role),key).toString("base64")};
  return parseCompanyManifest(role==="author"?{...m,author:signed,reviewer:null}:{...m,reviewer:signed});
}
export function verifyCompanyManifest(raw:unknown,rawPolicy:unknown):{manifest:CompanyManifest;policy:CompanyPolicy;binding:CompanyBinding}{
  const manifest=parseCompanyManifest(raw),policy=parseCompanyPolicy(rawPolicy);
  if(manifest.payload.companyId!==policy.companyId)throw Error("company-scope-refused");
  if(!manifest.author||!manifest.reviewer||manifest.author.id===manifest.reviewer.id)throw Error("company-review-required");
  for(const role of ["author","reviewer"] as const){
    const claim=manifest[role]!;
    const trusted=(role==="author"?policy.authors:policy.reviewers).find(p=>p.id===claim.id);
    if(!trusted||!verify(null,message(manifest,role),publicKey(trusted.publicKeyPem),Buffer.from(claim.signature,"base64")))
      throw Error("company-approval-refused");
  }
  return {manifest,policy,binding:Object.freeze({companyId:policy.companyId,packageId:manifest.payload.packageId,
    version:manifest.payload.version,manifestSha256:digest(manifest),policySha256:digest(policy)})};
}
/** POSIX owner custody only. This is not enterprise IAM or administrator exclusion. */
export function readCompanyFile(path:string,maximum=262144):Buffer{
  if(!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)throw Error("company-path-custody-refused");
  const parent=lstatSync(dirname(path)),st=lstatSync(path);
  if(!parent.isDirectory()||(parent.mode&0o077)!==0||!st.isFile()||st.isSymbolicLink()||
     (st.mode&0o077)!==0||st.size>maximum||!process.getuid||
     st.uid!==process.getuid()||parent.uid!==process.getuid())throw Error("company-file-custody-refused");
  const bytes=readFileSync(path);if(bytes.length>maximum)throw Error("company-file-budget");return bytes;
}
export function readSelectedCompanyPackage(selectionPath:string,policyPath:string):{
  executable:string;manifest:CompanyManifest;binding:CompanyBinding;
}{
  const s=object(parseStrictJson(readCompanyFile(selectionPath).toString("utf8")),
    ["schema","companyId","packageDirectory","manifestSha256"],"company selection");
  if(s.schema!=="fde.company-selection/v1"||!identifier(s.companyId)||typeof s.packageDirectory!=="string"||
     !isAbsolute(s.packageDirectory)||!hash(s.manifestSha256))throw Error("company-selection-refused");
  const manifest=parseStrictJson(readCompanyFile(join(s.packageDirectory,"manifest.json")).toString("utf8"));
  const policy=parseStrictJson(readCompanyFile(policyPath).toString("utf8"));
  const approved=verifyCompanyManifest(manifest,policy);
  if(s.companyId!==approved.binding.companyId||s.manifestSha256!==approved.binding.manifestSha256)
    throw Error("company-selection-binding-refused");
  const executable=join(s.packageDirectory,"fde-semantic");
  if(sha256(readCompanyFile(executable,64*1024*1024))!==approved.manifest.payload.artifactSha256)
    throw Error("company-artifact-binding-refused");
  return {executable,manifest:approved.manifest,binding:approved.binding};
}
/** Explicit distribution allowlist: no source, fixtures, keys, policy or selection. */
export function exportCompanyPackage(selectionPath:string,policyPath:string,destination:string):CompanyBinding{
  const selected=readSelectedCompanyPackage(selectionPath,policyPath);
  if(!isAbsolute(destination)||resolve(destination)!==destination||realpathSync(dirname(destination))!==dirname(destination))
    throw Error("company-export-path-refused");
  const bytes=readCompanyFile(selected.executable,64*1024*1024);
  if(sha256(bytes)!==selected.manifest.payload.artifactSha256)throw Error("company-artifact-binding-refused");
  mkdirSync(destination,{mode:0o700});
  writeFileSync(join(destination,"fde-semantic"),bytes,{flag:"wx",mode:0o700});
  writeFileSync(join(destination,"manifest.json"),canonical(selected.manifest)+"\n",{flag:"wx",mode:0o600});
  return selected.binding;
}
