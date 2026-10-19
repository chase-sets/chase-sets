import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import * as contracts from "../domain/contracts";
import * as composition from "../domain/composition";
import { assertChannelSyncRunSettlement } from "../domain/lifecycle";

export function readbackLaw() {
  const mutant = process.env.CHASE_SETS_READBACK_MUTANT;
  if (!mutant) return assertChannelSyncRunSettlement;
  const edits: Record<string, readonly (readonly [string, string])[]> = {
    "summary-only-applied": [
      [
        "const verdict = settlement.stagedReadback;",
        'if (settlement.toState === "applied" && settlement.importSummary !== null) return;\n  const verdict = settlement.stagedReadback;',
      ],
    ],
    "connector-snapshot-bypass": [
      ['if (run.claimant.claimantKind === "connector" && snapshot) refuseSettlement();', ""],
    ],
    "manual-readback-bypass": [["if (verdict !== null) refuseSettlement();", ""]],
    "re-verify-unknown": [
      [
        'if (isChannelSyncRunTerminalState(run.state)) throw new ChannelSyncRunError("terminal");',
        'if (run.state === "application-unknown") run = { ...run, state: "awaiting-verification" };\n  if (isChannelSyncRunTerminalState(run.state)) throw new ChannelSyncRunError("terminal");',
      ],
    ],
  };
  const selected = edits[mutant];
  if (!selected) throw new Error(`unknown-readback-mutant: ${mutant}`);
  let source = readFileSync(new URL("../domain/lifecycle.ts", import.meta.url), "utf8");
  for (const [before, after] of selected) {
    if (source.split(before).length !== 2) throw new Error(`readback-mutant-anchor-moved: ${mutant}`);
    source = source.replace(before, after);
  }
  const exports: Partial<typeof import("../domain/lifecycle")> = {};
  const dependencies: Record<string, unknown> = { "./contracts": contracts, "./composition": composition };
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports,
      require: (name: string) => {
        if (!Object.hasOwn(dependencies, name)) throw new Error(`readback-mutant-import-unbound: ${name}`);
        return dependencies[name];
      },
    },
  );
  if (!exports.assertChannelSyncRunSettlement) throw new Error("readback-mutant-export-missing");
  return exports.assertChannelSyncRunSettlement;
}
