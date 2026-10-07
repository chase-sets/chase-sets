import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { managedFixture } from "../tests/managed-fixture";
import { context, terms } from "../../offer-policy/tests/fixtures";

describe("managed Offer application and commitment", () => {
  it("batches a Product page into one Pricing read and writes no allowance for repricing", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    expect(f.evaluateTargets).toHaveBeenCalledTimes(2);
    f.evaluateTargets.mockClear();
    f.setTarget({ status: "target", unitItemAmount: "12.00", evidence: {} });
    await f.store.appendToStream({
      streamId: "marketplace.offer-work-batch",
      expectedVersion: 0,
      context,
      events: [{ eventType: "marketplace.offer.work-claimed", payload: {} }],
    });
    await f.offers.applyManagedOfferPage(
      ["off_one", "off_two"].map((offerId) => ({ offerId: offerId as never, operationId: `batch_${offerId}` })),
      context,
      { streamId: "marketplace.offer-work-batch", expectedVersion: 1, context, events: [] },
    );
    expect(f.evaluateTargets).toHaveBeenCalledTimes(1);
    expect(f.evaluateTargets.mock.calls[0]![0]).toHaveLength(2);
    expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("0.00");
  });

  it("rejects an evaluation after an authority revision at append", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.evaluateTargets.mockImplementationOnce(async () => {
      const preview = await f.policies.execute(
        "bop_one",
        {
          type: "PreviewBuyerOfferPolicy",
          expectedVersion: 3,
          operationId: "revision_preview",
          terms: {
            ...terms,
            offers: ["off_one", "off_two"].map((offerId) => ({ ...terms.offers[0]!, offerId, offerVersion: 2 })),
          },
        },
        context,
      );
      await f.policies.execute(
        "bop_one",
        {
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: 4,
          operationId: "revision",
          previewId: preview.preview!.previewId,
          consent: true,
        },
        context,
      );
      return [{ status: "target", unitItemAmount: "12.00", evidence: {} }];
    });
    await expect(f.offers.applyManagedOffer("off_one" as never, "old_revision", context)).rejects.toMatchObject({
      code: "managed_offer_conflict",
    });
    expect(await f.store.readStream({ streamId: "marketplace.offer-off_one" })).toHaveLength(2);
  });

  it("cannot apply stale evaluation after an acceptance committed during evaluation", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const params = await f.acceptance();
    f.evaluateTargets.mockImplementationOnce(async () => {
      await f.offers.acceptOffer(params, context);
      return [{ status: "target", unitItemAmount: "12.00", evidence: {} }];
    });
    await expect(f.offers.applyManagedOffer("off_one" as never, "late_evaluation", context)).rejects.toMatchObject({
      code: "managed_offer_conflict",
    });
    const events = await f.store.readStream({ streamId: "marketplace.offer-off_one" });
    expect(events.at(-1)).toMatchObject({ eventType: "marketplace.offer.accepted", payload: { priceAmount: "10.00" } });
    expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("20.00");
  });
  it("shares lifetime allowance across different Offers, fencing every authoritative stream", async () => {
    const memory = createInMemoryEventStore().eventStore;
    const appends: (readonly AppendToStreamInput[])[] = [];
    const f = await managedFixture({
      ...memory,
      appendToStreams: async (inputs) => {
        appends.push(inputs);
        return memory.appendToStreams!(inputs);
      },
    });
    const params = await Promise.all([f.acceptance("one"), f.acceptance("two")]);
    const results = await Promise.allSettled(params.map((p) => f.offers.acceptOffer(p, context)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("20.00");
    const events = await memory.readAll();
    expect(events.filter((e) => e.eventType === "marketplace.offer.accepted")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "marketplace.offer-policy.commitment-consumed")).toHaveLength(1);
    expect(appends.at(-1)!.map((a) => [a.streamId, a.expectedVersion])).toEqual([
      ["marketplace.offer-policy-bop_one", 3],
      ["marketplace.offer-off_two", 2],
      ["marketplace.listing-lst_two", 2],
      ["marketplace.seller-listing-availability-acc_two", "no_stream"],
    ]);
    const loser = results[0]!.status === "rejected" ? 0 : 1;
    await expect(f.offers.acceptOffer(params[loser]!, context)).rejects.toMatchObject({ code: "managed_offer_held" });
  });

  it("replays a timeout-after-commit and concurrent duplicate acceptance once even after pause", async () => {
    const memory = createInMemoryEventStore().eventStore;
    let timeout = false;
    const f = await managedFixture({
      ...memory,
      appendToStreams: async (inputs) => {
        const result = await memory.appendToStreams!(inputs);
        if (timeout) {
          timeout = false;
          throw new Error("timeout after commit");
        }
        return result;
      },
    });
    const params = await f.acceptance();
    timeout = true;
    await expect(f.offers.acceptOffer(params, context)).rejects.toThrow("timeout after commit");
    await f.policies.execute(
      "bop_one",
      { type: "PauseBuyerOfferPolicy", expectedVersion: 4, operationId: "pause" },
      context,
    );
    const replay = await Promise.all([f.offers.acceptOffer(params, context), f.offers.acceptOffer(params, context)]);
    expect(replay[0]).toEqual(replay[1]);
    expect(
      (await memory.readAll()).filter((e) => e.eventType === "marketplace.offer-policy.commitment-consumed"),
    ).toHaveLength(1);
    expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("20.00");
  });

  it.each(["PauseBuyerOfferPolicy", "StopBuyerOfferPolicy"] as const)(
    "%s winning before append prevents acceptance and application",
    async (type) => {
      const memory = createInMemoryEventStore().eventStore;
      let interleave: (() => Promise<unknown>) | undefined;
      const f = await managedFixture({
        ...memory,
        appendToStreams: async (inputs) => {
          const action = interleave;
          interleave = undefined;
          if (action) await action();
          return memory.appendToStreams!(inputs);
        },
      });
      const params = await f.acceptance();
      interleave = () => f.policies.execute("bop_one", { type, expectedVersion: 3, operationId: "stop" }, context);
      await expect(f.offers.acceptOffer(params, context)).rejects.toMatchObject({ code: "managed_offer_conflict" });
      await expect(f.offers.applyManagedOffer("off_one" as never, "work", context)).rejects.toThrow("active");
      expect((await memory.readAll()).filter((e) => e.eventType === "marketplace.offer.accepted")).toHaveLength(0);
      expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("0.00");
    },
  );

  it("holds unavailable evidence without price writes, preserves trace, and deduplicates work", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.setTarget({ status: "held", reason: "market-price-stale", evidence: { estimateVersion: "7" } });
    expect(await f.offers.applyManagedOffer("off_one" as never, "work_one", context)).toMatchObject({ status: "held" });
    await f.offers.applyManagedOffer("off_one" as never, "work_one", context);
    const events = await f.store.readStream({ streamId: "marketplace.offer-off_one" });
    expect(events).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      eventType: "marketplace.offer.managed-evaluated",
      payload: {
        reason: "market-price-stale",
        policyVersion: 3,
        evidence: { estimateVersion: "7" },
      },
    });
    await expect(f.offers.acceptOffer(await f.acceptance(), context)).rejects.toMatchObject({
      code: "managed_offer_held",
    });
  });

  it("does not accept a changed target, requires a new confirmation, and never reprices an accepted Offer", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const before = await f.acceptance();
    expect(await f.offers.applyManagedOffer("off_one" as never, "unchanged", context)).toMatchObject({
      status: "unchanged",
      version: 2,
    });
    f.setTarget({ status: "target", unitItemAmount: "12.00", evidence: { estimateVersion: "2" } });
    await expect(f.offers.acceptOffer(before, context)).rejects.toMatchObject({
      code: "managed_offer_refresh_required",
    });
    await f.offers.applyManagedOffer("off_one" as never, "changed", context);
    await expect(f.offers.acceptOffer(before, context)).rejects.toMatchObject({
      name: "MarketplaceOfferFeeQuoteStaleError",
    });
    await f.offers.acceptOffer(await f.acceptance(), context);
    const committed = await f.store.readAll();
    f.setTarget({ status: "target", unitItemAmount: "13.00", evidence: {} });
    expect(await f.offers.applyManagedOffer("off_one" as never, "late", context)).toMatchObject({
      status: "unchanged",
    });
    expect(await f.store.readAll()).toEqual(committed);
    expect((await f.policies.get("bop_one", "acc_buyer")).consumedItemAmount).toBe("24.00");
  });

  it("enforces manual edits without unbinding, and invalidates confirmation after Listing movement", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const update = (priceAmount: string, priceCurrencyCode = "USD") =>
      f.offers.updateOfferPrice(
        {
          offerId: "off_one" as never,
          buyerAccountId: "acc_buyer" as never,
          priceAmount,
          priceCurrencyCode,
        },
        context,
      );
    await expect(update("21.00")).rejects.toThrow("maximum");
    await expect(update("10.00", "EUR")).rejects.toThrow("currency");
    await update("11.00");
    f.setTarget({ status: "target", unitItemAmount: "11.00", evidence: {} });
    const params = await f.acceptance();
    await f.store.appendToStream({
      streamId: "marketplace.listing-lst_one",
      expectedVersion: 2,
      context,
      events: [
        { eventType: "marketplace.listing.price-updated", payload: { priceAmount: "12.00", priceCurrencyCode: "USD" } },
      ],
    });
    await expect(f.offers.acceptOffer(params, context)).rejects.toMatchObject({
      name: "MarketplaceOfferFeeQuoteStaleError",
    });
    await f.policies.execute(
      "bop_one",
      { type: "PauseBuyerOfferPolicy", expectedVersion: 3, operationId: "pause" },
      context,
    );
    await expect(update("10.00")).rejects.toThrow("active");
  });
});
