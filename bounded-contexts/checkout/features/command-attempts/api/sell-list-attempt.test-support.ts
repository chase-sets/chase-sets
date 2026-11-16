import { expect, it, vi } from "vitest";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createCheckoutSellListRuntime } from "../../sell-list/api/runtime";
import {
  checkoutOwnerRuntimeFixture,
  fixtureLine,
  choices,
  ownedAbsentRisk,
} from "../../sell-list/api/owner-read.fixture";
import { computeCheckoutCommandAttemptRequestHash } from "./contracts";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_seller" as never },
};
const checkpointStore = {} as never;
const stamp = "2026-11-06T01:02:03.000Z";
export const catalogDb = {
  query: vi.fn(async () => ({ rows: [{ catalog_item_id: "cat_attempt", status: "active", product_schema: null }] })),
} as unknown as PgQueryable;

async function seedSelectedLine(services: ReturnType<typeof createCheckoutSellListRuntime>) {
  await services.commandHandler({
    streamId: "checkout.sell-list-acc_seller",
    context,
    command: {
      type: "AddSellListLine",
      sellerAccountId: "acc_seller" as never,
      lineId: fixtureLine.line_id as never,
      lineType: "selected-offer",
      offerId: fixtureLine.offer_id,
      listingId: fixtureLine.listing_id,
      buyerAccountId: fixtureLine.buyer_account_id,
      buyerDisplayName: fixtureLine.buyer_display_name,
      offerPriceAmount: fixtureLine.offer_price_amount,
      offerPriceCurrencyCode: fixtureLine.offer_price_currency_code,
      offerStreamVersion: fixtureLine.offer_stream_version,
      listingPriceAmount: fixtureLine.listing_price_amount,
      listingPriceCurrencyCode: fixtureLine.listing_price_currency_code,
      listingStreamVersion: fixtureLine.listing_stream_version,
      catalogItemId: fixtureLine.catalog_catalog_item_id,
      productId: fixtureLine.product_id,
      itemTitle: fixtureLine.item_title,
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      quantity: 1,
      fallbackMode: "none",
      minimumListingPriceAmount: null,
    },
  });
}

