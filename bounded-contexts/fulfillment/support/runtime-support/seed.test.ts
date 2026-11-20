import { describe, expect, it, vi } from "vitest";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { fulfillmentReservedSeedIds } from "@chase-sets/fulfillment/seed-support/ids";

type SentCommand = Readonly<{
  streamId: string;
  command: Readonly<{ type: string }>;
  context: Readonly<{ tenantId: string; audit: Readonly<{ performedByUserId: string; forAccountId: string }> }>;
}>;

const shipments = vi.hoisted(() => ({ sent: [] as SentCommand[] }));

vi.mock("./services", () => ({
  createFulfillmentServices: (pool: unknown) => ({
    db: pool,
    shipments: {
      commandHandler: async (input: SentCommand) => {
        shipments.sent.push(input);
        return { storedEvents: [] };
      },
    },
  }),
}));

const { seedFulfillmentDatabase } = await import("./seed");
const { decideFulfillmentShipment, evolveFulfillmentShipment, initialFulfillmentShipmentState } = await import(
  "../../features/shipments/domain/domain"
);

/** The events a stream's seed commands produce, stored under `tenantId`. */
function storedUnder(tenantId: string, commands: readonly SentCommand["command"][]) {
  let state = initialFulfillmentShipmentState;
  const rows: Readonly<{ event_type: string; tenant_id: string; payload: unknown }>[] = [];
  for (const command of commands) {
    for (const event of decideFulfillmentShipment(state, command as never)) {
      state = evolveFulfillmentShipment(state, event);
      rows.push({ event_type: event.type, tenant_id: tenantId, payload: event.data });
    }
  }
  return rows;
}

// The demo seller signs in under Identity's bootstrap tenant, as the Ordering and Inventory seeds write.
const demoSellerTenantId = "tnt_identity";
const returnedStream = `fulfillment.shipment-${fulfillmentReservedSeedIds.shipments.returnedShipment}`;

const address = { name: "Synthetic Seller", line1: "1 Synthetic Way", city: "Testville", state: "TX", postalCode: "75001", country: "US" };
function order(orderId: string) {
  return {
    order_id: orderId,
    buyer_account_id: identitySeedIds.collector.accountId,
    seller_account_id: identitySeedIds.demo.accountId,
    shipping_option: "standard",
    shipping_destination_snapshot: address,
    shipping_origin_snapshot: address,
  };
}

/** A pool with two ready orders, answering each shipment stream from `streams`. */
type StoredRow = Readonly<{ event_type: string; tenant_id: string; payload: unknown }>;
function seedPool(streams: Readonly<Record<string, readonly StoredRow[]>> = {}) {
  return {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SELECT DISTINCT tenant_id")) {
        const [streamId, tenantId] = params as [string, string];
        const tenants = new Set((streams[streamId] ?? []).map((row) => row.tenant_id).filter((t) => t !== tenantId));
        return { rows: [...tenants].map((tenant_id) => ({ tenant_id })) };
      }
      if (sql.includes("event_store_events")) {
        const rows = (streams[String(params[0])] ?? []).map((row, index) => ({
          stream_id: params[0],
          stream_version: index + 1,
          event_type: row.event_type,
          payload: row.payload,
        }));
        return { rows };
      }
      if (sql.includes("fulfillment_order_source_lines")) {
        return {
          rows: [
            {
              line_id: `${String(params[0])}_line_1`,
              catalog_catalog_item_id: "cat_synthetic",
              product_id: "cat_synthetic::raw",
              item_title: "Synthetic card",
              item_subtitle: null,
              product_summary: null,
              quantity: 1,
            },
          ],
        };
      }
      if (sql.includes("fulfillment_order_sources")) {
        return { rows: [order("ord_seed_reference"), order("ord_seed_review")] };
      }
      throw new Error(`Unexpected seed query: ${sql}`);
    }),
  };
}

describe("fulfillment seed", () => {
  it("waits for ready order projections instead of failing bootstrap", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("event_store_events")) {
          return { rows: [] };
        }
        if (sql.includes("fulfillment_shipment_pages")) {
          return { rows: [{ count: "0" }] };
        }
        if (sql.includes("fulfillment_order_sources")) {
          return { rows: [] };
        }
        throw new Error(`Unexpected seed query: ${sql}`);
      }),
    };

    try {
      await seedFulfillmentDatabase(pool as never);
    } finally {
      logSpy.mockRestore();
    }

    expect(logs.join("\n")).toContain(
      "Fulfillment seed is waiting for two ready-for-fulfillment orders. Skipping shipments for this pass.",
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM event_store_events"),
      expect.arrayContaining([expect.stringContaining("fulfillment.shipment-")]),
    );
  });

  it("seed returned decision uses seller tenant", async () => {
    shipments.sent.length = 0;

    await seedFulfillmentDatabase(seedPool() as never);

    const returned = shipments.sent.find(
      (sent) => sent.streamId === returnedStream && sent.command.type === "ReturnShipment",
    );
    expect(returned, "the returned seed shipment is authored").toBeDefined();
    // Inventory records the decision under the returned event's tenant and only lets that tenant's
    // seller record it, so the shipment must carry the demo seller's tenant and account.
    expect(returned!.context).toEqual({
      tenantId: demoSellerTenantId,
      audit: { performedByUserId: identitySeedIds.demo.userId, forAccountId: identitySeedIds.demo.accountId },
    });
    expect(new Set(shipments.sent.map((sent) => sent.context.tenantId))).toEqual(new Set([demoSellerTenantId]));
  });

  it("refuses to resume a seed shipment written under another tenant, and leaves a finished one alone", async () => {
    const awaitingLabelStream = `fulfillment.shipment-${fulfillmentReservedSeedIds.shipments.awaitingLabel}`;
    shipments.sent.length = 0;
    await seedFulfillmentDatabase(seedPool() as never);
    const commandsFor = (streamId: string) =>
      shipments.sent.filter((sent) => sent.streamId === streamId).map((sent) => sent.command);
    const created = storedUnder("tnt_seed_development", commandsFor(awaitingLabelStream).slice(0, 1));
    const returned = storedUnder("tnt_seed_development", commandsFor(returnedStream));
    shipments.sent.length = 0;

    // Part way through packing under the old seed tenant: appending would mix tenants in one stream.
    await expect(seedFulfillmentDatabase(seedPool({ [awaitingLabelStream]: created }) as never)).rejects.toThrow(
      `Fulfillment seed bootstrap Shipment stream '${awaitingLabelStream}' was written under tenant 'tnt_seed_development', not the seed tenant '${demoSellerTenantId}'; it will not be resumed.`,
    );
    expect(shipments.sent.filter((sent) => sent.streamId === awaitingLabelStream)).toEqual([]);

    // A finished one is not appended to, and the rest still seed under the seller's tenant. Its
    // decision stays out of the seller's reach until the environment is reset and reseeded.
    shipments.sent.length = 0;
    await seedFulfillmentDatabase(seedPool({ [returnedStream]: returned }) as never);
    expect(shipments.sent.filter((sent) => sent.streamId === returnedStream)).toEqual([]);
    expect(shipments.sent.filter((sent) => sent.streamId === awaitingLabelStream).length).toBeGreaterThan(0);
    expect(new Set(shipments.sent.map((sent) => sent.context.tenantId))).toEqual(new Set([demoSellerTenantId]));
  });
});
