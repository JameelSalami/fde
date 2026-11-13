#!/usr/bin/env node
// Opt-in, offline candidate builder; does not install, activate or qualify an FDE release.
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,readdirSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const hex64=/^[a-f0-9]{64}$/;
const checksum=bytes=>createHash("sha256").update(bytes).digest("hex");
const exact=(value,names)=>value!==null&&typeof value==="object"&&!Array.isArray(value)&&
  Object.keys(value).sort().join("\n")===names.slice().sort().join("\n");
function deny(reason){throw Error("portable-toolchain-refused: "+reason);}
function pathsFor(platform){return platform==="win32"?path.win32:platform==="linux"?path.posix:null;}
function absolute(value,platform){
  const p=pathsFor(platform);
  if(!p||typeof value!=="string"||value.length>2048||value.includes("\0")||
     !p.isAbsolute(value)||p.normalize(value)!==value)deny("noncanonical-absolute-path");
  return value;
}
function fileSpec(value,platform){
  if(!exact(value,["path","sha256"])||!hex64.test(value.sha256))deny("tool-identity");
  return Object.freeze({path:absolute(value.path,platform),sha256:value.sha256});
}
export function admitPortableToolchain(raw,platform=process.platform,arch=process.arch){
  if(!exact(raw,["schema","targetPlatform","targetArch","ghc","cabal","store","scratch"])||
     raw.schema!=="fde.portable-toolchain/v1"||raw.targetPlatform!==platform||
     raw.targetArch!==arch||!["linux","win32"].includes(platform)||arch!=="x64")deny("platform-or-shape");
  const ghc=fileSpec(raw.ghc,platform),cabal=fileSpec(raw.cabal,platform);
  if(ghc.path===cabal.path)deny("tool-collision");
  return Object.freeze({schema:raw.schema,targetPlatform:platform,targetArch:arch,
    ghc,cabal,store:absolute(raw.store,platform),scratch:absolute(raw.scratch,platform)});
}
function inspectedFile(file){
  const st=lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>256*1024*1024)deny("unsafe-file");
  const bytes=readFileSync(file);
  if(bytes.byteLength!==st.size)deny("changed-file");
  return checksum(bytes);
}
export function verifyPortableToolchain(profile){
  for(const item of [profile.ghc,profile.cabal]){
    if(realpathSync(item.path)!==item.path||inspectedFile(item.path)!==item.sha256)deny("tool-drift");
  }
  for(const dir of [profile.store,profile.scratch]){
    const st=lstatSync(dir);
    if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(dir)!==dir)deny("untrusted-directory");
  }
  return Object.freeze({ghc:profile.ghc.sha256,cabal:profile.cabal.sha256});
}
export function verifiedKernelOutput(kernel,reported,platform=process.platform){
  const p=pathsFor(platform);
  if(!p)deny("unsupported-platform");
  const file=absolute(reported,platform);
  const rel=p.relative(kernel,file),bits=rel.split(p.sep);
  if(rel===""||p.isAbsolute(rel)||bits[0]!=="dist-newstyle"||bits.includes("..")||
     p.basename(file)!==(platform==="win32"?"fde-semantic.exe":"fde-semantic"))
    deny("untrusted-compiler-output");
  if(platform===process.platform&&realpathSync(file)!==file)deny("output-symlink");
  return file;
}
export function checkedDestination(project,output,platform=process.platform){
  const p=pathsFor(platform);if(!p)deny("unsupported-platform");
  const dir=absolute(output,platform),rel=p.relative(project,dir);
  if(rel===""||(!rel.startsWith(".."+p.sep)&&rel!==".."&&!p.isAbsolute(rel)))
    deny("output-inside-project");
  if(existsSync(dir))deny("output-exists");
  const parent=p.dirname(dir),st=lstatSync(parent);
  if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(parent)!==parent)deny("output-parent");
  return dir;
}
export function kernelSourceDigest(project){
  const kernel=path.join(project,"kernel"),files=[];
  function add(rel){
    const full=path.join(kernel,rel),st=lstatSync(full);
    if(st.isSymbolicLink())deny("source-symlink");
    if(st.isDirectory()){for(const name of readdirSync(full).sort())add(path.join(rel,name));}
    else if(st.isFile()&&st.size<=1024*1024)files.push([rel.replaceAll("\\","/"),checksum(readFileSync(full))]);
    else deny("source-file");
  }
  for(const entry of ["fde-semantic.cabal","app","src","test"])add(entry);
  return Object.freeze({digest:checksum(JSON.stringify(files)),files:files.length});
}
function buildEnv(profile){
  const env={};
  for(const key of ["PATH","HOME","USERPROFILE","SystemRoot","ComSpec","TEMP","TMP",
    "INCLUDE","LIB","LIBPATH","MSYSTEM","MINGW_PREFIX","CC","CXX","AR","LD","LIBRARY_PATH","PKG_CONFIG_PATH"]){
    if(process.env[key]!==undefined)env[key]=process.env[key];
  }
  env.PATH=path.dirname(profile.cabal.path)+path.delimiter+(env.PATH??"");
  env.TMPDIR=profile.scratch;
  return env;
}
function runCabal(profile,parts,root){
  const result=spawnSync(profile.cabal.path,["--store-dir="+profile.store,...parts],{
    cwd:root,encoding:"utf8",timeout:120000,maxBuffer:4*1024*1024,shell:false,env:buildEnv(profile)
  });
  if(result.error||result.status!==0||result.signal!==null)deny("cabal-failed");
  return result.stdout.trim();
}
export function buildOfflineCandidate({profilePath,outputDir,projectRoot}){
  if(process.versions.node.split(".")[0]!=="22")deny("node22-required");
  if(process.platform!=="win32"&&process.platform!=="linux")deny("unsupported-platform");
  const input=absolute(profilePath,process.platform);
  if(realpathSync(input)!==input)deny("profile-path");
  const st=lstatSync(input);
  if(!st.isFile()||st.isSymbolicLink()||st.size>8192)deny("profile-file");
  const profile=admitPortableToolchain(JSON.parse(readFileSync(input,"utf8")));
  const project=realpathSync(projectRoot),kernel=path.join(project,"kernel");
  const destination=checkedDestination(project,outputDir);
  const source=kernelSourceDigest(project),verified=verifyPortableToolchain(profile);
  runCabal(profile,["v2-build","exe:fde-semantic","--offline","--with-compiler="+profile.ghc.path,"-j2"],kernel);
  const found=verifiedKernelOutput(kernel,runCabal(profile,["list-bin","exe:fde-semantic","--offline","--with-compiler="+profile.ghc.path],kernel));
  verifyPortableToolchain(profile);
  const digest=inspectedFile(found);
  mkdirSync(destination,{recursive:false});
  const file=path.join(destination,process.platform==="win32"?"fde-semantic.exe":"fde-semantic");
  copyFileSync(found,file,constants.COPYFILE_EXCL);
  if(inspectedFile(file)!==digest)deny("copied-output-drift");
  return Object.freeze({schema:"fde.portable-build-candidate/v1",authority:"none",effects:["new-output-directory"],
    targetPlatform:profile.targetPlatform,targetArch:profile.targetArch,sourceDigest:source.digest,
    sourceFiles:source.files,toolchain:verified,artifactSha256:digest,artifact:file,
    installed:false,released:false,verifiedDomainSemantics:false});
}
const self=fileURLToPath(import.meta.url);
if(process.argv[1]&&path.resolve(process.argv[1])===self){
  try{
    if(process.argv.length!==6||process.argv[2]!=="--profile"||process.argv[4]!=="--output")
      deny("usage: --profile ABSOLUTE_JSON --output NEW_ABSOLUTE_DIRECTORY");
    process.stdout.write(JSON.stringify(buildOfflineCandidate({
      profilePath:process.argv[3],outputDir:process.argv[5],
      projectRoot:path.resolve(path.dirname(self),"..")}))+"\n");
  }catch(error){process.stderr.write(String(error)+"\n");process.exitCode=1;}
}
