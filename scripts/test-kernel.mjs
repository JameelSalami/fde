#!/usr/bin/env node
// Source-owned Haskell tests using the caller's installed compiler and Cabal.
import {spawnSync} from "node:child_process";
import {resolve,join} from "node:path";
import {homedir} from "node:os";
const root=resolve(import.meta.dirname,"..");
const ghc=process.env.FDE_GHC_PATH||"ghc";
const cabal=process.env.FDE_CABAL_PATH||"cabal";
const store=process.env.FDE_CABAL_STORE||join(homedir(),".cabal","store");
const options=[...(process.env.FDE_CABAL_OFFLINE==="1"?["--offline"]:[]),
               "--with-compiler="+ghc];
const result=spawnSync(cabal,["--store-dir="+store,"v2-test","all",
  ...options,"--test-show-details=direct"],{cwd:join(root,"kernel"),encoding:"utf8",
  timeout:900000,maxBuffer:4*1024*1024,shell:false,env:{...process.env}});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
if(result.error||result.status!==0)process.exitCode=1;
