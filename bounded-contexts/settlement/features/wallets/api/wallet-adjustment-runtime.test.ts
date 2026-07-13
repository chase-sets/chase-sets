import { describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createWalletRuntime } from "./runtime";
import { createWalletAdjustmentRuntime, deriveWalletAdjustmentId } from "./wallet-adjustment-runtime";

/** In-memory event store that enforces optimistic concurrency like the Postgres store. */
function createInMemoryEventStore() {
  let globalPosition = 0;
  const streams = new Map<string, StoredEvent[]>();
  const allEvents: StoredEvent[] = [];

  const eventStore: EventStore = {
    appendToStream: async (input: AppendToStreamInput) => {
      const existing = streams.get(input.streamId) ?? [];
      if (input.expectedVersion !== undefined && input.expectedVersion !== "any") {
        const expected = input.expectedVersion === "no_stream" ? 0 : Number(input.expectedVersion);
        if (existing.length !== expected) {
          const error = new Error("Expected stream version does not match current version.") as Error & {
            code: string;
          };
          error.code = "concurrency_conflict";
          throw error;
        }
      }
      const stored = input.events.map((event, index) => {
        globalPosition += 1;
        return {
          eventId: `evt_${globalPosition}` as never,
          streamId: input.streamId,
          streamVersion: existing.length + index + 1,
          globalPosition: String(globalPosition) as GlobalPosition,
          tenantId: input.context.tenantId,
          eventType: event.eventType,
          payload: event.payload,
          metadata: event.metadata ?? {},
          occurredAt: new Date().toISOString() as never,
          recordedAt: new Date().toISOString() as never,
          performedByUserId: input.context.audit.performedByUserId,
          forAccountId: input.context.audit.forAccountId,
        } satisfies StoredEvent;
      });
      streams.set(input.streamId, [...existing, ...stored]);
      allEvents.push(...stored);
      return stored;
    },
    readStream: async (input: ReadStreamInput) =>
      [...(streams.get(input.streamId) ?? [])].slice(input.fromVersion ?? 0),
    readAll: async (input?: ReadAllInput) => {
      const after = Number(input?.afterGlobalPosition ?? ZERO_GLOBAL_POSITION);
      return allEvents.filter((event) => Number(event.globalPosition) > after);
    },
  };

  return { eventStore, allEvents };
}

const noopDb = { query: async () => ({ rows: [], rowCount: 0 }) } as never;

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
};

function createRuntimes() {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const wallets = createWalletRuntime({ eventStore, checkpointStore: {} as never, db: noopDb });
  const adjustments = createWalletAdjustmentRuntime({ eventStore, db: noopDb, wallets });
  return { wallets, adjustments, allEvents };
}

async function seedAvailable(wallets: ReturnType<typeof createWalletRuntime>, accountId: string, amount: string) {
  await wallets.postEntry(
    {
      accountId: accountId as never,
      ledgerEntryId: `led_seed_${accountId}` as never,
      kind: "sale",
      direction: "credit",
      amount,
      currencyCode: "usd",
      fundsStatus: "available",
      postedAt: "2026-07-01T00:00:00.000Z",
    },
    context,
  );
}

