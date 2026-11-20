import { describe, expect, it, vi } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { AppendToStreamsResult } from "@chase-sets/event-core/event-store";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { managedFixture } from "../tests/managed-fixture";
import { context, terms } from "../../offer-policy/tests/fixtures";

describe("managed Offer application and commitment", () => {
  it("rejects a policy-bound suspended buyer before managed acceptance", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const params = await f.acceptance();
    const policyBefore = await f.policies.get("bop_one", "acc_buyer");
    f.evaluateTargets.mockClear();
    const fixtureRow = (await f.db.query()).rows[0]!;
    f.db.query.mockResolvedValue({ rows: [{ ...fixtureRow, account_status: "suspended" }], rowCount: 1 });

    await expect(
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
    ).rejects.toMatchObject({ code: "offer_not_open" });
    expect(f.evaluateTargets).not.toHaveBeenCalled();
    const policyAfter = await f.policies.get("bop_one", "acc_buyer");
    expect(policyAfter.version).toBe(policyBefore.version);
    expect(policyAfter.revision).toBe(policyBefore.revision);
  });

  it.each(["acceptance", "price edit"] as const)(
    "records exactly the returned managed %s events",
    async (operation) => {
      const f = await managedFixture(createInMemoryEventStore().eventStore);
      const append = vi.spyOn(f.store, "appendToStreams");
      const params = await f.acceptance();
      await runWithEventCommitMetadata(async () => {
        if (operation === "acceptance")
          await f.offers.acceptOffer(params, {
            ...context,
            audit: { ...context.audit, forAccountId: params.sellerAccountId },
          });
        else
          await f.offers.updateOfferPrice(
            {
              attemptId: "test_attempt_1058_identity",
              offerId: "off_one" as never,
              buyerAccountId: "acc_buyer" as never,
              priceAmount: "11.00",
              priceCurrencyCode: "USD",
            },
            { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" as never } },
          );
        const results: readonly AppendToStreamsResult[] = await append.mock.results.at(-1)!.value;
        const returned = results.flatMap((batch) => batch.storedEvents);
        expect(returned.map((event) => event.eventType)).toEqual(
          operation === "acceptance"
            ? [
                "marketplace.offer.accepted",
                "marketplace.listing.evidence-requirements-refreshed",
                "marketplace.listing.offer-commitment-recorded",
                "marketplace.seller-listing-availability.commitment-checked",
                "marketplace.mutation-attempt.completed",
              ]
            : [
                "marketplace.offer.price-updated",
                "marketplace.offer.managed-evaluated",
                "marketplace.mutation-attempt.completed",
              ],
        );
        const eventIds = returned.map((event) => String(event.eventId));
        const maxGlobalPosition = String(returned.at(-1)!.globalPosition);
        expect(getEventCommitMetadata()).toEqual({
          committedEvents: returned,
          eventIds,
          maxGlobalPosition,
          sources: [{ sourceContextName: "marketplace", eventIds, maxGlobalPosition }],
        });
      });
      append.mockClear();
      await runWithEventCommitMetadata(async () => {
        if (operation === "acceptance")
          await f.offers.acceptOffer(params, {
            ...context,
            audit: { ...context.audit, forAccountId: params.sellerAccountId },
          });
        else
          await f.offers.updateOfferPrice(
            {
              attemptId: "test_attempt_1058_identity",
              offerId: "off_one" as never,
              buyerAccountId: "acc_buyer" as never,
              priceAmount: "11.00",
              priceCurrencyCode: "USD",
            },
            { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" as never } },
          );
        expect(getEventCommitMetadata().eventIds).toEqual([]);
      });
      expect(append).not.toHaveBeenCalled();
    },
  );

  it.each(["acceptance", "price edit"] as const)(
    "records no managed %s receipt when append fails",
    async (operation) => {
      const f = await managedFixture(createInMemoryEventStore().eventStore);
      const params = await f.acceptance();
      vi.spyOn(f.store, "appendToStreams").mockRejectedValueOnce(new Error("injected append failure"));
      const before = await f.store.readAll();
      await runWithEventCommitMetadata(async () => {
        await expect(
          operation === "acceptance"
            ? f.offers.acceptOffer(params, {
                ...context,
                audit: { ...context.audit, forAccountId: params.sellerAccountId },
              })
            : f.offers.updateOfferPrice(
                {
                  attemptId: "test_attempt_3646_identity",
                  offerId: "off_one" as never,
                  buyerAccountId: "acc_buyer" as never,
                  priceAmount: "11.00",
                  priceCurrencyCode: "USD",
                },
                { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" as never } },
              ),
        ).rejects.toThrow("injected append failure");
        expect(getEventCommitMetadata().eventIds).toEqual([]);
      });
      expect(await f.store.readAll()).toEqual(before);
    },
  );

  it("records no managed acceptance receipt on conflict recovery", async () => {
    const store = createInMemoryEventStore().eventStore;
    const f = await managedFixture(store);
    const params = await f.acceptance();
    const append = store.appendToStreams!;
    vi.spyOn(store, "appendToStreams").mockImplementationOnce(async (inputs) => {
      await append(inputs);
      throw Object.assign(new Error("concurrent duplicate committed"), { code: "concurrency_conflict" });
    });
    await runWithEventCommitMetadata(async () => {
      expect(
        await f.offers.acceptOffer(params, {
          ...context,
          audit: { ...context.audit, forAccountId: params.sellerAccountId },
        }),
      ).toMatchObject({ offerId: "off_one", version: 3 });
      expect(getEventCommitMetadata().eventIds).toEqual([]);
    });
  });

  it("batches a Product page into one Pricing read without changing policy authority", async () => {
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
    expect((await f.policies.get("bop_one", "acc_buyer")).version).toBe(3);
  });

  it("rejects an evaluation after an authority revision at append", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    f.evaluateTargets.mockImplementationOnce(async () => {
      const preview = await f.policies.execute(
        "bop_one",
        {
          attemptId: String("revision_preview").padEnd(22, "_"),
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
          attemptId: String("revision").padEnd(22, "_"),
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
      await f.offers.acceptOffer(params, {
        ...context,
        audit: { ...context.audit, forAccountId: params.sellerAccountId },
      });
      return [{ status: "target", unitItemAmount: "12.00", evidence: {} }];
    });
    await expect(f.offers.applyManagedOffer("off_one" as never, "late_evaluation", context)).rejects.toMatchObject({
      code: "managed_offer_conflict",
    });
    const events = await f.store.readStream({ streamId: "marketplace.offer-off_one" });
    expect(events.at(-1)).toMatchObject({ eventType: "marketplace.offer.accepted", payload: { priceAmount: "10.00" } });
    expect((await f.policies.get("bop_one", "acc_buyer")).version).toBe(3);
  });
  it("accepts both Offers sharing one policy without a debit, fencing every authoritative stream", async () => {
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
    const results = await Promise.allSettled(
      params.map((p) =>
        f.offers.acceptOffer(p, { ...context, audit: { ...context.audit, forAccountId: p.sellerAccountId } }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect((await f.policies.get("bop_one", "acc_buyer")).version).toBe(3);
    const events = await memory.readAll();
    expect(events.filter((e) => e.eventType === "marketplace.offer.accepted")).toHaveLength(2);
    expect(events.filter((e) => e.eventType === "marketplace.offer-policy.commitment-consumed")).toHaveLength(0);
    expect(appends.slice(-2).map((inputs) => inputs[0]!.events)).toEqual([[], []]);
    expect(appends.at(-1)!.map((a) => [a.streamId, a.expectedVersion])).toEqual([
      ["marketplace.offer-policy-bop_one", 3],
      ["marketplace.offer-off_two", 2],
      ["marketplace.listing-lst_two", 2],
      ["marketplace.seller-listing-availability-acc_two", "no_stream"],
      [expect.stringMatching(/^marketplace\.offer-acceptance-attempt-v1-/), "no_stream"],
    ]);
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
    await expect(
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
    ).rejects.toThrow("timeout after commit");
    await f.policies.execute(
      "bop_one",
      {
        attemptId: String("pause").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: 3,
        operationId: "pause",
      },
      context,
    );
    const replay = await Promise.all([
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
    ]);
    expect(replay[0]).toEqual(replay[1]);
    expect(
      (await memory.readAll()).filter((e) => e.eventType === "marketplace.offer-policy.commitment-consumed"),
    ).toHaveLength(0);
    expect((await f.policies.get("bop_one", "acc_buyer")).status).toBe("paused");
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
      interleave = () =>
        f.policies.execute(
          "bop_one",
          { attemptId: String("stop").padEnd(22, "_"), type, expectedVersion: 3, operationId: "stop" },
          context,
        );
      await expect(
        f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
      ).rejects.toMatchObject({ code: "managed_offer_conflict" });
      await expect(f.offers.applyManagedOffer("off_one" as never, "work", context)).rejects.toThrow("active");
      expect((await memory.readAll()).filter((e) => e.eventType === "marketplace.offer.accepted")).toHaveLength(0);
      expect((await f.policies.get("bop_one", "acc_buyer")).version).toBe(4);
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
    await expect(
      f.offers.acceptOffer(await f.acceptance(), { ...context, audit: { ...context.audit, forAccountId: "acc_one" } }),
    ).rejects.toMatchObject({
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
    await expect(
      f.offers.acceptOffer(before, { ...context, audit: { ...context.audit, forAccountId: before.sellerAccountId } }),
    ).rejects.toMatchObject({
      code: "managed_offer_refresh_required",
    });
    await f.offers.applyManagedOffer("off_one" as never, "changed", context);
    await expect(
      f.offers.acceptOffer(before, { ...context, audit: { ...context.audit, forAccountId: before.sellerAccountId } }),
    ).rejects.toMatchObject({
      name: "MarketplaceOfferFeeQuoteStaleError",
    });
    await f.offers.acceptOffer(await f.acceptance(), {
      ...context,
      audit: { ...context.audit, forAccountId: "acc_one" },
    });
    const committed = await f.store.readAll();
    f.setTarget({ status: "target", unitItemAmount: "13.00", evidence: {} });
    expect(await f.offers.applyManagedOffer("off_one" as never, "late", context)).toMatchObject({
      status: "unchanged",
    });
    expect(await f.store.readAll()).toEqual(committed);
    expect((await f.policies.get("bop_one", "acc_buyer")).version).toBe(3);
  });

  it("enforces manual edits without unbinding, and invalidates confirmation after Listing movement", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const update = (priceAmount: string, priceCurrencyCode = "USD") =>
      f.offers.updateOfferPrice(
        {
          attemptId: crypto.randomUUID(),
          offerId: "off_one" as never,
          buyerAccountId: "acc_buyer" as never,
          priceAmount,
          priceCurrencyCode,
        },
        { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" as never } },
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
    await expect(
      f.offers.acceptOffer(params, { ...context, audit: { ...context.audit, forAccountId: params.sellerAccountId } }),
    ).rejects.toMatchObject({
      name: "MarketplaceOfferFeeQuoteStaleError",
    });
    await f.policies.execute(
      "bop_one",
      {
        attemptId: String("pause").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: 3,
        operationId: "pause",
      },
      context,
    );
    await expect(update("10.00")).rejects.toThrow("active");
  });
});
