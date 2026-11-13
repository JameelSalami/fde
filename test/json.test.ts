import test from "node:test";
import assert from "node:assert/strict";
import {parseStrictJson,detach} from "../src/index.js";

test("J01 duplicate JSON names and unsafe numeric/structural syntax refuse",()=>{
  assert.deepEqual(parseStrictJson('{"alpha":1,"beta":[true,null]}'),
    {alpha:1,beta:[true,null]});
  assert.throws(()=>parseStrictJson('{"alpha":1,"\\u0061lpha":2}'),/duplicate-key/);
  assert.throws(()=>parseStrictJson('{"a":1,"a":2}'),/duplicate-key/);
  assert.throws(()=>parseStrictJson('[1,]'),/invalid-json/);
  assert.throws(()=>parseStrictJson('{"__proto__":{"pwn":true}}'),/invalid-member/);
  assert.throws(()=>parseStrictJson('{"x":1} garbage'),/invalid-json/);
});
test("J02 invalid prototypes, sparse arrays, NaN and cycles never admitted",()=>{
  const arr=new Array(2);arr[0]=1;
  assert.throws(()=>detach(arr),/invalid-array/);
  assert.throws(()=>detach({value:Number.NaN}),/invalid-primitive/);
  const cyc:{self?:unknown}={};cyc.self=cyc;
  assert.throws(()=>detach(cyc),/invalid-cycle/);
  assert.throws(()=>detach({tooLong:"a".repeat(8193)}),/invalid-primitive/);
});
