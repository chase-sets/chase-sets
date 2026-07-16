import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AccountId, PaymentId } from "@chase-sets/primitives/typed-ids";
import { addMoney } from "../../../support/runtime-support/common";
import { createWalletRuntime, type WalletServices } from "./runtime";

function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, ReturnType<typeof String>>();
  return {
    loadCheckpoint: async (name) => (checkpoints.get(name) as never) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (name, checkpoint) => {
      checkpoints.set(name, checkpoint as never);
    },
  };
}

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_buyer" as never },
};

const BUYER = "acc_buyer" as AccountId;

/** A wallet runtime backed by the shared optimistic-concurrency in-memory store. */
function createWallets(dbQuery: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>) {
  const { eventStore } = createInMemoryEventStore();
  return createWalletRuntime({
    eventStore,
    checkpointStore: createCheckpointStore(),
    db: { query: dbQuery } as never,
  });
}

async function seedAvailable(wallets: WalletServices, amount: string) {
  return wallets.postEntry(
    {
      accountId: BUYER,
      ledgerEntryId: `led_seed_${amount}` as never,
      kind: "adjustment",
      direction: "credit",
      amount,
      currencyCode: "usd",
      fundsStatus: "available",
      postedAt: "2026-04-01T00:00:00.000Z",
    },
    context,
  );
}

function isConcurrencyConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "concurrency_conflict");
}

