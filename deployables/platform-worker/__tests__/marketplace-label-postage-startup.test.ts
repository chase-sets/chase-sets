import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION } from "@chase-sets/settlement/server";
import { initializeMarketplaceLabelPostageWorkerRuntime } from "../src/marketplace-label-postage-startup";

const syntheticActivation = {
  policyVersion: MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION,
  activatedAt: "2030-01-01T00:00:00.000Z",
} as const;

describe("marketplace label postage worker startup", () => {
  it("bootstraps and reads activation before constructing the worker runtime", async () => {
    const calls: string[] = [];
    const runtime = { kind: "synthetic-worker-runtime" } as const;

    await expect(
      initializeMarketplaceLabelPostageWorkerRuntime({
        bootstrapSettlementDatabase: async () => {
          calls.push("bootstrap");
        },
        activateMarketplaceLabelPostage: async () => {
          calls.push("activate-and-read");
          return syntheticActivation;
        },
        constructRuntime: (activation) => {
          calls.push(`construct:${activation.activatedAt}`);
          return runtime;
        },
      }),
    ).resolves.toBe(runtime);

    expect(calls).toEqual(["bootstrap", "activate-and-read", `construct:${syntheticActivation.activatedAt}`]);
  });

  it.each([
    ["missing", null],
    ["malformed version", { ...syntheticActivation, policyVersion: "synthetic-invalid-version" }],
    ["malformed timestamp", { ...syntheticActivation, activatedAt: "synthetic-invalid-timestamp" }],
  ])("fails closed for %s activation provenance and records the refusal", async (_case, activation) => {
    const logger = { error: vi.fn() };
    const constructRuntime = vi.fn();

    await expect(
      initializeMarketplaceLabelPostageWorkerRuntime({
        bootstrapSettlementDatabase: async () => undefined,
        activateMarketplaceLabelPostage: async () => activation,
        constructRuntime,
        logger,
      }),
    ).rejects.toThrow("Marketplace label postage activation");

    expect(constructRuntime).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "Marketplace label postage runner activation refused.",
      expect.objectContaining({ type: "settlement.marketplace_label_postage.activation_refused" }),
    );
  });

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
