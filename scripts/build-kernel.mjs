#!/usr/bin/env node
// Public-source compiler adapter. Local/offline builds can set FDE_CABAL_OFFLINE=1.
import {spawnSync} from "node:child_process";
import {copyFileSync,mkdirSync,chmodSync,realpathSync} from "node:fs";
import {resolve,join,isAbsolute} from "node:path";
import {homedir} from "node:os";

const root=resolve(import.meta.dirname,"..");
const kernel=join(root,"kernel");
const ghc=process.env.FDE_GHC_PATH||"ghc";
const cabal=process.env.FDE_CABAL_PATH||"cabal";
const store=process.env.FDE_CABAL_STORE||join(homedir(),".cabal","store");
const offline=process.env.FDE_CABAL_OFFLINE==="1";
function runCabal(argv){
  const cmd=["--store-dir="+store,...argv];
  const result=spawnSync(cabal,cmd,{cwd:kernel,env:{...process.env},encoding:"utf8",
    timeout:900000,maxBuffer:4*1024*1024,shell:false});
  if(result.stdout)process.stdout.write(result.stdout);
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error||result.status!==0)throw Error("Haskell build failed; supply GHC/Cabal and dependency cache");
  return result.stdout.trim();
}
const options=[...(offline?["--offline"]:[]),"--with-compiler="+ghc];
runCabal(["v2-build","exe:fde-semantic",...options,"-j2"]);
const found=runCabal(["list-bin","exe:fde-semantic",...options]);
const file=realpathSync(found);
if(!isAbsolute(file)||file===kernel||!/fde-semantic(?:\.exe)?$/.test(file))
  throw Error("Unexpected compiler artifact location");
mkdirSync(join(kernel,"bin"),{recursive:true});
copyFileSync(file,join(kernel,"bin",process.platform==="win32"?"fde-semantic.exe":"fde-semantic"));
if(process.platform!=="win32")chmodSync(join(kernel,"bin","fde-semantic"),0o755);
console.log("FDE compiled Haskell semantic kernel ready (public source profile)");
