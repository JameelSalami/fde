import test,{type TestContext} from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,rmSync,readdirSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {synthetic} from "./fixtures.js";
import {parseCompanyPolicy,signCompanyManifest,verifyCompanyManifest,companyManifestDigest,exportCompanyPackage,sha256,canonical,type CompanyManifest} from "../src/company-package.js";
import {bundledSemanticRuntime,loadCompanySemanticRuntime} from "../src/semantic-runtime.js";
import {compileSemantic} from "../src/compiler.js";
import {compileSemanticCatalog,compileSemanticPackage,assessSemanticClaim} from "../src/semantic-client.js";
import {buildConnectedCase} from "../src/workspace.js";
import {prepareAdmission,admitForReview,replayObservation,type StoredObservation} from "../src/admission.js";
import {selectedApplicationRelease,createApplicationServer,type ReleaseManifest} from "../src/web/application.js";
import {makeAuthUser,admitAuthConfig} from "../src/web/auth.js";
import {listenLocal} from "../src/web/server.js";
import {ReviewStore} from "../src/review-store.js";

const keys=()=>{
  const k=generateKeyPairSync("ed25519");return {publicKeyPem:k.publicKey.export({format:"pem",type:"spki"}).toString(),
    privateKeyPem:k.privateKey.export({format:"pem",type:"pkcs8"}).toString()};
};
function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),"fde-company-test-"));chmodSync(dir,0o700);
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const author=keys(),reviewer=keys(),packageDirectory=join(dir,"private-package");mkdirSync(packageDirectory,{mode:0o700});
  const bytes=readFileSync(bundledSemanticRuntime().executable);
  const artifact=join(packageDirectory,"fde-semantic");writeFileSync(artifact,bytes,{mode:0o700});
  const policy={schema:"fde.company-policy/v1",companyId:"synthetic-company",authors:[{id:"employee-author",publicKeyPem:author.publicKeyPem}],
    reviewers:[{id:"employee-reviewer",publicKeyPem:reviewer.publicKeyPem}]};
  const draft:CompanyManifest={schema:"fde.company-semantic/v1",payload:{companyId:policy.companyId,packageId:"private-w1",version:"v1",
    contract:"fde.semantic-w1/v1",sourceTreeSha256:"1".repeat(64),verificationSha256:"2".repeat(64),buildId:"synthetic-build-1",artifactSha256:sha256(bytes)},author:null,reviewer:null};
  const approve=(raw:CompanyManifest)=>signCompanyManifest(signCompanyManifest(raw,"author","employee-author",author.privateKeyPem),"reviewer","employee-reviewer",reviewer.privateKeyPem);
  let manifest=approve(draft);
  const manifestPath=join(packageDirectory,"manifest.json"),policyPath=join(dir,"policy.json"),selectionPath=join(dir,"selection.json");
  const save=(value:CompanyManifest,updateSelection=true)=>{
    manifest=value;writeFileSync(manifestPath,canonical(value)+"\n",{mode:0o600});
    if(updateSelection)writeFileSync(selectionPath,JSON.stringify({schema:"fde.company-selection/v1",companyId:policy.companyId,packageDirectory,manifestSha256:companyManifestDigest(value)}),{mode:0o600});
  };
  writeFileSync(policyPath,JSON.stringify(policy),{mode:0o600});save(manifest);
  return {dir,packageDirectory,manifestPath,artifact,policyPath,selectionPath,author,reviewer,policy,draft,manifest,approve,save};
}

