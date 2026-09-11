import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION } from "@chase-sets/settlement/server";

const syntheticActivation = {
  policyVersion: MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION,
  activatedAt: "2030-01-01T00:00:00.000Z",
} as const;

describe("marketplace label postage worker startup", () => {
  async function executeMainStartupComposition(
    input: Readonly<{
      runtimeProfile: "landing" | "public";
      bootstrapContextDatabase: () => Promise<void>;
      activateMarketplaceLabelPostage: () => Promise<typeof syntheticActivation>;
      constructWorkerRuntime: (activation?: typeof syntheticActivation) => unknown;
      logger: Readonly<{
        info: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      }>;
      calls: string[];
    }>,
  ) {
    const mainSource = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    const compositionStart = mainSource.indexOf('if (config.runtimeProfile === "landing") {');
    const compositionEnd = mainSource.indexOf("\ntype WorkerIdentityServices", compositionStart);
    expect(compositionStart).toBeGreaterThan(-1);
    expect(compositionEnd).toBeGreaterThan(compositionStart);

    const compositionSource = mainSource.slice(compositionStart, compositionEnd);
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<unknown>;
    const execute = new AsyncFunction(
      "config",
      "constructWorkerRuntime",
      "runWorkerStartupDatabaseStep",
      "bootstrapContextDatabase",
      "settlementModule",
      "pools",
      "activateMarketplaceLabelPostage",
      "logger",
      `"use strict"; let runtime; ${compositionSource}; return runtime;`,
    );

    return execute(
      { runtimeProfile: input.runtimeProfile },
      input.constructWorkerRuntime,
      async (operationName: string, run: () => Promise<unknown>) => {
        input.calls.push(`step:${operationName}`);
        return run();
      },
      input.bootstrapContextDatabase,
      { kind: "synthetic-settlement-module" },
      { settlement: { kind: "synthetic-settlement-pool" } },
      input.activateMarketplaceLabelPostage,
      input.logger,
    );
  }

  it("bootstraps and reads activation before constructing the worker runtime without a success log", async () => {
    const calls: string[] = [];
    const runtime = { kind: "synthetic-worker-runtime" } as const;
    const logger = { info: vi.fn(), error: vi.fn() };

    await expect(
      executeMainStartupComposition({
        runtimeProfile: "public",
        bootstrapContextDatabase: async () => {
          calls.push("bootstrap");
        },
        activateMarketplaceLabelPostage: async () => {
          calls.push("activate");
          return syntheticActivation;
        },
        constructWorkerRuntime: (activation) => {
          if (!activation) throw new Error("Synthetic activation was not supplied.");
          calls.push(`construct:${activation.activatedAt}`);
          return runtime;
        },
        logger,
        calls,
      }),
    ).resolves.toBe(runtime);

    expect(calls).toEqual([
      "step:bootstrap Settlement database",
      "bootstrap",
      "step:activate marketplace label postage",
      "activate",
      `construct:${syntheticActivation.activatedAt}`,
    ]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed version", "malformed timestamp"])(
    "fails closed when the Settlement activation operation refuses %s provenance",
    async (reason) => {
      const calls: string[] = [];
      const logger = { info: vi.fn(), error: vi.fn() };
      const constructWorkerRuntime = vi.fn();
      const activationError = new Error(`synthetic-${reason}`);

      await expect(
        executeMainStartupComposition({
          runtimeProfile: "public",
          bootstrapContextDatabase: async () => undefined,
          activateMarketplaceLabelPostage: async () => {
            throw activationError;
          },
          constructWorkerRuntime,
          logger,
          calls,
        }),
      ).rejects.toBe(activationError);

      expect(constructWorkerRuntime).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith("Marketplace label postage runner activation refused.", {
        type: "settlement.marketplace_label_postage.activation_refused",
        error: activationError,
      });
    },
  );

  it("keeps activation creation out of bootstrap and API startup paths", async () => {
    const [mainSource, bootstrapSource, apiRuntimeSource] = await Promise.all([
      readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/bootstrap.ts", import.meta.url), "utf8"),
      readFile(new URL("../../../infrastructure/platform-runtime/api.ts", import.meta.url), "utf8"),
    ]);

    expect(mainSource.match(/activateMarketplaceLabelPostage\(/g)).toHaveLength(1);
    expect(mainSource).toContain('config.runtimeProfile === "landing"');
    expect(bootstrapSource).not.toContain("activateMarketplaceLabelPostage(");
    expect(bootstrapSource).not.toContain("createWorkerHost(");
    expect(apiRuntimeSource).not.toContain("activateMarketplaceLabelPostage(");
  });
});
