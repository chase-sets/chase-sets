import { describe, expect, it, vi } from "vitest";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createWalletRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_seller" as never,
  },
};

describe("settlement wallet runtime clearance policy", () => {
  it("resolves the compiled default clearance policy when no policies runtime is wired", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const wallets = createWalletRuntime({
      eventStore: {} as never,
      checkpointStore: {} as never,
      db: { query } as never,
    });

    await wallets.releaseMaturePendingSaleCredits({ now: "2026-05-27T00:00:00.000Z" }, context);

    expect(query).toHaveBeenCalledWith(expect.any(String), ["2026-05-27T00:00:00.000Z", 2, 7, "250.00", 250]);
  });

  it("resolves the revised clearance policy from the injected platform-policy runtime", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const resolvePolicy = vi.fn(async () => ({
      policyKey: "settlement.clearance-window",
      value: { baseClearanceDays: 1, extendedClearanceDays: 3, highValueThresholdAmount: "500.00" },
      source: "policy" as const,
      documentId: "pol_1",
      effectiveFrom: "2026-05-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-05-27T00:00:00.000Z",
    }));
    const wallets = createWalletRuntime({
      eventStore: {} as never,
      checkpointStore: {} as never,
      db: { query } as never,
      policies: { resolvePolicy } as unknown as Pick<PolicyRuntime, "resolvePolicy">,
    });

    await wallets.releaseMaturePendingSaleCredits({ now: "2026-05-27T00:00:00.000Z" }, context);

    expect(resolvePolicy).toHaveBeenCalledWith(expect.objectContaining({ policyKey: "settlement.clearance-window" }), {
      at: "2026-05-27T00:00:00.000Z",
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), ["2026-05-27T00:00:00.000Z", 1, 3, "500.00", 250]);
  });
});