describe("wallet spend-hold concurrency", () => {
  it("rejects a second hold that commits at a stale version (compare-and-set gate)", async () => {
    const wallets = createWallets(async () => ({ rows: [] }));
    const seed = await seedAvailable(wallets, "50.00");
    const streamId = `settlement.wallet-${BUYER}`;

    // Two checkouts that both loaded the wallet at the same version race to
    // reserve the whole $50. The event store's expected-version check lets only
    // one win; the other is a concurrency conflict -- never a second commit.
    const results = await Promise.allSettled([
      wallets.commandHandler({
        streamId,
        expectedVersion: seed.version,
        command: {
          type: "PlaceSpendHold",
          holdId: "hold_balance_credit_pay_1",
          paymentId: "pay_1" as PaymentId,
          amount: "50.00",
          currencyCode: "usd",
          placedAt: "2026-04-02T00:00:00.000Z",
        },
        context,
      }),
      wallets.commandHandler({
        streamId,
        expectedVersion: seed.version,
        command: {
          type: "PlaceSpendHold",
          holdId: "hold_balance_credit_pay_2",
          paymentId: "pay_2" as PaymentId,
          amount: "50.00",
          currencyCode: "usd",
          placedAt: "2026-04-02T00:00:00.000Z",
        },
        context,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(isConcurrencyConflict((rejected[0] as PromiseRejectedResult).reason)).toBe(true);

    const state = await wallets.loadWalletState(BUYER);
    expect(state.heldBalanceAmount).toBe("50.00");
  });

  it("two interleaved checkouts cannot both spend the same $50 (retry caps the loser)", async () => {
    const wallets = createWallets(async () => ({ rows: [] }));
    await seedAvailable(wallets, "50.00");

    const [first, second] = await Promise.all([
      wallets.placeSpendHold(
        { accountId: BUYER, holdId: "hold_balance_credit_pay_1", paymentId: "pay_1" as PaymentId, amount: "50.00" },
        context,
      ),
      wallets.placeSpendHold(
        { accountId: BUYER, holdId: "hold_balance_credit_pay_2", paymentId: "pay_2" as PaymentId, amount: "50.00" },
        context,
      ),
    ]);

    // Exactly one hold reserves the full $50; the other is capped to what is
    // left (0). The total held can never exceed the $50 actually available.
    expect(addMoney(first.heldAmount, second.heldAmount)).toBe("50.00");
    expect([first.heldAmount, second.heldAmount].sort()).toEqual(["0.00", "50.00"]);

    const state = await wallets.loadWalletState(BUYER);
    expect(state.heldBalanceAmount).toBe("50.00");
  });

  it("caps a partially-overlapping concurrent hold to the remaining balance", async () => {
    const wallets = createWallets(async () => ({ rows: [] }));
    await seedAvailable(wallets, "50.00");

    const [a, b] = await Promise.all([
      wallets.placeSpendHold({ accountId: BUYER, holdId: "hold_balance_credit_pay_1", amount: "30.00" }, context),
      wallets.placeSpendHold({ accountId: BUYER, holdId: "hold_balance_credit_pay_2", amount: "50.00" }, context),
    ]);

    // One holds its 30; the other is limited to the remaining 20.
    expect(addMoney(a.heldAmount, b.heldAmount)).toBe("50.00");
    const state = await wallets.loadWalletState(BUYER);
    expect(state.heldBalanceAmount).toBe("50.00");
  });

  it("releasing a hold restores spendable balance and is idempotent", async () => {
    const wallets = createWallets(async () => ({ rows: [] }));
    await seedAvailable(wallets, "50.00");
    await wallets.placeSpendHold(
      { accountId: BUYER, holdId: "hold_balance_credit_pay_1", paymentId: "pay_1" as PaymentId, amount: "50.00" },
      context,
    );

    const released = await wallets.releaseSpendHold(
      { accountId: BUYER, holdId: "hold_balance_credit_pay_1", reason: "payment-failed" },
      context,
    );
    expect(released.released).toBe(true);

    const again = await wallets.releaseSpendHold(
      { accountId: BUYER, holdId: "hold_balance_credit_pay_1", reason: "payment-failed" },
      context,
    );
    expect(again.released).toBe(false);

    const state = await wallets.loadWalletState(BUYER);
    expect(state.heldBalanceAmount).toBe("0.00");
    expect(state.availableBalanceAmount).toBe("50.00");
  });

  it("re-holding after a release reserves against the restored balance", async () => {
    const wallets = createWallets(async () => ({ rows: [] }));
    await seedAvailable(wallets, "50.00");
    await wallets.placeSpendHold({ accountId: BUYER, holdId: "hold_balance_credit_pay_1", amount: "50.00" }, context);
    await wallets.releaseSpendHold(
      { accountId: BUYER, holdId: "hold_balance_credit_pay_1", reason: "payment-cancelled" },
      context,
    );

    const second = await wallets.placeSpendHold(
      { accountId: BUYER, holdId: "hold_balance_credit_pay_2", amount: "50.00" },
      context,
    );
    expect(second.heldAmount).toBe("50.00");
  });

  it("sweeps an expired hold, releasing it back to spendable", async () => {
    const now = "2026-04-10T00:00:00.000Z";
    // The sweep reads its work list from the read model; return one expired hold
    // for the expiry query and nothing for any other read.
    const dbQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM settlement_wallet_spend_holds") && sql.includes("expires_at <=")) {
        return {
          rows: [
            {
              hold_id: "hold_balance_credit_pay_1",
              account_id: BUYER,
              payment_id: "pay_1",
              amount: "50.00",
              currency_code: "usd",
              placed_at: "2026-04-01T00:00:00.000Z",
              expires_at: "2026-04-04T00:00:00.000Z",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const wallets = createWallets(dbQuery);
    await seedAvailable(wallets, "50.00");
    await wallets.placeSpendHold(
      {
        accountId: BUYER,
        holdId: "hold_balance_credit_pay_1",
        paymentId: "pay_1" as PaymentId,
        amount: "50.00",
        expiresAt: "2026-04-04T00:00:00.000Z",
      },
      context,
    );

    const result = await wallets.sweepExpiredSpendHolds({ now }, context);
    expect(result.released).toBe(1);

    const state = await wallets.loadWalletState(BUYER);
    expect(state.heldBalanceAmount).toBe("0.00");
  });
});
