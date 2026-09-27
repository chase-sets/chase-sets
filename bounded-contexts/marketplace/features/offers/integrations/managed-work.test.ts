import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore, buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createManagedOfferWork, buildManagedOfferMarketPriceReactions } from "./managed-work";
import { managedFixture } from "../tests/managed-fixture";
import { context } from "../../offer-policy/tests/fixtures";
import type { MarketplaceOfferServices } from "../api/runtime";

describe("managed Offer durable Product work", () => {
  it("deduplicates market signals, pages past 100, and resumes after worker replacement", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const applyManagedOfferPage = vi.fn<MarketplaceOfferServices["applyManagedOfferPage"]>(async () => {});
    const ids = Array.from({ length: 101 }, (_, i) => `off_${String(i).padStart(3, "0")}`);
    let workId = "";
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => ({
        rows: sql.includes("FROM marketplace_managed_offer_work")
          ? [{ work_id: workId, last_stream_version: 1 }]
          : ids
              .filter((id) => id > String(values?.[2] ?? ""))
              .slice(0, 100)
              .map((offer_id) => ({ offer_id })),
      })),
    };
    const make = () => createManagedOfferWork({ eventStore, db: db as never, offers: { applyManagedOfferPage } });
    const worker = make();
    const event = buildTransportEvent("pricing.market-price.estimated", {
      catalogItemId: "cat_one",
      productId: "cat_one::",
    });
    const reactions = buildManagedOfferMarketPriceReactions(worker);
    await reactions[event.type]!(event);
    await reactions[event.type]!(event);
    const requested = await eventStore.readAll();
    expect(requested).toHaveLength(1);
    workId = String(requested[0]!.payload.workId);
    expect(await worker.run(context)).toBe(100);
    expect(await make().run(context)).toBe(1);
    expect(applyManagedOfferPage.mock.calls.flatMap((call) => call[0].map((item) => item.offerId))).toEqual(ids);
    expect((await eventStore.readAll()).at(-1)?.payload.status).toBe("completed");
    expect(await make().run(context)).toBe(0);
  });

  it("persists recovery continuation and visits the tail instead of rescanning the first page", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    let after = "";
    let generation = 0;
    const ids = Array.from({ length: 101 }, (_, i) => `off_${String(i).padStart(3, "0")}`);
    const db = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        if (sql.startsWith("SELECT after_offer_id"))
          return { rows: [{ after_offer_id: after, generation: String(generation) }] };
        if (sql.includes("SELECT offer.offer_id"))
          return {
            rows: ids
              .filter((id) => id > after)
              .slice(0, 100)
              .map((offer_id) => ({
                offer_id,
                catalog_catalog_item_id: "cat_one",
                product_id: offer_id === "off_100" ? "tail" : "head",
              })),
          };
        if (sql.startsWith("UPDATE marketplace_managed_offer_recovery")) {
          after = String(values![0]);
          generation++;
        }
        return { rows: [] };
      }),
    };
    const worker = createManagedOfferWork({ eventStore, db: db as never, offers: { applyManagedOfferPage: vi.fn() } });
    expect(await worker.recover(context)).toBe(100);
    expect(after).toBe("off_099");
    expect(await worker.recover(context)).toBe(1);
    expect(after).toBe("");
    expect((await eventStore.readAll()).map((e) => e.payload.productId)).toEqual(["head", "tail"]);
  });

  it("a superseded worker claim cannot append a managed price", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const f = await managedFixture(eventStore);
    const streamId = "marketplace.offer-work-replaced";
    await eventStore.appendToStream({
      streamId,
      expectedVersion: 0,
      context,
      events: [{ eventType: "marketplace.offer.work-claimed", payload: {} }],
    });
    f.evaluateTargets.mockImplementationOnce(async () => {
      await eventStore.appendToStream({
        streamId,
        expectedVersion: 1,
        context,
        events: [{ eventType: "marketplace.offer.work-claimed", payload: {} }],
      });
      return [{ status: "target", unitItemAmount: "12.00", evidence: {} }];
    });
    await expect(
      f.offers.applyManagedOffer("off_one" as never, "stale_worker", context, {
        streamId,
        expectedVersion: 1,
        events: [],
        context,
      }),
    ).rejects.toMatchObject({ code: "managed_offer_conflict" });
    expect(await eventStore.readStream({ streamId: "marketplace.offer-off_one" })).toHaveLength(2);
  });

  it("omitting the Market Price reaction enqueues no work", async () => {
    const eventStore = createInMemoryEventStore().eventStore;
    const worker = createManagedOfferWork({
      eventStore,
      db: { query: vi.fn(async () => ({ rows: [] })) },
      offers: { applyManagedOfferPage: vi.fn() },
    });
    const event = buildTransportEvent("pricing.market-price.estimated", {
      catalogItemId: "cat_one",
      productId: "cat_one::",
    });
    const omitted = {} as ReturnType<typeof buildManagedOfferMarketPriceReactions>;
    await omitted[event.type]?.(event);
    expect(await worker.run(context)).toBe(0);
    expect(await eventStore.readAll()).toEqual([]);
  });
});
