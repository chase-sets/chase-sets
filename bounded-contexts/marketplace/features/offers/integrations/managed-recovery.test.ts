import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { context } from "../../offer-policy/tests/fixtures";
import { managedWorkFixture } from "../tests/managed-work-fixture";
import { buildManagedOfferMarketPriceReactions } from "./managed-work";
import type { MarketplaceOfferServices } from "../api/runtime";

const products = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    offer_id: `off_${String(i).padStart(3, "0")}`,
    catalog_catalog_item_id: "cat_one",
    product_id: `product_${i}`,
  }));

describe("bounded managed Offer recovery", () => {
  it("bounds pending work and per-sweep streams for 121 Products over 11 simulated minutes, prioritizing reactions", async () => {
    const store = createInMemoryEventStore().eventStore;
    const apply = vi.fn<MarketplaceOfferServices["applyManagedOfferPage"]>(async () => {});
    const f = managedWorkFixture(store, products(121), apply);
    const byGeneration = new Map<string, Set<string>>();
    let reactionProved = false;
    for (let second = 0; second < 660; second++) {
      if (second % 60 === 0) {
        const generation = f.cursor().generation;
        const before = new Set((await f.workRows()).map((row) => row.work_id));
        await f.worker().recover(context);
        const created = byGeneration.get(generation) ?? new Set<string>();
        for (const row of await f.workRows()) if (!before.has(row.work_id)) created.add(row.work_id);
        byGeneration.set(generation, created);
        expect(created.size).toBeLessThanOrEqual(121);
      }
      if (second === 30) {
        expect((await f.workRows()).filter((row) => row.status !== "completed").length).toBeGreaterThan(60);
        const event = buildTransportEvent("pricing.market-price.estimated", {
          catalogItemId: "cat_one",
          productId: "product_120",
        });
        const reactions = buildManagedOfferMarketPriceReactions(f.worker());
        await reactions[event.type]!(event);
        await reactions[event.type]!(event);
        await f.worker().run(context);
        const reaction = (await f.workRows()).filter((row) => row.kind === "reaction");
        expect(reaction).toHaveLength(1);
        expect(reaction[0]!.status).toBe("completed"); // One tick, despite >60 older recovery items.
        reactionProved = true;
      } else await f.worker().run(context);
      expect((await f.workRows()).filter((row) => row.status !== "completed").length).toBeLessThanOrEqual(121);
      f.advance(1_000);
    }
    expect(reactionProved).toBe(true);
    expect(Number(f.cursor().generation)).toBeGreaterThanOrEqual(2);
    expect(new Set(apply.mock.calls.flatMap((call) => call[0].map((item) => item.offerId))).size).toBe(121);
  });

  it("waits for authoritative prior-page completion through projection lag and a 60-second claim retry", async () => {
    const store = createInMemoryEventStore().eventStore;
    const apply = vi.fn().mockRejectedValueOnce(new Error("worker crash")).mockResolvedValue(undefined);
    const f = managedWorkFixture(store, products(61), apply);
    await f.worker().recover(context);
    f.hideProjection(true);
    expect(await f.worker().recover(context)).toBe(0);
    expect(await f.workRows()).toHaveLength(61);
    expect(f.cursor().generation).toBe("0");
    f.hideProjection(false);
    await expect(f.worker().run(context)).rejects.toThrow("worker crash");
    const first = apply.mock.calls[0]![0];
    for (let i = 0; i < 60; i++) await f.worker().run(context);
    expect(await f.worker().run(context)).toBe(0);
    expect(await f.worker().recover(context)).toBe(0);
    f.advance(60_000);
    expect(await f.worker().run(context)).toBe(1);
    expect(apply.mock.calls.at(-1)![0]).toEqual(first);
    await f.worker().recover(context);
    expect(f.cursor().generation).toBe("1");
  });

  it("coalesces pending Product reactions and deduplicates a Product across recovery pages and replacement", async () => {
    const store = createInMemoryEventStore().eventStore;
    const rows = products(201).map((row) => ({ ...row, product_id: "shared" }));
    const f = managedWorkFixture(store, rows);
    await f.worker().enqueue({ catalogItemId: "cat_one", productId: "shared" }, "signal", context);
    await f.worker().recover(context);
    expect(await f.workRows()).toHaveLength(1);
    for (let i = 0; i < 3; i++) await f.worker().run(context);
    await f.worker().recover(context);
    for (let i = 0; i < 3; i++) await f.worker().run(context);
    await f.worker().recover(context);
    await f.worker().recover(context);
    expect(await f.workRows()).toHaveLength(2); // One reaction and one recovery identity, not one per page.
    expect(f.cursor()).toMatchObject({ after_offer_id: "", generation: "1" });
  });
});
