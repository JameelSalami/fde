/** Owner-provisioned, finite source-read policy. Request bodies cannot provision it. */
import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync} from "node:fs";
import {dirname,resolve} from "node:path";
import {detach,object,parseStrictJson} from "./json.js";
import {ReviewError} from "./review-store.js";
import type {WorkbenchSourceGrant} from "./web/workbench.js";

function refused():never{throw new ReviewError(503,"workbench-source-policy-refused");}
function timestamp(raw:unknown):number{
  if(typeof raw!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw))return refused();
  const time=Date.parse(raw);if(!Number.isFinite(time)||new Date(time).toISOString().replace(".000Z","Z")!==raw.replace(".000Z","Z"))return refused();return time;
}
export function admitWorkbenchSourcePolicy(raw:unknown):readonly WorkbenchSourceGrant[]{
  try{
    const p=object(detach(raw),["schema","grants"],"workbench source policy");
    if(p.schema!=="fde.workbench-source-policy/v1"||!Array.isArray(p.grants)||p.grants.length>32)return refused();
    return Object.freeze(p.grants.map(rawGrant=>{
      const g=object(rawGrant,["sourceId","principals","action","validFrom","validUntil","revoked"],"workbench grant");
      if(g.sourceId!=="w1-observations"||g.action!=="read-pinned-w1"||!Array.isArray(g.principals)||g.principals.length<1||g.principals.length>16||typeof g.revoked!=="boolean")return refused();
      const seen=new Set<string>();for(const principal of g.principals){if(typeof principal!=="string"||!/^[a-z][a-z0-9_-]{0,47}$/.test(principal)||seen.has(principal))return refused();seen.add(principal);}
      if(timestamp(g.validUntil)<=timestamp(g.validFrom))return refused();
      return Object.freeze({sourceId:"w1-observations",principals:Object.freeze([...seen]),action:"read-pinned-w1" as const,validFrom:String(g.validFrom),validUntil:String(g.validUntil),revoked:g.revoked});
    }));
  }catch(error){if(error instanceof ReviewError)throw error;return refused();}
}
export function readWorkbenchSourcePolicy(path:string):readonly WorkbenchSourceGrant[]{
  let fd:number|undefined;
  try{
    const absolute=resolve(path),parent=dirname(absolute),directory=lstatSync(parent);
    if(directory.isSymbolicLink()||!directory.isDirectory()||realpathSync(parent)!==parent||(directory.mode&0o077)!==0||(process.getuid&&directory.uid!==process.getuid()))return refused();
    const file=lstatSync(absolute);if(file.isSymbolicLink()||!file.isFile()||realpathSync(absolute)!==absolute||(file.mode&0o077)!==0||(process.getuid&&file.uid!==process.getuid()))return refused();
    fd=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==file.dev||opened.ino!==file.ino||(opened.mode&0o077)!==0||(process.getuid&&opened.uid!==process.getuid())||opened.size>32768)return refused();
    const bytes=readFileSync(fd);if(bytes.byteLength>32768)return refused();
    return admitWorkbenchSourcePolicy(parseStrictJson(bytes.toString("utf8")));
  }catch(error){if(error instanceof ReviewError)throw error;return refused();}
  finally{if(fd!==undefined)closeSync(fd);}
}
