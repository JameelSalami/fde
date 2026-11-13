/** Bounded RFC 7617 lab authentication. Transport is loopback inside SSH.
 * This file is not an identity provider; the deployment owner provisions roles.
 * Passwords never enter application state, logs, API responses or evidence.
 */
import {scrypt,randomBytes,timingSafeEqual} from "node:crypto";
import {lstat,readFile,realpath} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import type {IncomingMessage} from "node:http";
import {object,parseStrictJson} from "../json.js";

export type AppRole="viewer"|"reviewer"|"operator";
export interface Principal {readonly id:string;readonly role:AppRole}
export interface AuthUser extends Principal {readonly salt:string;readonly digest:string}
export interface AuthConfig {readonly schema:"fde.lab-auth/v1";readonly users:readonly AuthUser[]}
export const userIdPattern=/^[a-z][a-z0-9_-]{0,47}$/;
const roles=new Set(["viewer","reviewer","operator"]);
const derive=(password:string,salt:string):Promise<Buffer>=>new Promise((resolve,reject)=>
  scrypt(password,Buffer.from(salt,"hex"),32,{N:32768,r:8,p:1,maxmem:67108864},
    (error,key)=>error?reject(error):resolve(key)));

export async function makeAuthUser(id:string,role:AppRole,password:string):Promise<AuthUser>{
  if(!userIdPattern.test(id)||!roles.has(role)||password.length<24||password.length>256)
    throw Error("invalid-auth-provisioning");
  const salt=randomBytes(16).toString("hex");
  return {id,role,salt,digest:(await derive(password,salt)).toString("hex")};
}
export function admitAuthConfig(raw:unknown):AuthConfig {
  const c=object(raw,["schema","users"],"auth");
  if(c.schema!=="fde.lab-auth/v1"||!Array.isArray(c.users)||c.users.length<1||c.users.length>16)
    throw Error("invalid-auth-configuration");
  const seen=new Set<string>();
  const users=c.users.map(rawUser=>{
    const u=object(rawUser,["id","role","salt","digest"],"auth user");
    if(typeof u.id!=="string"||!userIdPattern.test(u.id)||seen.has(u.id)||
       typeof u.role!=="string"||!roles.has(u.role)||
       typeof u.salt!=="string"||!/^[a-f0-9]{32}$/.test(u.salt)||
       typeof u.digest!=="string"||!/^[a-f0-9]{64}$/.test(u.digest))
      throw Error("invalid-auth-configuration");
    seen.add(u.id);
    return Object.freeze({id:u.id,role:u.role as AppRole,salt:u.salt,digest:u.digest});
  });
  return Object.freeze({schema:"fde.lab-auth/v1",users:Object.freeze(users)});
}
export async function readAuthConfig(path:string):Promise<AuthConfig>{
  for(const [file,directory] of [[path,false],[dirname(path),true]] as const){
    const st=await lstat(file);
    if(st.isSymbolicLink()||await realpath(file)!==resolve(file)||(directory?!st.isDirectory():!st.isFile())||
       (st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))
      throw Error("auth-custody-refused");
  }
  const raw=await readFile(path,"utf8");
  if(Buffer.byteLength(raw)>32768)throw Error("auth-budget");
  return admitAuthConfig(parseStrictJson(raw));
}
export function createAuthenticator(config:AuthConfig){
  const users=new Map(config.users.map(u=>[u.id,u]));
  const dummy={salt:randomBytes(16).toString("hex"),digest:randomBytes(32).toString("hex")};
  let inFlight=0;
  let windowStart=Date.now(),attempts=0;
  return async(req:IncomingMessage):Promise<Principal|null>=>{
    // Duplicate Authorization headers are ambiguous and always refused.
    const count=req.rawHeaders.filter((v,i)=>i%2===0&&v.toLowerCase()==="authorization").length;
    const value=req.headers.authorization;
    if(count!==1||typeof value!=="string"||value.length>1024||
       !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(value))return null;
    if(Date.now()-windowStart>=60000){windowStart=Date.now();attempts=0;}
    if(++attempts>600||inFlight>=4)return null;
    const token=value.slice(6),bytes=Buffer.from(token,"base64");
    if(bytes.toString("base64")!==token)return null;
    const decoded=bytes.toString("utf8"),colon=decoded.indexOf(":");
    if(colon<1||Buffer.from(decoded,"utf8").compare(bytes)!==0)return null;
    const id=decoded.slice(0,colon),password=decoded.slice(colon+1);
    if(!userIdPattern.test(id)||password.length<1||password.length>256||/[\x00-\x1f\x7f]/.test(password))return null;
    const user=users.get(id),material=user??dummy;
    inFlight++;
    try{
      const calculated=await derive(password,material.salt);
      if(!timingSafeEqual(calculated,Buffer.from(material.digest,"hex"))||!user)return null;
      return Object.freeze({id:user.id,role:user.role});
    }finally{inFlight--;}
  };
}
