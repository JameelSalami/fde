import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {
  admitPortableToolchain,verifyPortableToolchain,verifiedKernelOutput,checkedDestination,kernelSourceDigest
} from "../scripts/build-kernel-portable.mjs";
const hash=b=>createHash("sha256").update(b).digest("hex");
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),"fde-portable-"));
  t.after(()=>rmSync(root,{force:true,recursive:true}));
  const ghc=join(root,"ghc"+(process.platform==="win32"?".exe":""));
  const cabal=join(root,"cabal"+(process.platform==="win32"?".exe":""));
  writeFileSync(ghc,"synthetic-compiler");writeFileSync(cabal,"synthetic-cabal");
  const store=join(root,"store"),scratch=join(root,"scratch");
  mkdirSync(store);mkdirSync(scratch);
  const profile={schema:"fde.portable-toolchain/v1",targetPlatform:process.platform,targetArch:process.arch,
    ghc:{path:ghc,sha256:hash("synthetic-compiler")},
    cabal:{path:cabal,sha256:hash("synthetic-cabal")},store,scratch};
  return {root,ghc,cabal,profile};
}
test("WP01 platform, schemas and tool digest reject false toolchains",t=>{
  const f=fixture(t),p=admitPortableToolchain(f.profile);
  assert.equal(verifyPortableToolchain(p).ghc,p.ghc.sha256);
  assert.throws(()=>admitPortableToolchain({...f.profile,targetPlatform:"foreign"}),/platform-or-shape/);
  assert.throws(()=>admitPortableToolchain({...f.profile,grant:true}),/platform-or-shape/);
  assert.throws(()=>verifyPortableToolchain(admitPortableToolchain({...f.profile,ghc:{...f.profile.ghc,sha256:"0".repeat(64)}})),/tool-drift/);
});
test("WP02 changed compiler and noncanonical path refuse",t=>{
  const f=fixture(t),p=admitPortableToolchain(f.profile);
  writeFileSync(f.ghc,"changed-compiler");
  assert.throws(()=>verifyPortableToolchain(p),/tool-drift/);
  assert.throws(()=>admitPortableToolchain({...f.profile,ghc:{...f.profile.ghc,path:"relative/ghc"}}),/noncanonical-absolute-path/);
});
test("WP03 executable must come from Cabal output and correct OS suffix",t=>{
  const f=fixture(t),kernel=join(f.root,"kernel"),dir=join(kernel,"dist-newstyle","build");
  mkdirSync(dir,{recursive:true});
  const good=join(dir,process.platform==="win32"?"fde-semantic.exe":"fde-semantic");
  writeFileSync(good,"dummy");
  assert.equal(verifiedKernelOutput(kernel,good),good);
  assert.throws(()=>verifiedKernelOutput(kernel,join(f.root,"other","fde-semantic")) ,/untrusted-compiler-output/);
  assert.throws(()=>verifiedKernelOutput(kernel,join(dir,"wrong.exe")) ,/untrusted-compiler-output/);
});
test("WP04 destination cannot overwrite the project or a prior candidate",t=>{
  const f=fixture(t),project=join(f.root,"project");mkdirSync(project);
  const proposed=join(f.root,"candidate");
  assert.equal(checkedDestination(project,proposed),proposed);
  assert.throws(()=>checkedDestination(project,project),/output-inside-project/);
  assert.throws(()=>checkedDestination(project,join(project,"new")),/output-inside-project/);
  mkdirSync(proposed);assert.throws(()=>checkedDestination(project,proposed),/output-exists/);
});
test("WP05 source identity detects Haskell source drift",t=>{
  const f=fixture(t),kernel=join(f.root,"kernel");
  for(const dir of ["app","src","test"])mkdirSync(join(kernel,dir),{recursive:true});
  writeFileSync(join(kernel,"fde-semantic.cabal"),"name:fde");
  writeFileSync(join(kernel,"src","Main.hs"),"main = return ()");
  const first=kernelSourceDigest(f.root);
  writeFileSync(join(kernel,"src","Main.hs"),"main = print 1");
  assert.notEqual(kernelSourceDigest(f.root).digest,first.digest);
});
