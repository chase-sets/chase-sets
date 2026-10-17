import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createWalletRuntime, type WalletServices } from "./runtime";

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

describe("seller capture credit atomicity and legacy convergence", () => {
  const credit: Parameters<WalletServices["creditSellerCapture"]>[0] = {
    accountId: "acc_seller" as never,
    kind: "sale",
    amount: "20.00",
    currencyCode: "usd",
    paymentId: "pay_1" as never,
    orderId: "ord_1" as never,
    postedAt: "2026-05-01T00:00:00.000Z",
  };
  const baseId = "led_sale_pay_1_ord_1";
  const pendingId = `${baseId}_pending`;
  type Leg = Partial<Parameters<WalletServices["postEntry"]>[0]> & { ledgerEntryId: string; amount: string };
  function setup() {
    const store = createInMemoryEventStore();
    const wallets = createWalletRuntime({
      eventStore: store.eventStore,
      checkpointStore: {} as never,
      db: { query: async () => ({ rows: [] }) },
    });
    return { store, wallets };
  }
  async function seed(wallets: WalletServices, legs: readonly Leg[]) {
    for (const leg of legs) {
      await wallets.postEntry(
        { ...credit, direction: "credit", fundsStatus: "pending", ...leg, ledgerEntryId: leg.ledgerEntryId as never },
        context,
      );
    }
  }
  const complete: readonly [string, readonly Leg[]][] = [
    ["base pending full", [{ ledgerEntryId: baseId, amount: "20.00" }]],
    ["base available full", [{ ledgerEntryId: baseId, amount: "20.00", fundsStatus: "available" }]],
    [
      "base offset and pending remainder",
      [
        { ledgerEntryId: baseId, amount: "15.00", fundsStatus: "available" },
        { ledgerEntryId: pendingId, amount: "5.00" },
      ],
    ],
  ];
  it.each(complete)("recognizes legacy %s without new money, including after release", async (_name, legs) => {
    const { wallets, store } = setup();
    await seed(wallets, legs);
    await wallets.creditSellerCapture(credit, context);
    for (const leg of legs.filter((leg) => leg.fundsStatus !== "available")) {
      await wallets.releasePendingEntry(
        { accountId: credit.accountId, ledgerEntryId: leg.ledgerEntryId as never },
        context,
      );
    }
    const before = store.readAllEvents();
    await wallets.creditSellerCapture(credit, context);
    expect(store.readAllEvents()).toEqual(before);
    expect((await wallets.loadWalletState(credit.accountId)).totalCreditedAmount).toBe("20.00");
  });
  const incomplete: readonly [string, readonly Leg[]][] = [
    ["missing base", [{ ledgerEntryId: pendingId, amount: "5.00" }]],
    ["missing remainder", [{ ledgerEntryId: baseId, amount: "15.00", fundsStatus: "available" }]],
    ["wrong full amount", [{ ledgerEntryId: baseId, amount: "19.99" }]],
    [
      "wrong split total",
      [
        { ledgerEntryId: baseId, amount: "15.00", fundsStatus: "available" },
        { ledgerEntryId: pendingId, amount: "5.01" },
      ],
    ],
    [
      "two pending legs",
      [
        { ledgerEntryId: baseId, amount: "15.00" },
        { ledgerEntryId: pendingId, amount: "5.00" },
      ],
    ],
    [
      "two available legs",
      [
        { ledgerEntryId: baseId, amount: "15.00", fundsStatus: "available" },
        { ledgerEntryId: pendingId, amount: "5.00", fundsStatus: "available" },
      ],
    ],
    ["wrong order", [{ ledgerEntryId: baseId, amount: "20.00", orderId: "ord_other" as never }]],
    ["wrong payment", [{ ledgerEntryId: baseId, amount: "20.00", paymentId: "pay_other" as never }]],
    ["wrong kind", [{ ledgerEntryId: baseId, amount: "20.00", kind: "rebate" }]],
    ["wrong direction", [{ ledgerEntryId: baseId, amount: "20.00", direction: "debit" }]],
    ["unexpected payout", [{ ledgerEntryId: baseId, amount: "20.00", payoutId: "payout_other" as never }]],
    [
      "extra remainder",
      [
        { ledgerEntryId: baseId, amount: "20.00" },
        { ledgerEntryId: pendingId, amount: "5.00" },
      ],
    ],
  ];
  it.each(incomplete)("refuses legacy %s with operator attention and no additional money", async (_name, legs) => {
    const { wallets, store } = setup();
    await seed(wallets, legs);
    const before = store.readAllEvents();
    await expect(wallets.creditSellerCapture(credit, context)).rejects.toThrow("operator review required");
    expect(store.readAllEvents()).toEqual(before);
  });
  it.each(["sale", "rebate"] as const)("preserves exact cents, zero and full offsets for %s", async (kind) => {
    const { wallets, store } = setup();
    await wallets.ensureWallet({ accountId: credit.accountId }, context);
    const empty = store.readAllEvents();
    await wallets.creditSellerCapture({ ...credit, kind, amount: "0.00" }, context);
    expect(store.readAllEvents()).toEqual(empty);
    await seed(wallets, [
      {
        ledgerEntryId: "led_debit",
        amount: "0.02",
        direction: "debit",
        fundsStatus: "available",
        allowNegativeBalance: true,
      },
    ]);
    await wallets.creditSellerCapture({ ...credit, kind, amount: "0.01" }, context);
    const first = await wallets.loadWalletState(credit.accountId);
    expect(first.entries.at(-1)).toMatchObject({ amount: "0.01", kind, currencyCode: "usd", fundsStatus: "available" });
    await wallets.creditSellerCapture({ ...credit, kind, paymentId: "pay_2" as never, amount: "0.02" }, context);
    const state = await wallets.loadWalletState(credit.accountId);
    expect(state.totalCreditedAmount).toBe("0.03");
    expect(state.availableBalanceAmount).toBe("0.00");
    expect(state.pendingBalanceAmount).toBe("0.01");
    const before = store.readAllEvents();
    await expect(wallets.creditSellerCapture({ ...credit, kind, amount: "0.00" }, context)).rejects.toThrow(
      "operator review required",
    );
    await expect(wallets.creditSellerCapture({ ...credit, currencyCode: "eur" as never }, context)).rejects.toThrow();
    expect(store.readAllEvents()).toEqual(before);
  });
  it("converges concurrent duplicates and different credits against authoritative negative balance", async () => {
    const { wallets } = setup();
    await seed(wallets, [
      {
        ledgerEntryId: "led_debit",
        amount: "25.00",
        direction: "debit",
        fundsStatus: "available",
        allowNegativeBalance: true,
      },
    ]);
    await Promise.all([
      wallets.creditSellerCapture(credit, context),
      wallets.creditSellerCapture(credit, context),
      wallets.creditSellerCapture({ ...credit, paymentId: "pay_2" as never }, context),
    ]);
    const state = await wallets.loadWalletState(credit.accountId);
    expect(state.totalCreditedAmount).toBe("40.00");
    expect(state.pendingBalanceAmount).toBe("15.00");
    expect(state.availableBalanceAmount).toBe("0.00");
    expect(new Set(state.entries.map((entry) => entry.ledgerEntryId)).size).toBe(state.entries.length);
  });
  it("appends both legs together and retries after an append failure without half-credit", async () => {
    const { wallets, store } = setup();
    await seed(wallets, [
      {
        ledgerEntryId: "led_debit",
        amount: "15.00",
        direction: "debit",
        fundsStatus: "available",
        allowNegativeBalance: true,
      },
    ]);
    const append = vi.spyOn(store.eventStore, "appendToStream");
    append.mockRejectedValueOnce(new Error("injected atomic append failure"));
    await expect(wallets.creditSellerCapture(credit, context)).rejects.toThrow("injected atomic append failure");
    expect((await wallets.loadWalletState(credit.accountId)).totalCreditedAmount).toBe("0.00");
    expect(
      append.mock.calls[0]![0].events.filter((event) => event.eventType === "settlement.wallet.ledger-entry-posted"),
    ).toHaveLength(2);
    await wallets.creditSellerCapture(credit, context);
    expect((await wallets.loadWalletState(credit.accountId)).totalCreditedAmount).toBe("20.00");
  });

  it("recognizes a committed allocation after its acknowledgement is lost", async () => {
    const { wallets, store } = setup();
    await seed(wallets, [
      {
        ledgerEntryId: "led_debit",
        amount: "15.00",
        direction: "debit",
        fundsStatus: "available",
        allowNegativeBalance: true,
      },
    ]);
    const originalAppend = store.eventStore.appendToStream;
    vi.spyOn(store.eventStore, "appendToStream").mockImplementationOnce(async (input) => {
      await originalAppend(input);
      throw new Error("lost append acknowledgement");
    });
    await expect(wallets.creditSellerCapture(credit, context)).rejects.toThrow("lost append acknowledgement");
    const committed = store.readAllEvents();
    await wallets.creditSellerCapture(credit, context);
    expect(store.readAllEvents()).toEqual(committed);
    expect((await wallets.loadWalletState(credit.accountId)).totalCreditedAmount).toBe("20.00");
  });
});