describe("wallet adjustment runtime", () => {
  it("requests, approves, and posts a credit onto available balance with a command-owned snapshot", async () => {
    const { wallets, adjustments } = createRuntimes();
    await seedAvailable(wallets, "acc_seller", "10.00");

    const requested = await adjustments.request(
      {
        idempotencyKey: "corr-1",
        targetAccountId: "acc_seller" as never,
        direction: "credit",
        amount: "40.00",
        reasonCode: "goodwill-cash-credit",
        requestedBy: "usr_requester" as never,
        selfBenefiting: false,
      },
      context,
    );
    expect(requested.status).toBe("requested");

    const posted = await adjustments.approveAndPost(
      { adjustmentId: requested.adjustment_id as never, approvedBy: "usr_approver" as never },
      context,
    );
    expect(posted.status).toBe("posted");
    expect(posted.available_balance_before).toBe("10.00");
    expect(posted.available_balance_after).toBe("50.00");

    const wallet = await wallets.loadWalletState("acc_seller" as never);
    expect(wallet.availableBalanceAmount).toBe("50.00");
  });

  it("posts exactly one ledger entry even when post is retried (idempotent, no double-credit)", async () => {
    const { wallets, adjustments, allEvents } = createRuntimes();
    await seedAvailable(wallets, "acc_seller", "10.00");
    const requested = await adjustments.request(
      {
        idempotencyKey: "corr-2",
        targetAccountId: "acc_seller" as never,
        direction: "credit",
        amount: "5.00",
        reasonCode: "operational-error",
        requestedBy: "usr_requester" as never,
        selfBenefiting: false,
      },
      context,
    );
    await adjustments.approve(
      { adjustmentId: requested.adjustment_id as never, approvedBy: "usr_approver" as never },
      context,
    );

    await adjustments.post({ adjustmentId: requested.adjustment_id as never }, context);
    const second = await adjustments.post({ adjustmentId: requested.adjustment_id as never }, context);
    expect(second.status).toBe("posted");

    const adjustmentLedgerEntries = allEvents.filter(
      (event) =>
        event.eventType === "settlement.wallet.ledger-entry-posted" &&
        (event.payload as { kind?: string }).kind === "adjustment",
    );
    expect(adjustmentLedgerEntries).toHaveLength(1);

    const wallet = await wallets.loadWalletState("acc_seller" as never);
    expect(wallet.availableBalanceAmount).toBe("15.00");
  });

  it("derives distinct adjustment ids for the same idempotency key across accounts", () => {
    const first = deriveWalletAdjustmentId("corr-shared", "acc_one" as never);
    const second = deriveWalletAdjustmentId("corr-shared", "acc_two" as never);
    expect(first).not.toBe(second);
  });

  it("posts a debit that fits within available balance without elevation", async () => {
    const { wallets, adjustments } = createRuntimes();
    await seedAvailable(wallets, "acc_seller", "25.00");
    const requested = await adjustments.request(
      {
        idempotencyKey: "corr-3",
        targetAccountId: "acc_seller" as never,
        direction: "debit",
        amount: "10.00",
        reasonCode: "fee-correction",
        requestedBy: "usr_requester" as never,
        selfBenefiting: false,
      },
      context,
    );
    const posted = await adjustments.approveAndPost(
      { adjustmentId: requested.adjustment_id as never, approvedBy: "usr_approver" as never },
      context,
    );
    expect(posted.status).toBe("posted");
    const wallet = await wallets.loadWalletState("acc_seller" as never);
    expect(wallet.availableBalanceAmount).toBe("15.00");
  });

  it("requires elevation for a debit that drives the balance negative, then posts with a negative balance", async () => {
    const { wallets, adjustments } = createRuntimes();
    await seedAvailable(wallets, "acc_seller", "25.00");
    const requested = await adjustments.request(
      {
        idempotencyKey: "corr-4",
        targetAccountId: "acc_seller" as never,
        direction: "debit",
        amount: "30.00",
        reasonCode: "fraud-recovery",
        requestedBy: "usr_requester" as never,
        selfBenefiting: false,
      },
      context,
    );

    await expect(
      adjustments.approve(
        { adjustmentId: requested.adjustment_id as never, approvedBy: "usr_approver" as never },
        context,
      ),
    ).rejects.toThrow(/requires a second, elevated approval/);

    const posted = await adjustments.approveAndPost(
      {
        adjustmentId: requested.adjustment_id as never,
        approvedBy: "usr_approver" as never,
        elevationApprovedBy: "usr_elevated" as never,
      },
      context,
    );
    expect(posted.status).toBe("posted");
    expect(posted.creates_or_increases_negative_balance).toBe(true);

    const wallet = await wallets.loadWalletState("acc_seller" as never);
    expect(wallet.availableBalanceAmount).toBe("-5.00");
    expect(wallet.negativeBalanceStatus).toBe("negative");
  });

  it("reverses a posted credit with a linked opposite entry and restores the balance", async () => {
    const { wallets, adjustments } = createRuntimes();
    const requested = await adjustments.request(
      {
        idempotencyKey: "corr-5",
        targetAccountId: "acc_seller" as never,
        direction: "credit",
        amount: "20.00",
        reasonCode: "goodwill-cash-credit",
        requestedBy: "usr_requester" as never,
        selfBenefiting: false,
      },
      context,
    );
    await adjustments.approveAndPost(
      { adjustmentId: requested.adjustment_id as never, approvedBy: "usr_approver" as never },
      context,
    );
    expect((await wallets.loadWalletState("acc_seller" as never)).availableBalanceAmount).toBe("20.00");

    const { original, reversal } = await adjustments.reverse(
      {
        adjustmentId: requested.adjustment_id as never,
        requestedBy: "usr_reverser" as never,
        approvedBy: "usr_approver" as never,
        elevationApprovedBy: "usr_elevated" as never,
      },
      context,
    );
    expect(original.status).toBe("reversed");
    expect(original.reversed_by_adjustment_id).toBe(reversal.adjustment_id);
    expect(reversal.status).toBe("posted");
    expect(reversal.direction).toBe("debit");
    expect(reversal.reversal_of_adjustment_id).toBe(requested.adjustment_id);

    expect((await wallets.loadWalletState("acc_seller" as never)).availableBalanceAmount).toBe("0.00");
  });

  it("reversal is idempotent and reuses the linked reversal id", async () => {
    const { wallets, adjustments } = createRuntimes();
    const requested = await adjustments.request(
      {
        idempotencyKey: "corr-6",
        targetAccountId: "acc_seller" as never,
        direction: "credit",
        amount: "20.00",
        reasonCode: "goodwill-cash-credit",
        requestedBy: "usr_requester" as never,
        selfBenefiting: false,
      },
      context,
    );
    await adjustments.approveAndPost(
      { adjustmentId: requested.adjustment_id as never, approvedBy: "usr_approver" as never },
      context,
    );
    const first = await adjustments.reverse(
      {
        adjustmentId: requested.adjustment_id as never,
        requestedBy: "usr_reverser" as never,
        approvedBy: "usr_approver" as never,
        elevationApprovedBy: "usr_elevated" as never,
      },
      context,
    );
    const second = await adjustments.reverse(
      {
        adjustmentId: requested.adjustment_id as never,
        requestedBy: "usr_reverser" as never,
        approvedBy: "usr_approver" as never,
        elevationApprovedBy: "usr_elevated" as never,
      },
      context,
    );
    expect(second.reversal.adjustment_id).toBe(first.reversal.adjustment_id);
    expect((await wallets.loadWalletState("acc_seller" as never)).availableBalanceAmount).toBe("0.00");
  });
});
