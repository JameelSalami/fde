#!/usr/bin/env node
/** Independent first-party synthetic fixture, never vendor data. */
import {readFileSync} from "node:fs";
import {parseStrictJson} from "../dist/src/json.js";
import {buildConnectedCase} from "../dist/src/workspace.js";
try {
  const raw=parseStrictJson(readFileSync(new URL("./workbook-fixture-input.json",import.meta.url),"utf8"));
  console.log(JSON.stringify(buildConnectedCase(raw)));
} catch {
  console.error("fixture admission refused");
  process.exitCode=2;
}
