import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import * as validation from "../../outbound-sync/domain/validation";
import * as protocol from "../domain/operation-protocol";
import * as journal from "../integrations/operation-indexeddb";
import * as database from "../integrations/connector-indexeddb";
import * as retention from "../domain/raw-export-record";

type Mutant =
  | "prepare-dispatch"
  | "report-invalid"
  | "per-member-batch-transaction"
  | "completeness-bypass"
  | "fence-removed"
  | "replay-guard";
function replace(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error(`coordinator-mutant-anchor-moved: ${before}`);
  return source.replace(before, after);
}
function evaluate(source: string, dependencies: Record<string, unknown>): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
      .outputText,
    {
      exports,
      structuredClone,
      URL,
      Request,
      Response,
      AbortSignal,
      TextEncoder,
      crypto: globalThis.crypto,
      require: (specifier: string) => {
        if (!Object.hasOwn(dependencies, specifier)) throw new Error(`coordinator-mutant-import-unbound: ${specifier}`);
        return dependencies[specifier];
      },
    },
  );
  return exports;
}
export function mutatedCoordinator(
  mutant: Mutant,
): typeof import("../domain/operation-coordinator").createConnectorOperationCoordinator {
  let source = readFileSync(new URL("../domain/operation-coordinator.ts", import.meta.url), "utf8");
  let journalModule: unknown = journal;
  if (mutant === "prepare-dispatch") source = replace(source, "if (!prepared.ready)", "if (false)");
  if (mutant === "per-member-batch-transaction")
    source = replace(
      source,
      "executors.set(executor.key, executor);",
      'executors.set(executor.key, { ...executor, unit: "operation" });',
    );
  if (mutant === "report-invalid")
    source = replace(
      source,
      "claim = await parseOperationClaim(body.reservation, input.connectionId);",
      'await request(input, "report", { reservationId: "synthetic-invalid-report", outcomes: [] });\nclaim = await parseOperationClaim(body.reservation, input.connectionId);',
    );
  if (mutant === "replay-guard")
    source = replace(
      source,
      "const executor = executors.get(reservation.executorKey);",
      `const executor = executors.get(reservation.executorKey);
    if (exact.members.some(member => member.state === "outcome-unknown")) {
      state = await write(input, state, revise(reservation, { phase: "prepared" }), exact.members.map(member => {
        const { dispatchedAt, unknownReason, receipt, ...retained } = member;
        return revise(retained, { state: "prepared" });
      }));
      reservation = state.reservations.find(row => row.reservationId === reservation.reservationId)!;
      exact = unit(state, reservation);
    }`,
    );
  if (mutant === "completeness-bypass" || mutant === "fence-removed") {
    let changed = readFileSync(new URL("../integrations/operation-indexeddb.ts", import.meta.url), "utf8");
    if (mutant === "completeness-bypass")
      changed = replace(changed, "rows.some((values, index) => counts[index] !== values.length)", "false");
    else {
      changed = replace(changed, "canonicalJson(expected) !== canonicalJson(result)", "false");
      changed = replace(changed, "prior ? row.revision !== prior.revision + 1 : row.revision !== 0", "false");
    }
    journalModule = evaluate(changed, {
      "../../outbound-sync/domain/validation": validation,
      "./connector-indexeddb": database,
      "../domain/operation-protocol": protocol,
    });
  }
  const result = evaluate(source, {
    "../../outbound-sync/domain/validation": validation,
    "./raw-export-record": retention,
    "../integrations/operation-indexeddb": journalModule,
    "./operation-protocol": protocol,
  });
  if (typeof result.createConnectorOperationCoordinator !== "function")
    throw new Error("coordinator-mutant-export-missing");
  return result.createConnectorOperationCoordinator as typeof import("../domain/operation-coordinator").createConnectorOperationCoordinator;
}
