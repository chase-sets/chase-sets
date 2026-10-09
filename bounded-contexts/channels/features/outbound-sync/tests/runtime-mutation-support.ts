import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import * as postgres from "@chase-sets/event-core-postgres";
import * as admission from "../domain/admission";
import * as policy from "../domain/policy";
import * as rejection from "../domain/rejection";
import * as contracts from "../domain/contracts";
import * as orderPullContract from "../domain/order-pull";
import * as validation from "../domain/validation";
import * as subjectOutcomeValidation from "../domain/subject-outcome-validation";
import * as orderPull from "../api/order-pull";
import * as store from "../api/store";

export type SettlementMutant = "omission-guard" | "receipt-identity" | "transaction-split";

// Evaluate one exact source edit in memory, with the real imported dependencies.
// No product file or database fact is rewritten to manufacture a mutant result.
export function mutatedOutboundRuntime(
  mutant: SettlementMutant,
): typeof import("../api/runtime").createOutboundSyncRuntime {
  const source = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
  const edits: Record<SettlementMutant, readonly [string, string]> = {
    "omission-guard": ['if (boundRun && boundRun.state !== "terminal" && !input.runSettlement)', "if (false)"],
    "receipt-identity": [
      "canonicalJson(receipt.run_settlement) !== canonicalJson(settlementReceiptRunIdentity(runSettlement))",
      "false",
    ],
    "transaction-split": [
      "await port!.settleBoundRun(db, {",
      'await db.query("COMMIT");\n          await port!.settleBoundRun(db, {',
    ],
  };
  const [before, after] = edits[mutant];
  if (source.split(before).length !== 2) throw new Error(`settlement-mutant-anchor-moved: ${mutant}`);
  const dependencies: Record<string, unknown> = {
    "node:crypto": crypto,
    "@chase-sets/event-core-postgres": postgres,
    "../domain/admission": admission,
    "../domain/policy": policy,
    "../domain/rejection": rejection,
    "../domain/contracts": contracts,
    "../domain/order-pull": orderPullContract,
    "../domain/validation": validation,
    "../domain/subject-outcome-validation": subjectOutcomeValidation,
    "./order-pull": orderPull,
    "./store": store,
  };
  const exports: Partial<typeof import("../api/runtime")> = {};
  runInNewContext(
    ts.transpileModule(source.replace(before, after), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports,
      require: (specifier: string) => {
        if (!Object.hasOwn(dependencies, specifier)) throw new Error(`settlement-mutant-import-unbound: ${specifier}`);
        return dependencies[specifier];
      },
    },
  );
  if (!exports.createOutboundSyncRuntime) throw new Error("settlement-mutant-export-missing");
  return exports.createOutboundSyncRuntime;
}