test("C01 owner policy verifies two role-separated signatures over exact private package claims",t=>{
  const f=fixture(t);
  assert.equal(verifyCompanyManifest(f.manifest,f.policy).binding.companyId,"synthetic-company");
  const changed={...f.manifest,payload:{...f.manifest.payload,sourceTreeSha256:"9".repeat(64)}};
  assert.throws(()=>verifyCompanyManifest(changed,f.policy),/company-approval-refused/,"C01 changed signed payload refuses");
  assert.throws(()=>verifyCompanyManifest(f.draft,f.policy),/company-review-required/);
  const rogue=keys(),forged=signCompanyManifest(f.draft,"author","employee-author",rogue.privateKeyPem);
  const reviewed=signCompanyManifest(forged,"reviewer","employee-reviewer",f.reviewer.privateKeyPem);
  assert.throws(()=>verifyCompanyManifest(reviewed,f.policy),/company-approval-refused/);
  assert.throws(()=>verifyCompanyManifest({...f.manifest,trustPolicy:f.policy},f.policy),/closed-object/);
  assert.throws(()=>verifyCompanyManifest(f.manifest,{...f.policy,companyId:"another-company"}),/company-scope-refused/);
});
test("C02 author and reviewer are distinct provisioned identities and normalized keys",t=>{
  const f=fixture(t);assert.equal(parseCompanyPolicy(f.policy).reviewers[0]!.id,"employee-reviewer");
  const aliasedKey={...f.policy,reviewers:[{id:"different-label",publicKeyPem:f.author.publicKeyPem.replaceAll("\n","\r\n")}]};
  assert.throws(()=>parseCompanyPolicy(aliasedKey),/company-policy-separation-refused/,"C02 one key cannot impersonate two employees");
  assert.throws(()=>parseCompanyPolicy({...f.policy,reviewers:[{id:"employee-author",publicKeyPem:f.reviewer.publicKeyPem}]}),/company-policy-separation-refused/);
  assert.throws(()=>parseCompanyPolicy({...f.policy,authors:[{id:"employee-author",publicKeyPem:f.author.privateKeyPem}]}),/company-key-refused/);
  assert.throws(()=>signCompanyManifest(f.manifest,"reviewer","employee-author",f.author.privateKeyPem),/company-review-separation-refused/);
});
test("C03 startup selection refuses unselected approval, artifact drift and weak private custody",t=>{
  const f=fixture(t);assert.equal(loadCompanySemanticRuntime(f.selectionPath,f.policyPath).sha256,f.manifest.payload.artifactSha256);
  const newer=f.approve({...f.draft,payload:{...f.draft.payload,version:"v2"}});f.save(newer,false);
  assert.throws(()=>loadCompanySemanticRuntime(f.selectionPath,f.policyPath),/company-selection-binding-refused/,"C03 approved but unselected package refuses");
  f.save(f.manifest);writeFileSync(f.artifact,Buffer.concat([readFileSync(f.artifact),Buffer.from("changed")]));
  assert.throws(()=>loadCompanySemanticRuntime(f.selectionPath,f.policyPath),/company-artifact-binding-refused/);
  chmodSync(f.policyPath,0o644);
  assert.throws(()=>loadCompanySemanticRuntime(f.selectionPath,f.policyPath),/company-file-custody-refused/);
  chmodSync(f.policyPath,0o600);
  const alias=join(f.dir,"selection-link.json");symlinkSync(f.selectionPath,alias);
  assert.throws(()=>loadCompanySemanticRuntime(alias,f.policyPath),/company-path-custody-refused/);
});
test("C04 all Haskell protocols and persisted replay retain exact company approval identity",t=>{
  const f=fixture(t),runtime=loadCompanySemanticRuntime(f.selectionPath,f.policyPath),input=synthetic();
  assert.deepEqual(compileSemantic(input,runtime),compileSemantic(input));
  assert.equal(compileSemanticCatalog(runtime).modelId,"fde.w1.production-order");
  assert.equal(compileSemanticPackage(input,runtime).facts.length,7);
  assert.equal(assessSemanticClaim(input,{kind:"physical-production-occurred"},runtime).authority,"none");
  const view=buildConnectedCase(input,runtime),admission=prepareAdmission(input,view),snapshot=admitForReview(admission,runtime);
  const hostRelease:ReleaseManifest={schema:"fde.release/v1",releaseId:"fde-0123456789abcdef",sourceRevision:"a".repeat(40),sourceTreeSha256:"b".repeat(64),
    kernelSha256:bundledSemanticRuntime().sha256,nodeVersion:process.version,builtAt:"2026-10-31T00:00:00Z",configurationSchema:"fde.private-lab/v1",files:{}};
  const release=selectedApplicationRelease(hostRelease,runtime);
  const stored:StoredObservation={schema:"fde.stored-observation/v1",view,admission,snapshot,releaseId:release.releaseId,kernelSha256:runtime.sha256,
    semanticPackage:runtime.companyPackage,acquiredAt:"2026-10-31T00:00:00Z"};
  replayObservation(stored,runtime);
  const store=new ReviewStore(join(f.dir,"reviews.sqlite"),Date.now,s=>replayObservation(s,runtime));t.after(()=>store.close());
  store.registerRelease(release);store.put(stored);assert.deepEqual(store.get(view.observationId).semanticPackage,runtime.companyPackage);
  f.save(f.approve({...f.draft,payload:{...f.draft.payload,version:"v2",buildId:"another-build"}}));
  const other=loadCompanySemanticRuntime(f.selectionPath,f.policyPath);
  assert.equal(other.sha256,runtime.sha256);
  assert.notEqual(selectedApplicationRelease(hostRelease,other).releaseId,release.releaseId);
  assert.throws(()=>replayObservation(stored,other),/pinned-company-package-unavailable/,"C04 same binary different approval cannot replay");
  assert.throws(()=>replayObservation(stored),/pinned-company-package-unavailable/);
  replayObservation(stored,runtime); // Other selections do not mutate this runtime.
  writeFileSync(f.artifact,Buffer.concat([readFileSync(f.artifact),Buffer.from("drift")]));
  assert.throws(()=>compileSemantic(input,runtime),/pinned-kernel-unavailable/);
});
test("C05 explicit export contains only reviewed executable and signed manifest",t=>{
  const f=fixture(t);
  writeFileSync(join(f.packageDirectory,"private-source.hs"),"private source fixture",{mode:0o600});
  writeFileSync(join(f.packageDirectory,"employee-private-key.pem"),f.author.privateKeyPem,{mode:0o600});
  mkdirSync(join(f.packageDirectory,"fixtures"),{mode:0o700});
  writeFileSync(join(f.packageDirectory,"fixtures","private-case.json"),"{}",{mode:0o600});
  const target=join(f.dir,"distribution");
  assert.equal(exportCompanyPackage(f.selectionPath,f.policyPath,target).manifestSha256,companyManifestDigest(f.manifest));
  assert.deepEqual(readdirSync(target).sort(),["fde-semantic","manifest.json"],"C05 private material is absent from export");
  assert.equal(sha256(readFileSync(join(target,"fde-semantic"))),f.manifest.payload.artifactSha256);
  assert.throws(()=>exportCompanyPackage(f.selectionPath,f.policyPath,target),/EEXIST/);
});
test("C06 invocation refuses executable drift after approved startup selection",t=>{
  const f=fixture(t),runtime=loadCompanySemanticRuntime(f.selectionPath,f.policyPath);
  assert.equal(compileSemantic(synthetic(),runtime).authority,"none");
  writeFileSync(f.artifact,Buffer.concat([readFileSync(f.artifact),Buffer.from("\nprivate-package-drift\n")]));
  assert.throws(()=>compileSemantic(synthetic(),runtime),/pinned-kernel-unavailable/,"C06 changed selected artifact never dispatches");
});
test("C07 company application activation isolates human review state and preserves explicit rollback",async t=>{
  const f=fixture(t),runtime=loadCompanySemanticRuntime(f.selectionPath,f.policyPath),password="synthetic-long-company-password-42";
  const auth=admitAuthConfig({schema:"fde.lab-auth/v1",users:[await makeAuthUser("reviewer","reviewer",password)]});
  const p=synthetic(),observedAt=new Date().toISOString();
  const input={...p,erp:{...p.erp,capture:{...p.erp.capture,observedAt}},mes:{...p.mes,capture:{...p.mes.capture,observedAt}}};
  const release:ReleaseManifest={schema:"fde.release/v1",releaseId:"fde-0123456789abcdef",sourceRevision:"a".repeat(40),sourceTreeSha256:"b".repeat(64),
    kernelSha256:bundledSemanticRuntime().sha256,nodeVersion:process.version,builtAt:observedAt,configurationSchema:"fde.private-lab/v1",files:{}};
  const store=new ReviewStore(join(f.dir,"v1.sqlite"),Date.now,s=>replayObservation(s,runtime));
  const server=createApplicationServer({auth,store,release,semanticRuntime:runtime,source:async()=>input});
  const port=await listenLocal(server,0);t.after(()=>{server.closeAllConnections();server.close();store.close();});
  const headers={Authorization:"Basic "+Buffer.from("reviewer:"+password).toString("base64")};
  const response=await fetch("http://127.0.0.1:"+port+"/api/case",{headers});assert.equal(response.status,200);
  const view=await response.json();const saved=store.get(view.observationId);
  assert.equal(saved.semanticPackage?.manifestSha256,runtime.companyPackage?.manifestSha256);
  const review=await fetch("http://127.0.0.1:"+port+"/api/review",{method:"POST",
    headers:{...headers,"Content-Type":"application/json","X-FDE-Request":"w1"},
    body:JSON.stringify({actionId:randomUUID(),observationId:view.observationId,expectedVersion:0,
      assignee:"reviewer",disposition:"reviewed",note:"Synthetic company review of this exact approved package."})});
  assert.equal(review.status,200);assert.equal(store.review(view.observationId).disposition,"reviewed");
  const version=await(await fetch("http://127.0.0.1:"+port+"/api/version",{headers})).json();
  assert.equal(version.schema,"fde.application-runtime/v1");assert.equal(version.hostRelease.schema,"fde.release/v1");
  assert.equal(version.hostRelease.releaseId,release.releaseId);
  f.save(f.approve({...f.draft,payload:{...f.draft.payload,version:"v2"}}));
  const next=loadCompanySemanticRuntime(f.selectionPath,f.policyPath);
  assert.throws(()=>createApplicationServer({auth,store,release,semanticRuntime:next,source:async()=>input}),/company-state-binding-refused/,"C07 new package cannot inherit prior review state");
  const separate=new ReviewStore(join(f.dir,"v2.sqlite"),Date.now,s=>replayObservation(s,next));t.after(()=>separate.close());
  separate.bindSemanticPackage(next.companyPackage);
  assert.equal(separate.counts().observations,0);
  store.bindSemanticPackage(runtime.companyPackage);assert.equal(store.get(view.observationId).releaseId,saved.releaseId);
  assert.equal((await fetch("http://127.0.0.1:"+port+"/api/company/activate",{method:"POST",headers})).status,405);
});
test("C08 explicit incomplete company configuration cannot fall back to bundled semantics",t=>{
  const f=fixture(t),env:NodeJS.ProcessEnv={...process.env,FDE_STATE_DIR:f.dir};
  delete env.FDE_COMPANY_SELECTION;delete env.FDE_COMPANY_POLICY;delete env.FDE_AI_CONFIG;
  const executable=fileURLToPath(new URL("../../bin/fde-app.mjs",import.meta.url));
  for(const config of [{FDE_COMPANY_SELECTION:"",FDE_COMPANY_POLICY:""},{FDE_COMPANY_SELECTION:""},
    {FDE_COMPANY_SELECTION:f.selectionPath},{FDE_COMPANY_POLICY:f.policyPath}]){
    const refused=spawnSync(process.execPath,[executable],{env:{...env,...config},encoding:"utf8",timeout:10000});
    assert.equal(refused.status,1);
    assert.match(refused.stderr,/company-selection-and-policy-required/,"C08 explicit empty company config refuses before auth");
  }
  const bundled=spawnSync(process.execPath,[executable],{env,encoding:"utf8",timeout:10000});
  assert.match(bundled.stderr,/ENOENT/);assert.doesNotMatch(bundled.stderr,/company-selection-and-policy-required/);
});
