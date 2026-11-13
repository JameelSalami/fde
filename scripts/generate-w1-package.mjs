#!/usr/bin/env node
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {resolve,dirname} from "node:path";
import {compileOperationalPackage,renderOperationalPackageArtifacts} from "../dist/src/package.js";

const check=process.argv.includes("--check");
const omitPrivateMarkdown=process.argv.includes("--omit-private-markdown");
const root=resolve(import.meta.dirname,"..");
const source=await readFile(resolve(root,"spec/w1-review.ec.yaml"),"utf8");
const ir=compileOperationalPackage(source);
const rendered=renderOperationalPackageArtifacts(ir);
const mismatches=[];
for(const file of rendered.files){
  // Source-only public releases exclude ALL .md content. The semantic
  // package still renders its documentation in memory for contract tests.
  if(omitPrivateMarkdown&&/\.(?:md|mdx|markdown)$/i.test(file.path))continue;
  const target=resolve(root,"generated/w1-package",file.path);
  if(check){
    try{if(await readFile(target,"utf8")!==file.content)mismatches.push(file.path);}
    catch{mismatches.push(file.path);}
  }else{
    await mkdir(dirname(target),{recursive:true});
    await writeFile(target,file.content,"utf8");
  }
}
if(check&&mismatches.length){
  console.error("Generated W1 package artifacts stale: "+mismatches.sort().join(", "));
  process.exitCode=1;
}else if(check)console.log("Generated W1 package artifacts current.");
else console.log("Generated W1 package artifacts written.");
