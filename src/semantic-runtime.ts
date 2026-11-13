/** One explicit immutable host selection for all finite Haskell protocols. */
import {spawnSync,type SpawnSyncReturns} from "node:child_process";
import {readFileSync,lstatSync,openSync,closeSync,constants} from "node:fs";
import {dirname,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {readSelectedCompanyPackage,readCompanyFile,sha256,canonical,type CompanyBinding} from "./company-package.js";

const bundled=resolve(dirname(fileURLToPath(import.meta.url)),"../../kernel/bin/fde-semantic");
export class SemanticRuntime {
  private constructor(readonly executable:string,readonly sha256:string,readonly companyPackage:CompanyBinding|undefined){Object.freeze(this);}
  static bundled():SemanticRuntime{return new SemanticRuntime(bundled,sha256(readFileSync(bundled)),undefined);}
  static company(selectionPath:string,policyPath:string):SemanticRuntime{
    const selected=readSelectedCompanyPackage(selectionPath,policyPath);
    return new SemanticRuntime(selected.executable,selected.manifest.payload.artifactSha256,selected.binding);
  }
  fingerprint():string{
    const bytes=this.companyPackage?readCompanyFile(this.executable,64*1024*1024):readFileSync(this.executable);
    if(sha256(bytes)!==this.sha256)throw Error("pinned-kernel-unavailable");
    return this.sha256;
  }
  matchesPackage(binding:CompanyBinding|undefined):boolean{return canonical(binding??null)===canonical(this.companyPackage??null);}
  invoke(input:string,maxBuffer:number):SpawnSyncReturns<string>{
    this.fingerprint();
    const st=lstatSync(this.executable);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o111)===0)throw Error("semantic-executable-refused");
    const fd=openSync(this.executable,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      if(sha256(readFileSync(fd))!==this.sha256)throw Error("pinned-kernel-unavailable");
      // Linux descriptor execution prevents pathname replacement choosing a different
      // binary. Owner custody is still required against in-place concurrent writes.
      const executable=process.platform==="linux"?"/proc/self/fd/3":this.executable;
      const result=spawnSync(executable,[],{input,encoding:"utf8",shell:false,timeout:10000,maxBuffer,
        env:{PATH:"/usr/bin:/bin"},stdio:["pipe","pipe","pipe",fd]});
      this.fingerprint();
      return result;
    }finally{closeSync(fd);}
  }
}
export const bundledSemanticRuntime=():SemanticRuntime=>SemanticRuntime.bundled();
export const loadCompanySemanticRuntime=(selectionPath:string,policyPath:string):SemanticRuntime=>SemanticRuntime.company(selectionPath,policyPath);
