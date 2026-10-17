import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import * as contract from "../domain/connector-background-contract";
import * as custody from "../domain/extension-credential-custody";
import * as records from "../domain/extension-records";
import * as pairing from "../domain/connector-pairing";
import * as identity from "../domain/identity";
import type { createConnectorBackground } from "../domain/connector-background";

export function mutatedBackground(
  kind: "unconditional-reensure" | "unserialized" | "suppressed-retention-retry",
): typeof createConnectorBackground {
  let source = readFileSync(new URL("../domain/connector-background.ts", import.meta.url), "utf8");
  const replace = (before: string, after: string) => {
    if (source.split(before).length !== 2) throw new Error("background-mutant-anchor-moved");
    source = source.replace(before, after);
  };
  if (kind === "unconditional-reensure")
    replace(
      "await coordinate(reason);",
      "await ports.alarms.create(workAlarm, { periodInMinutes: 0.5 });\n    await coordinate(reason);",
    );
  else if (kind === "suppressed-retention-retry") {
    replace(
      'await retention(result.nextDeadline, !result.ok, reason === "boot" && result.ok);',
      'if (!(reason === "boot" && await ports.alarms.get(retentionAlarm))) await retention(result.nextDeadline, !result.ok);',
    );
  } else {
    replace(
      'async function startWorker(reason: "boot" | "update") {\n    await serial(async () => {',
      'async function startWorker(reason: "boot" | "update") {\n    await (async () => {',
    );
    replace("    });\n    await coordinate(reason);", "    })();\n    await coordinate(reason);");
  }
  const dependencies: Record<string, unknown> = {
    "./connector-background-contract": contract,
    "./extension-credential-custody": custody,
    "./extension-records": records,
    "./connector-pairing": pairing,
    "./identity": identity,
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
      .outputText,
    {
      exports,
      URL,
      Request,
      Response,
      Date,
      setTimeout,
      clearTimeout,
      require: (name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error("mutant-import-unbound");
        return dependencies[name];
      },
    },
  );
  if (typeof exports.createConnectorBackground !== "function") throw new Error("mutant-export-missing");
  return exports.createConnectorBackground as typeof createConnectorBackground;
}
