import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  collectRetentionSweepTargets,
  createRetentionSweepLogObserver,
  createRetentionSweepRunner,
  type RetentionSweepObserver,
  type RetentionSweepTarget,
} from "@chase-sets/platform-runtime/retention-sweep";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const SENTINEL = "SENTINEL-SHIP-TO 8592 Evergreen Terrace";

// Executes main.ts's `retentionSweep` factory with injected runtime, control pool
// and logger, then drives the real runner through a payload-bearing failure.
async function assertBoundedRetentionSweepComposition(text: string): Promise<void> {
  const source = ts.createSourceFile("main.ts", text, ts.ScriptTarget.ES2022, true);
  const factories: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "retentionSweep") {
      factories.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(factories).toHaveLength(1);
  const compiled = ts.transpileModule(`const retentionSweep = ${factories[0]!.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

  const contextPool = {
    query: vi.fn(async () => {
      throw Object.assign(new Error(`delete failed near ${SENTINEL}`), { detail: SENTINEL, code: "73301" });
    }),
  } as unknown as PgQueryable;
  const controlPool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PgQueryable;
  const runtime = {
    mountedContexts: [
      {
        contextName: "example",
        pool: contextPool,
        module: {
          schemaSql: "",
          retentionSweeps: [
            {
              name: "expired-example-rows",
              tableName: "example_rows",
              predicateSql: "candidate.expires_at < now() - interval '7 days'",
              orderBySql: "candidate.expires_at ASC",
              intervalMs: 60_000,
              batchLimit: 2,
            },
          ],
        },
      },
    ],
  } as unknown as Parameters<typeof collectRetentionSweepTargets>[0];
  const records: unknown[] = [];
  const logger = {
    info: (message: string, fields?: unknown) => records.push({ level: "info", message, fields }),
    error: (message: string, fields?: unknown) => records.push({ level: "error", message, fields }),
  };

  const composition: { targets: readonly RetentionSweepTarget[]; observer?: RetentionSweepObserver } = runInNewContext(
    `${compiled}\nretentionSweep()`,
    {
      collectRetentionSweepTargets,
      createRetentionSweepLogObserver,
      runtime,
      pools: { control: controlPool },
      logger,
    },
  );

  await createRetentionSweepRunner({
    controlPlane: {
      claimScheduledRunner: vi.fn().mockResolvedValue(true),
      recordScheduledRunnerCompleted: vi.fn().mockResolvedValue(undefined),
    },
    targets: composition.targets,
    observer: composition.observer,
  }).runOnce();

  expect(JSON.stringify(records)).not.toContain("SENTINEL-SHIP-TO");
  expect(records).toEqual([
    {
      level: "error",
      message: "Retention sweep failed; it will retry on its next interval.",
      fields: {
        type: "retention.sweep.failed",
        contextName: "example",
        sweepName: "expired-example-rows",
        tableName: "example_rows",
        errorClass: "error",
        errorCode: null,
      },
    },
  ]);
  expect(composition.targets).toEqual(collectRetentionSweepTargets(runtime, controlPool));
  expect(composition.targets).toContainEqual(expect.objectContaining({ contextName: "example", db: contextPool }));
}

function rewrite(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

describe("retention sweep worker observer wiring", () => {
  it("composes the collected targets with the bounded production observer", async () => {
    await assertBoundedRetentionSweepComposition(mainSource);
  });

  it.each([
    [
      "a parenthesized observer",
      (text: string) =>
        rewrite(
          text,
          "observer: createRetentionSweepLogObserver(logger),",
          "observer: (createRetentionSweepLogObserver(logger)),",
        ),
    ],
    [
      "reordered properties",
      (text: string) =>
        rewrite(
          text,
          `targets: collectRetentionSweepTargets(runtime, pools.control),
          observer: createRetentionSweepLogObserver(logger),`,
          `observer: createRetentionSweepLogObserver(logger),
          targets: collectRetentionSweepTargets(runtime, pools.control),`,
        ),
    ],
  ])("accepts an equivalent composition with %s", async (_label, variant) => {
    await assertBoundedRetentionSweepComposition(variant(mainSource));
  });

  it.each([
    [
      "a raw-message logging target",
      /SENTINEL-SHIP-TO/,
      (text: string) =>
        rewrite(
          text,
          "targets: collectRetentionSweepTargets(runtime, pools.control),",
          `targets: collectRetentionSweepTargets(runtime, pools.control).map((target) => ({
            ...target,
            db: { query: (...args) => target.db.query(...args).catch((error) => {
              logger.error("Retention sweep failed.", { error: error instanceof Error ? error.message : String(error) });
              throw error;
            }) },
          })),`,
        ),
    ],
    [
      "a missing observer",
      /deeply equal/,
      (text: string) => rewrite(text, "observer: createRetentionSweepLogObserver(logger),", ""),
    ],
  ])("rejects %s", async (_label, failure, mutant) => {
    await expect(assertBoundedRetentionSweepComposition(mutant(mainSource))).rejects.toThrow(failure);
  });
});
