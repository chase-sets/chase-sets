import { describe, expect, it, vi } from "vitest";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";

type StoredRow = Readonly<{ event_type: string; tenant_id: string; payload: unknown }>;
type SentCommand = Readonly<{
  streamId: string;
  command: Readonly<{ type: string }>;
  context: Readonly<{ tenantId: string; audit: Readonly<{ performedByUserId: string; forAccountId: string }> }>;
}>;

const store = vi.hoisted(() => ({
  streams: {} as Record<string, StoredRow[]>,
  sent: [] as SentCommand[],
}));

vi.mock("./services", async () => {
  const payments = await import("../../features/payments/domain/domain");
  const refunds = await import("../../features/refunds/domain/domain");
  // Appends the domain's own events under the command's tenant, as the event store would.
  type Decide = (state: unknown, command: unknown) => readonly Readonly<{ type: string; data: unknown }>[];
  type Evolve = (state: unknown, event: unknown) => unknown;
  const handler = (decide: Decide, evolve: Evolve, initial: unknown) => async (input: SentCommand) => {
    store.sent.push(input);
    const rows = (store.streams[input.streamId] ??= []);
    let state = initial;
    for (const row of rows) {
      state = evolve(state, { type: row.event_type, data: row.payload });
    }
    for (const event of decide(state, input.command)) {
      state = evolve(state, event);
      rows.push({ event_type: event.type, tenant_id: input.context.tenantId, payload: event.data });
    }
    return { storedEvents: [] };
  };
  return {
    createPaymentsServices: (pool: unknown) => ({
      db: pool,
      payments: {
        commandHandler: handler(
          payments.decidePayment as never,
          payments.evolvePayment as never,
          payments.initialPaymentState,
        ),
      },
      refunds: {
        commandHandler: handler(
          refunds.decideRefund as never,
          refunds.evolveRefund as never,
          refunds.initialRefundState,
        ),
      },
    }),
  };
});

const { seedPaymentsDatabase } = await import("./seed");

// The seed's buyer and seller sign in under Identity's bootstrap tenant, as the Ordering and Fulfillment seeds write.
const sellerSessionTenantId = "tnt_identity";
const capturedStream = `payments.payment-${paymentsReservedSeedIds.payments.acceptedOfferCaptured}`;
const reviewEligibleStream = `payments.payment-${paymentsReservedSeedIds.payments.reviewEligibleCaptured}`;

function pendingOrder(orderId: string) {
  return {
    order_id: orderId,
    buyer_account_id: identitySeedIds.collector.accountId,
    seller_account_id: identitySeedIds.demo.accountId,
    total_amount: "110.00",
    marketplace_sales_fee_amount: "10.00",
    marketplace_checkout_fee_amount: "0.00",
    seller_net_amount: "100.00",
    seller_item_net_amount: "100.00",
    shipping_allowance_amount: "0.00",
    seller_shipping_payout_amount: "0.00",
    protection_amount: "0.00",
    protection_allowance_amount: "0.00",
    protection_overage_amount: "0.00",
    seller_payout_amount: "100.00",
    status: "pending-payment",
  };
}

/** A pool whose pending seed orders all exist, answering each stream from the in-memory store. */
function seedPool() {
  return {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SELECT DISTINCT tenant_id")) {
        const [streamId, tenantId] = params as [string, string];
        const foreign = new Set(
          (store.streams[streamId] ?? []).map((row) => row.tenant_id).filter((tenant) => tenant !== tenantId),
        );
        return { rows: [...foreign].map((tenant_id) => ({ tenant_id })) };
      }
      if (sql.includes("event_store_events")) {
        const rows = (store.streams[String(params[0])] ?? []).map((row, index) => ({
          stream_id: params[0],
          stream_version: index + 1,
          event_type: row.event_type,
          payload: row.payload,
        }));
        return { rows };
      }
      if (sql.includes("FROM payments_order_inputs")) {
        return { rows: [pendingOrder(String(params[0]))] };
      }
      if (sql.includes("INSERT INTO payments_")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected seed query: ${sql}`);
    }),
  };
}

function reset() {
  store.streams = {};
  store.sent.length = 0;
}

describe("payments seed", () => {
  it("waits for ordering order projections instead of failing bootstrap", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("payments_payment_pages")) {
          return { rows: [{ count: "0" }] };
        }
        if (sql.includes("payments_order_inputs")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    try {
      await seedPaymentsDatabase(pool as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain("Payments seed is waiting for order ord_seed_checkout_pending to be projected.");
  });

  it("seed captured payments use the seller session tenant", async () => {
    reset();

    await seedPaymentsDatabase(seedPool() as never);

    // Ordering marks a captured payment's orders ready under the capture's tenant, and Fulfillment opens their
    // shipments under it, so the seller can only pack them when the capture carries the seller's session tenant.
    for (const streamId of [capturedStream, reviewEligibleStream]) {
      expect(store.streams[streamId]?.map((row) => row.event_type)).toContain("payments.payment-captured");
    }
    expect(
      store.sent.some((sent) => sent.streamId.startsWith("payments.refund-")),
      "the seeded refunds are authored",
    ).toBe(true);
    const tenants = new Set(Object.values(store.streams).flatMap((rows) => rows.map((row) => row.tenant_id)));
    expect(tenants).toEqual(new Set([sellerSessionTenantId]));
  });

  it("refuses to resume a seed payment written under another tenant, and leaves a finished one alone", async () => {
    reset();
    await seedPaymentsDatabase(seedPool() as never);
    const finished = structuredClone(store.streams);
    const underOldTenant = (rows: readonly StoredRow[]) =>
      rows.map((row) => ({ ...row, tenant_id: "tnt_seed_development" }));

    // Created but not yet captured under the old seed tenant: capturing it now would mix tenants in one stream.
    reset();
    store.streams[capturedStream] = underOldTenant(finished[capturedStream]!.slice(0, 1));
    await expect(seedPaymentsDatabase(seedPool() as never)).rejects.toThrow(
      `Payments seed bootstrap Stream '${capturedStream}' was written under tenant 'tnt_seed_development', ` +
        `not the seed tenant '${sellerSessionTenantId}'; it will not be resumed.`,
    );
    expect(store.sent.filter((sent) => sent.streamId === capturedStream)).toEqual([]);
    expect(store.streams[capturedStream]).toHaveLength(1);

    // A retained set the old seed finished has nothing left to append, so it is left as it is.
    reset();
    store.streams = Object.fromEntries(
      Object.entries(finished).map(([streamId, rows]) => [streamId, underOldTenant(rows)]),
    );
    await seedPaymentsDatabase(seedPool() as never);
    expect(store.sent).toEqual([]);
  });
});
