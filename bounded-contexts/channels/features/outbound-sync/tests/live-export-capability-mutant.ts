import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "@chase-sets/typescript-compiler-api";
import * as postgres from "@chase-sets/event-core-postgres";
import * as storage from "@chase-sets/event-core/storage";
import * as admission from "../domain/admission";
import * as contracts from "../domain/contracts";
import * as validation from "../domain/validation";
import * as digest from "../api/payload-digest";
import * as orderPull from "../api/order-pull";
import * as liveExport from "../api/live-export";

/** In-memory bypass only: the candidate file and database authority are never rewritten. */
export function capabilityIgnoredStore(): typeof import("../api/store").createOutboundOperationStore {
  const source = readFileSync(new URL("../api/store.ts", import.meta.url), "utf8");
  const anchor = 'capabilities.includes("tcgplayer-live-export")';
  if (source.split(anchor).length !== 2) throw new Error("live-export-capability-mutant-anchor-moved");
  const dependencies: Record<string, unknown> = {
    "node:crypto": crypto,
    "@chase-sets/event-core-postgres": postgres,
    "@chase-sets/event-core/storage": storage,
    "../domain/admission": admission,
    "../domain/contracts": contracts,
    "../domain/validation": validation,
    "./payload-digest": digest,
    "./order-pull": orderPull,
    "./live-export": liveExport,
  };
  const exports: Partial<typeof import("../api/store")> = {};
  runInNewContext(
    ts.transpileModule(source.replace(anchor, "true"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports,
      require: (specifier: string) => {
        if (!Object.hasOwn(dependencies, specifier)) throw new Error(`live-export-mutant-import-unbound: ${specifier}`);
        return dependencies[specifier];
      },
    },
  );
  if (!exports.createOutboundOperationStore) throw new Error("live-export-mutant-export-missing");
  return exports.createOutboundOperationStore;
}