export function sellListAttemptCases(store: () => EventStore, db: () => PgQueryable = () => catalogDb) {
  it("refuses preparation when the owned line projection lags the stream, then accepts the current projection", async () => {
    const real = store();
    const f = checkoutOwnerRuntimeFixture();
    const services = createCheckoutSellListRuntime({ ...f.deps, eventStore: real });
    await seedSelectedLine(services);
    const entry = await services.createReadinessSnapshot({ sellerAccountId: "acc_seller" });
    await services.commandHandler({
      streamId: "checkout.sell-list-acc_seller",
      context,
      command: { type: "SetSellListLineQuantity", lineId: fixtureLine.line_id as never, quantity: 2 },
    });
    const before = (await real.readAll()).length;
    const params = {
      sellerAccountId: "acc_seller",
      confirmationId: "slc_synthetic_lagged",
      entryReadinessSnapshotId: entry.snapshotId,
      reviewPlan: "synthetic targets",
      ...choices,
    };
    await expect(services.createReadinessSnapshot(params, context)).rejects.toMatchObject({
      code: "checkout_confirmation_changed",
    });
    expect((await real.readAll()).length).toBe(before);
    f.setLines([{ ...fixtureLine, quantity: 2 }]);
    const current = await services.createReadinessSnapshot({ sellerAccountId: "acc_seller" });
    expect(
      (await services.createReadinessSnapshot({ ...params, entryReadinessSnapshotId: current.snapshotId }, context))
        .status,
    ).toBe("ready");
  });
  for (const owner of ["acc_seller", "anon_attempt_seller"]) {
    it(`commit then loss: new add, merge and remove replay once for ${owner}`, async () => {
      const real = store();
      let lose = false;
      let appends = 0;
      const eventStore: EventStore = {
        ...real,
        appendToStreams: async (input) => {
          appends += 1;
          const result = await real.appendToStreams!(input);
          if (lose) {
            lose = false;
            throw new Error("synthetic acknowledgement loss");
          }
          return result;
        },
      };
      const runtime = createCheckoutSellListRuntime({ eventStore, db: db(), checkpointStore });
      const line = {
        sellerAccountId: owner as never,
        lineType: "product" as const,
        catalogItemId: "cat_attempt",
        productId: "cat_attempt::",
        itemTitle: "Synthetic Item",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 2,
      };
      const first = {
        ...line,
        attemptId: "sell-list-add-synthetic-one",
        requestHash: await computeCheckoutCommandAttemptRequestHash(line),
      };
      lose = true;
      await expect(runtime.addLine(first, context)).rejects.toThrow("acknowledgement loss");
      const added = await runtime.addLine(first, context);
      const beforeReplay = appends;
      expect(await runtime.addLine(first, context)).toEqual(added);
      expect(appends).toBe(beforeReplay);
      await expect(
        runtime.addLine(
          {
            ...first,
            quantity: 10,
            requestHash: await computeCheckoutCommandAttemptRequestHash({ ...line, quantity: 10 }),
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "checkout_attempt_conflict" });
      expect(appends).toBe(beforeReplay);
      const merge = { ...first, attemptId: "sell-list-merge-synthetic-one" };
      lose = true;
      await expect(runtime.addLine(merge, context)).rejects.toThrow("acknowledgement loss");
      const merged = await runtime.addLine(merge, context);
      expect(merged).toMatchObject({ lineId: added.lineId, status: "merged" });
      expect(await runtime.addLine(merge, context)).toEqual(merged);
      const streamId = `checkout.sell-list-${owner}`;
      let events = await readCompleteStream(real, { streamId });
      expect(events.map((event) => event.eventType)).toEqual([
        "checkout.sell-list.line-added",
        "checkout.sell-list.line-quantity-set",
      ]);
      expect(events.at(-1)?.payload).toMatchObject({ quantity: 4 });
      const beforeConflict = appends;
      await expect(
        runtime.addLine(
          {
            ...merge,
            quantity: 10,
            requestHash: await computeCheckoutCommandAttemptRequestHash({ ...line, quantity: 10 }),
          },
          context,
        ),
      ).rejects.toMatchObject({ code: "checkout_attempt_conflict" });
      expect(appends).toBe(beforeConflict);
      const remove = {
        sellerAccountId: owner as never,
        lineId: added.lineId,
        attemptId: "sell-list-remove-synthetic-one",
        requestHash: await computeCheckoutCommandAttemptRequestHash({ lineId: added.lineId }),
      };
      lose = true;
      await expect(runtime.removeLine(remove, context)).rejects.toThrow("acknowledgement loss");
      const removed = await runtime.removeLine(remove, context);
      const beforeRemoveReplay = appends;
      expect(await runtime.removeLine(remove, context)).toEqual(removed);
      expect(appends).toBe(beforeRemoveReplay);
      await expect(runtime.removeLine({ ...remove, requestHash: "b".repeat(64) }, context)).rejects.toMatchObject({
        code: "checkout_attempt_conflict",
      });
      events = await readCompleteStream(real, { streamId });
      expect(events).toHaveLength(3);
    });
    it(`concurrent exact add has one event set for ${owner}`, async () => {
      const real = store();
      const runtime = createCheckoutSellListRuntime({ eventStore: real, db: db(), checkpointStore });
      const line = {
        sellerAccountId: owner as never,
        attemptId: "sell-list-concurrent-synthetic",
        requestHash: "a".repeat(64),
        lineType: "product" as const,
        catalogItemId: "cat_attempt",
        productId: "cat_attempt::",
        itemTitle: "Synthetic Item",
        itemSubtitle: null,
        selectedOptions: [],
        productSummary: null,
        quantity: 2,
      };
      const [left, right] = await Promise.all([runtime.addLine(line, context), runtime.addLine(line, context)]);
      expect(left).toEqual(right);
      expect(await readCompleteStream(real, { streamId: `checkout.sell-list-${owner}` })).toHaveLength(1);
      const merge = { ...line, attemptId: "sell-list-concurrent-merge" };
      const merged = await Promise.all([runtime.addLine(merge, context), runtime.addLine(merge, context)]);
      expect(merged[0]).toEqual(merged[1]);
      const afterMerge = await readCompleteStream(real, { streamId: `checkout.sell-list-${owner}` });
      expect(afterMerge).toHaveLength(2);
      expect(afterMerge.at(-1)?.payload).toMatchObject({ quantity: 4 });
      const remove = {
        sellerAccountId: owner as never,
        lineId: left.lineId,
        attemptId: "sell-list-concurrent-remove",
        requestHash: "c".repeat(64),
      };
      const removed = await Promise.all([runtime.removeLine(remove, context), runtime.removeLine(remove, context)]);
      expect(removed[0]).toEqual(removed[1]);
      expect(await readCompleteStream(real, { streamId: `checkout.sell-list-${owner}` })).toHaveLength(3);
    });
  }
  it("lagged confirmation projection replays the first snapshot and rejects any changed payload, day after included", async () => {
    const real = store();
    const f = checkoutOwnerRuntimeFixture();
    const services = createCheckoutSellListRuntime({ ...f.deps, eventStore: real });
    await seedSelectedLine(services);
    const readiness = await services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices });
    expect(readiness.status).toBe("ready");
    const request = {
      sellerAccountId: "acc_seller" as never,
      confirmationId: "slc_synthetic_attempt",
      readinessSnapshotId: readiness.snapshotId,
      readinessSourceRevision: readiness.sourceRevision,
      ...choices,
      sellerEvidence: {
        shipFrom: { status: "ready" as const, addressId: null, country: "US", region: "KS", postalCode: "67202" },
        payout: {
          status: "ready" as const,
          method: "saved-payout" as const,
          readinessStatus: "ready",
          lastCheckedAt: stamp,
        },
        label: { status: "ready" as const, preference: "prepaid-label" as const },
        risk: { status: "clear" as const },
        provider: { status: "ready" as const },
        freshness: { status: "current" as const },
      },
      handoffSummary: {
        acceptedOfferCount: 1,
        publishedListingCount: 0,
        skippedLineCount: 0,
        skippedReasons: [],
        sideEffects: {
          sale: "handoff-recorded" as const,
          label: "pending-downstream" as const,
          payout: "pending-downstream" as const,
          settlement: "pending-downstream" as const,
          notification: "pending-downstream" as const,
          accountHistory: "pending-downstream" as const,
        },
      },
    };
    const [first, concurrent] = await Promise.all([
      services.confirmSellListCheckout(request, context),
      services.confirmSellListCheckout(request, context),
    ]);
    expect(concurrent).toEqual(first);
    expect(await services.confirmSellListCheckout(request, context)).toEqual(first);
    f.setLines([]);
    f.setPayout("restricted");
    expect(await services.confirmSellListCheckout(request, context)).toEqual(first);
    expect(await services.getConfirmation("acc_seller", request.confirmationId)).toEqual(first.confirmation);
    for (const changed of [
      { readinessSnapshotId: "changed" },
      { readinessSourceRevision: "changed" },
      { completedLineIds: ["sll_other" as never] },
      { remainingLineQuantities: [{ lineId: fixtureLine.line_id as never, quantity: 2 }] },
      {
        sellerEvidence: {
          ...request.sellerEvidence,
          shipFrom: { ...request.sellerEvidence.shipFrom, postalCode: "00000" },
        },
      },
    ]) {
      await expect(services.confirmSellListCheckout({ ...request, ...changed }, context)).rejects.toMatchObject({
        code: "checkout_confirmation_changed",
      });
    }
    const events = await readCompleteStream(real, { streamId: "checkout.sell-list-acc_seller" });
    expect(events.filter((event) => event.eventType === "checkout.sell-list.checkout-confirmed")).toHaveLength(1);
    expect(
      f.db.query.mock.calls.filter(([sql]) => String(sql).includes("checkout_sell_list_confirmation_pages")),
    ).toHaveLength(0);
    const poisonedStore: EventStore = {
      ...real,
      readStream: async (query) => {
        const result = await real.readStream(query);
        return result.map((event) =>
          event.eventType === "checkout.sell-list.checkout-confirmed"
            ? { ...event, payload: { ...event.payload, completedLineIds: ["sll_foreign"] } }
            : event,
        );
      },
    };
    const poisoned = createCheckoutSellListRuntime({ ...f.deps, eventStore: poisonedStore });
    await expect(poisoned.confirmSellListCheckout(request, context)).rejects.toMatchObject({
      code: "checkout_confirmation_changed",
    });
    expect(await readCompleteStream(real, { streamId: "checkout.sell-list-acc_seller" })).toHaveLength(events.length);
  });
  it("retains the original handoff basis across consumption and restart, but rechecks revocable owners and required evidence", async () => {
    const real = store();
    const f = checkoutOwnerRuntimeFixture();
    const services = createCheckoutSellListRuntime({ ...f.deps, eventStore: real });
    await seedSelectedLine(services);
    const entry = await services.createReadinessSnapshot({ sellerAccountId: "acc_seller" });
    const preparation = {
      sellerAccountId: "acc_seller",
      confirmationId: "slc_synthetic_retained",
      entryReadinessSnapshotId: entry.snapshotId,
      reviewPlan: "synthetic reviewed targets",
      ...choices,
    };
    const ready = await services.createReadinessSnapshot(preparation, context);
    expect(ready.sellerReadiness.status).toBe("ready");
    const beforeReplay = (await real.readAll()).length;
    f.setOfferAvailable(false);
    expect(
      (await services.createReadinessSnapshot({ sellerAccountId: "acc_seller", ...choices })).sellerReadiness.status,
    ).toBe("blocked");
    const restarted = createCheckoutSellListRuntime({ ...f.deps, eventStore: real });
    expect(
      await restarted.createReadinessSnapshot({
        sellerAccountId: "acc_seller",
        confirmationId: preparation.confirmationId,
      }),
    ).toEqual(entry);
    expect(await restarted.createReadinessSnapshot(preparation, context)).toEqual(ready);
    expect((await real.readAll()).length).toBe(beforeReplay);
    await expect(
      restarted.createReadinessSnapshot({ ...preparation, reviewPlan: "changed targets" }, context),
    ).rejects.toMatchObject({ code: "checkout_confirmation_changed" });
    f.setPayout("restricted");
    await expect(restarted.createReadinessSnapshot(preparation, context)).rejects.toMatchObject({
      code: "checkout_confirmation_changed",
    });
    f.setPayout("ready");
    f.ports.readRisk.mockResolvedValue(null as never);
    await expect(restarted.createReadinessSnapshot(preparation, context)).rejects.toMatchObject({
      code: "checkout_confirmation_changed",
    });
    f.ports.readRisk.mockResolvedValue(ownedAbsentRisk);
    const evidence = f.getListingEvidence();
    f.setListingEvidence(null);
    await expect(restarted.createReadinessSnapshot(preparation, context)).rejects.toMatchObject({
      code: "checkout_confirmation_changed",
    });
    f.setListingEvidence(evidence);
    const confirmed = await restarted.confirmSellListCheckout(
      {
        sellerAccountId: "acc_seller" as never,
        confirmationId: preparation.confirmationId,
        readinessSnapshotId: ready.snapshotId,
        readinessSourceRevision: ready.sourceRevision,
        ...choices,
        sellerEvidence: {} as never,
        handoffSummary: {
          acceptedOfferCount: 1,
          publishedListingCount: 0,
          skippedLineCount: 0,
          skippedReasons: [],
          sideEffects: {
            sale: "handoff-recorded",
            label: "pending-downstream",
            payout: "pending-downstream",
            settlement: "pending-downstream",
            notification: "pending-downstream",
            accountHistory: "pending-downstream",
          },
        },
      },
      context,
    );
    expect(confirmed.status).toBe("confirmed");
  });
}
