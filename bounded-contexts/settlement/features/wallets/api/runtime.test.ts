import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
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

  it("retries a concurrent ledger posting against freshly loaded Wallet state", async () => {
    const store = createInMemoryEventStore();
    let conflictPending = true;
    const appendToStream = vi.fn(async (input: Parameters<typeof store.eventStore.appendToStream>[0]) => {
      if (
        conflictPending &&
        input.events.some((event) => event.eventType === "settlement.wallet.ledger-entry-posted")
      ) {
        conflictPending = false;
        const error = Object.assign(new Error("concurrent wallet append"), { code: "concurrency_conflict" });
        throw error;
      }
      return store.eventStore.appendToStream(input);
    });
    const wallets = createWalletRuntime({
      eventStore: { ...store.eventStore, appendToStream },
      checkpointStore: {} as never,
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
    });

    await expect(
      wallets.postEntry(
        {
          accountId: "acc_seller" as never,
          ledgerEntryId: "led_postage" as never,
          kind: "platform-purchase",
          direction: "debit",
          amount: "5.25",
          currencyCode: "usd",
          fundsStatus: "available",
          orderId: "ord_1" as never,
          postedAt: "2026-09-10T15:48:00.000Z",
          allowNegativeBalance: true,
        },
        context,
      ),
    ).resolves.toMatchObject({ entry: { ledger_entry_id: "led_postage", amount: "5.25" } });

    expect(appendToStream).toHaveBeenCalledTimes(3);
    expect(
      store.readAllEvents().filter((event) => event.eventType === "settlement.wallet.ledger-entry-posted"),
    ).toHaveLength(1);
  });
});
