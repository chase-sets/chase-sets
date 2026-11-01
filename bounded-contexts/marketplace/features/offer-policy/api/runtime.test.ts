import { describe, expect, it } from "vitest";
import { buildListingEvidenceSnapshot } from "../../listings/domain/evidence-snapshot";
import type { BuyerOfferPolicyRequest } from "../domain/contracts";
import { activate, context, fixture, preview, seedOffer, terms } from "../tests/fixtures";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { managedFixture } from "../../offers/tests/managed-fixture";
import { createBuyerOfferPolicyRuntime } from "./runtime";
import { vi } from "vitest";
import type { ManagedOfferTarget } from "../../offers/api/managed-authority";
import { evolveBuyerOfferPolicy, initialBuyerOfferPolicyState } from "../domain/domain";
import { buyerOfferPolicyCodec } from "../domain/codec";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { AppendToStreamsResult } from "@chase-sets/event-core/event-store";

describe("Buyer Offer Policy authoritative runtime", () => {
  it("projects held Pricing results onto the Marketplace port before retaining the first preview", async () => {
    const { store, db } = await fixture();
    const runtime = createBuyerOfferPolicyRuntime({
      eventStore: store,
      db,
      managedOfferPricing: {
        evaluateTargets: async (requests) =>
          requests.map(() => ({
            status: "held" as const,
            reason: "market-price-unavailable",
            buyerCopy: "Pricing-owned display copy outside the Marketplace port.",
            evidence: { marketPrice: null },
          })),
      },
    });
    const first = await preview(runtime);
    expect(first.preview!.outcomes![0]!.result).toEqual({
      status: "held",
      reason: "market-price-unavailable",
      evidence: { marketPrice: null },
    });
    const append = vi.spyOn(store, "appendToStreams");
    expect(await preview(runtime)).toEqual(first);
    expect(append).not.toHaveBeenCalled();
  });

  it("records exactly the returned policy and every Authorize binding event, but not replay or empty decisions", async () => {
    const { runtime, store } = await fixture();
    await seedOffer(store, "off_two");
    const append = vi.spyOn(store, "appendToStreams");
    const p = await preview(runtime, {
      ...terms,
      offers: [...terms.offers, { ...terms.offers[0]!, offerId: "off_two" }],
    });
    const command = {
      attemptId: String("receipt_authorize").padEnd(22, "_"),
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      previewId: p.preview!.previewId,
      consent: true,
      operationId: "receipt_authorize",
    } as const;
    const active = await runWithEventCommitMetadata(async () => {
      const result = await runtime.execute("bop_one", command, context);
      const results: readonly AppendToStreamsResult[] = await append.mock.results.at(-1)!.value;
      const returned = results.flatMap((batch) => batch.storedEvents);
      expect(returned.map((event) => event.streamId)).toEqual([
        "marketplace.offer-policy-bop_one",
        "marketplace.offer-off_one",
        "marketplace.offer-off_two",
        expect.stringMatching(/^marketplace\.offer-attempt-v1-/),
      ]);
      const eventIds = returned.map((event) => String(event.eventId));
      const maxGlobalPosition = String(returned.at(-1)!.globalPosition);
      expect(getEventCommitMetadata()).toEqual({
        committedEvents: returned,
        eventIds,
        maxGlobalPosition,
        sources: [{ sourceContextName: "marketplace", eventIds, maxGlobalPosition }],
      });
      return result;
    });
    expect(active).toEqual(await runtime.get("bop_one", "acc_buyer"));
    append.mockClear();
    await runWithEventCommitMetadata(async () => {
      expect(await runtime.execute("bop_one", command, context)).toEqual(active);
      expect(getEventCommitMetadata().eventIds).toEqual([]);
      const paused = await runtime.execute(
        "bop_one",
        {
          attemptId: String("receipt_pause").padEnd(22, "_"),
          type: "PauseBuyerOfferPolicy",
          expectedVersion: active.version,
          operationId: "receipt_pause",
        },
        context,
      );
      await runWithEventCommitMetadata(async () => {
        expect(
          await runtime.execute(
            "bop_one",
            {
              attemptId: String("receipt_empty").padEnd(22, "_"),
              type: "PauseBuyerOfferPolicy",
              expectedVersion: paused.version,
              operationId: "receipt_empty",
            },
            context,
          ),
        ).toEqual(paused);
        expect(getEventCommitMetadata().committedEvents.map((event) => event.eventType)).toEqual([
          "marketplace.mutation-attempt.completed",
        ]);
      });
    });
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("records only returned policy events when Preview has empty Offer guards", async () => {
    const { runtime, store } = await fixture();
    const append = vi.spyOn(store, "appendToStreams");
    await runWithEventCommitMetadata(async () => {
      await preview(runtime);
      const results: readonly AppendToStreamsResult[] = await append.mock.results.at(-1)!.value;
      const returned = results.flatMap((batch) => batch.storedEvents);
      expect(returned.map((event) => event.streamId)).toEqual([
        "marketplace.offer-policy-bop_one",
        expect.stringMatching(/^marketplace\.offer-attempt-v1-/),
      ]);
      expect(getEventCommitMetadata().committedEvents).toEqual(returned);
    });
  });

  it.each(["failure", "conflict-recovery"] as const)("records no policy receipt on %s", async (outcome) => {
    let intercept = false;
    const { runtime } = await fixture(true, (store) => ({
      ...store,
      appendToStreams: async (inputs) => {
        if (!intercept) return store.appendToStreams!(inputs);
        if (outcome === "failure") throw new Error("injected append failure");
        await store.appendToStreams!(inputs);
        throw Object.assign(new Error("concurrent duplicate committed"), { code: "concurrency_conflict" });
      },
    }));
    const p = await preview(runtime);
    intercept = true;
    await runWithEventCommitMetadata(async () => {
      const action = runtime.execute(
        "bop_one",
        {
          attemptId: String("receipt_race").padEnd(22, "_"),
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: p.version,
          previewId: p.preview!.previewId,
          consent: true,
          operationId: "receipt_race",
        },
        context,
      );
      if (outcome === "failure") await expect(action).rejects.toThrow("injected append failure");
      else expect((await action).status).toBe("active");
      expect(getEventCommitMetadata()).toEqual({
        committedEvents: [],
        eventIds: [],
        sources: [],
        maxGlobalPosition: undefined,
      });
    });
  });

  it("resumes the same bound Offer from snapshot versions while the projection stays at N", async () => {
    const { runtime, store } = await fixture();
    const active = await activate(runtime);
    const paused = await runtime.execute(
      "bop_one",
      {
        attemptId: String("pause_lag").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: active.version,
        operationId: "pause_lag",
      },
      context,
    );
    expect(await store.readStream({ streamId: "marketplace.offer-off_one" })).toHaveLength(2);
    const versions = paused.offerVersions;
    const resumedPreview = await preview(
      runtime,
      {
        ...terms,
        offers: terms.offers.map((offer) => ({
          ...offer,
          offerVersion: versions?.[offer.offerId] ?? offer.offerVersion,
        })),
      },
      paused.version,
      "resume_lag",
    ).catch((error: unknown) => {
      const failure = error as { code: string; message: string };
      throw new Error(`resume Preview: ${failure.code}: ${failure.message}; projected=1 authoritative=2`);
    });
    expect(resumedPreview.preview?.terms.offers[0]?.offerVersion).toBe(2);
    expect(active.authority?.offers[0]?.offerVersion).toBe(1);
    expect(active.offerVersions).toEqual({ off_one: 2 });
    expect((await runtime.get("bop_one", "acc_buyer")).offerVersions).toEqual({ off_one: 2 });
  });
  it.each(["absent", "lagging", "partial", "fresh"] as const)(
    "returns authoritative bound policies and versions with %s projections, including replay and Stop",
    async (projection) => {
      const { runtime, store, db } = await fixture();
      await seedOffer(store, "off_two");
      await seedOffer(store, "off_foreign", "acc_other");
      const active = await activate(runtime);
      const policyEvents = await store.readStream({ streamId: "marketplace.offer-policy-bop_one" });
      const projectedState = policyEvents
        .map(buyerOfferPolicyCodec.decode)
        .reduce(evolveBuyerOfferPolicy, initialBuyerOfferPolicyState);
      const pause = {
        attemptId: String("pause_snapshot").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: active.version,
        operationId: "pause_snapshot",
      } as const;
      const paused = await runtime.execute("bop_one", pause, context);
      const stopped = await runtime.execute(
        "bop_one",
        {
          attemptId: String("stop_snapshot").padEnd(22, "_"),
          type: "StopBuyerOfferPolicy",
          expectedVersion: paused.version,
          operationId: "stop_snapshot",
        },
        context,
      );
      await runtime.execute(
        "bop_two",
        {
          attemptId: String("create_two").padEnd(22, "_"),
          type: "CreateBuyerOfferPolicy",
          expectedVersion: 0,
          operationId: "create_two",
        },
        context,
      );
      const otherPreview = await runtime.execute(
        "bop_two",
        {
          attemptId: String("preview_two").padEnd(22, "_"),
          type: "PreviewBuyerOfferPolicy",
          expectedVersion: 1,
          operationId: "preview_two",
          terms: { ...terms, offers: [{ ...terms.offers[0]!, offerId: "off_two" }] },
        },
        context,
      );
      await runtime.execute(
        "bop_two",
        {
          attemptId: String("authorize_two").padEnd(22, "_"),
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: otherPreview.version,
          operationId: "authorize_two",
          previewId: otherPreview.preview!.previewId,
          consent: true,
        },
        context,
      );
      const stoppedEvents = await store.readStream({ streamId: "marketplace.offer-policy-bop_one" });
      const stoppedState = stoppedEvents
        .map(buyerOfferPolicyCodec.decode)
        .reduce(evolveBuyerOfferPolicy, initialBuyerOfferPolicyState);
      const rows =
        projection === "absent"
          ? []
          : [
              {
                state: projection === "fresh" ? stoppedState : projectedState,
                last_stream_version: projection === "fresh" ? stopped.version : active.version,
              },
            ];
      if (projection === "lagging" || projection === "fresh") {
        const otherEvents = await store.readStream({ streamId: "marketplace.offer-policy-bop_two" });
        rows.push({
          state: otherEvents
            .map(buyerOfferPolicyCodec.decode)
            .reduce(evolveBuyerOfferPolicy, initialBuyerOfferPolicyState),
          last_stream_version: otherEvents.length,
        });
      }
      db.query.mockResolvedValue({ rows, rowCount: rows.length } as never);
      const list = await runtime.list("acc_buyer", "", 100, ["off_one", "off_two", "off_foreign", "off_missing"]);
      expect(list.items.map((item) => [item.policyId, item.status])).toEqual([
        ["bop_one", "stopped"],
        ["bop_two", "active"],
      ]);
      expect(list.offerVersions).toEqual({ off_one: 2, off_two: 2 });
      expect(list.items[0]).toEqual(stopped);
      expect(await runtime.execute("bop_one", pause, context)).toMatchObject({
        status: "paused",
        version: pause.expectedVersion + 1,
      });
      expect(await runtime.get("bop_one", "acc_buyer")).toEqual(stopped);
      const page = await runtime.list("acc_buyer", "bop_one", 1, ["off_one", "off_two"]);
      expect(page.items.map((item) => item.policyId)).toEqual(["bop_two"]);
      expect(page.nextCursor).toBe("bop_two");
    },
  );
  it("reports interleaved Offer drift as stale_preview without rewriting consent-bound terms or appending", async () => {
    const { runtime, store } = await fixture();
    const active = await activate(runtime);
    const paused = await runtime.execute(
      "bop_one",
      {
        attemptId: String("pause_drift").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: active.version,
        operationId: "pause_drift",
      },
      context,
    );
    await store.appendToStream({
      streamId: "marketplace.offer-off_one",
      expectedVersion: 2,
      context,
      events: [
        {
          eventType: "marketplace.offer.price-updated",
          payload: {
            offerId: "off_one",
            buyerAccountId: "acc_buyer",
            priceAmount: "11.00",
            priceCurrencyCode: "USD",
          },
        },
      ],
    });
    const before = await store.readAll();
    await expect(
      preview(
        runtime,
        { ...terms, offers: [{ ...terms.offers[0]!, offerVersion: paused.offerVersions.off_one! }] },
        paused.version,
        "stale_resume",
      ),
    ).rejects.toMatchObject({
      code: "stale_preview",
      message: "Offer selection is stale. Request a fresh preview.",
    });
    expect(await store.readAll()).toEqual(before);
    const refreshed = await runtime.get("bop_one", "acc_buyer");
    expect(refreshed.offerVersions).toEqual({ off_one: 3 });
    expect(refreshed.authority).toEqual(active.authority);
  });
  it("accepts identical nested evidence after JSONB changes object key order", async () => {
    const { store, db } = await fixture();
    let reordered = false;
    const runtime = createBuyerOfferPolicyRuntime({
      eventStore: store,
      db,
      enforcement: { assertInstalled() {} },
      managedOfferPricing: {
        evaluateTargets: async (requests) =>
          requests.map(() => ({
            status: "target" as const,
            unitItemAmount: "10.00",
            evidence: {
              marketPrice: reordered
                ? { freshUntil: "2026-09-29T00:00:00.000Z", estimateVersion: "1", amount: "10.00" }
                : { amount: "10.00", estimateVersion: "1", freshUntil: "2026-09-29T00:00:00.000Z" },
            },
          })),
      },
    });
    const p = await preview(runtime);
    reordered = true;
    expect(
      (
        await runtime.execute(
          "bop_one",
          {
            attemptId: String("reordered").padEnd(22, "_"),
            type: "AuthorizeBuyerOfferPolicy",
            operationId: "reordered",
            expectedVersion: p.version,
            previewId: p.preview!.previewId,
            consent: true,
          },
          context,
        )
      ).status,
    ).toBe("active");
  });
  it("previews target and held evidence at draft revision 1 and binds every price-only/evidence change", async () => {
    const { store, db } = await fixture();
    await seedOffer(store, "off_two");
    let amount = "12.00";
    let estimateVersion = "1";
    const evaluateTargets = vi.fn(
      async (requests: readonly { policyRevision: number; evaluatedAt: string }[]): Promise<ManagedOfferTarget[]> => {
        expect(requests.every((request) => request.policyRevision === 1)).toBe(true);
        return requests.map((request, index) =>
          index === 0
            ? {
                status: "target",
                unitItemAmount: amount,
                evidence: {
                  marketPrice: { amount, estimateVersion, freshUntil: "2026-09-29T00:00:00.000Z" },
                  evaluatedAt: request.evaluatedAt,
                },
              }
            : {
                status: "held",
                reason: "market-price-unavailable",
                evidence: { marketPrice: null, evaluatedAt: request.evaluatedAt },
              },
        );
      },
    );
    const runtime = createBuyerOfferPolicyRuntime({
      eventStore: store,
      db,
      managedOfferPricing: { evaluateTargets },
      enforcement: { assertInstalled() {} },
    });
    const selected = { ...terms, offers: [...terms.offers, { ...terms.offers[0]!, offerId: "off_two" }] };
    const p = await preview(runtime, selected);
    expect(p.preview!.outcomes).toMatchObject([
      {
        offerId: "off_one",
        currentUnitItemAmount: "10.00",
        result: { status: "target", unitItemAmount: "12.00", evidence: { marketPrice: { estimateVersion: "1" } } },
      },
      {
        offerId: "off_two",
        result: { status: "held", reason: "market-price-unavailable", evidence: { marketPrice: null } },
      },
    ]);
    expect(evaluateTargets).toHaveBeenCalledTimes(1);
    const command = {
      attemptId: String("evidence_authorize").padEnd(22, "_"),
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      previewId: p.preview!.previewId,
      operationId: "evidence_authorize",
      consent: true,
    } as const;
    amount = "13.00";
    await expect(runtime.execute("bop_one", command, context)).rejects.toMatchObject({ code: "stale_preview" });
    amount = "12.00";
    estimateVersion = "2";
    await expect(runtime.execute("bop_one", command, context)).rejects.toMatchObject({ code: "stale_preview" });
    estimateVersion = "1";
    expect((await runtime.execute("bop_one", command, context)).status).toBe("active");
  });
  it("keeps owner reads free of retired limits across acceptance, pause, fresh consent, resume and stop", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const accepted = await f.acceptance();
    const outcome = await f.offers.acceptOffer(accepted, {
      ...context,
      audit: { ...context.audit, forAccountId: accepted.sellerAccountId },
    });
    const paused = await f.policies.execute(
      "bop_one",
      {
        attemptId: String("pause").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: 3,
        operationId: "pause",
      },
      context,
    );
    const fresh = await f.policies.execute(
      "bop_one",
      {
        attemptId: String("resume_preview").padEnd(22, "_"),
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: paused.version,
        operationId: "resume_preview",
        terms: {
          ...terms,
          offers: [{ ...terms.offers[0]!, offerId: "off_two", offerVersion: 2 }],
        },
      },
      context,
    );
    const resumed = await f.policies.execute(
      "bop_one",
      {
        attemptId: String("resume").padEnd(22, "_"),
        type: "AuthorizeBuyerOfferPolicy",
        expectedVersion: fresh.version,
        operationId: "resume",
        previewId: fresh.preview!.previewId,
        consent: true,
      },
      context,
    );
    expect(resumed).toMatchObject({
      status: "active",
      revision: 2,
    });
    const stopped = await f.policies.execute(
      "bop_one",
      {
        attemptId: String("stop").padEnd(22, "_"),
        type: "StopBuyerOfferPolicy",
        expectedVersion: resumed.version,
        operationId: "stop",
      },
      context,
    );
    expect(stopped).toMatchObject({ status: "stopped" });
    for (const owner of [await f.policies.get("bop_one", "acc_buyer"), paused, fresh, resumed, stopped]) {
      expect(owner).not.toHaveProperty("consumedItemAmount");
      expect(owner).not.toHaveProperty("remainingItemAllowance");
      expect(owner.authority).not.toHaveProperty("itemCommitmentAllowance");
    }
    expect(
      await f.offers.acceptOffer(accepted, {
        ...context,
        audit: { ...context.audit, forAccountId: accepted.sellerAccountId },
      }),
    ).toEqual(outcome);
  });
  it("authorizes the complete 100-Offer bound, including the last selection", async () => {
    const { runtime, store } = await fixture();
    const selected = Array.from({ length: 100 }, (_, index) => ({
      ...terms.offers[0]!,
      offerId: index === 0 ? "off_one" : `off_${index}`,
    }));
    for (const selection of selected.slice(1)) await seedOffer(store, selection.offerId);
    const p = await preview(runtime, { ...terms, offers: selected });
    const result = await runtime.execute(
      "bop_one",
      {
        attemptId: String("authorize").padEnd(22, "_"),
        type: "AuthorizeBuyerOfferPolicy",
        expectedVersion: p.version,
        previewId: p.preview!.previewId,
        consent: true,
        operationId: "authorize",
      },
      context,
    );
    expect(result.authority!.offers).toHaveLength(100);
    expect((await store.readStream({ streamId: "marketplace.offer-off_99" })).at(-1)?.eventType).toBe(
      "marketplace.offer.buyer-policy-bound",
    );
  });
  it("production capability is absent and preview cannot bind an Offer", async () => {
    const { runtime, store } = await fixture(false);
    await expect(activate(runtime)).rejects.toMatchObject({ code: "enforcement_unavailable" });
    expect((await runtime.get("bop_one", "acc_buyer")).status).toBe("draft");
    expect(await store.readStream({ streamId: "marketplace.offer-off_one" })).toHaveLength(1);
  });
  it.each([
    ["empty", { ...terms, offers: [] }],
    ["duplicates", { ...terms, offers: [...terms.offers, ...terms.offers] }],
    ["over bound", { ...terms, offers: Array.from({ length: 101 }, () => terms.offers[0]) }],
    ["missing", { ...terms, offers: [{ ...terms.offers[0], offerId: "off_missing" }] }],
    ["foreign", { ...terms, offers: [{ ...terms.offers[0], offerId: "off_foreign" }] }],
    ["stale", { ...terms, offers: [{ ...terms.offers[0], offerVersion: 2 }] }],
    ["currency", { ...terms, currency: "EUR" }],
    ["quantity", { ...terms, offers: [{ ...terms.offers[0], quantity: 3 }] }],
    ["product", { ...terms, offers: [{ ...terms.offers[0], productId: "other" }] }],
    [
      "options",
      {
        ...terms,
        offers: [{ ...terms.offers[0], selectedOptions: [{ dimensionId: "dim_one", optionId: "opt_one" }] }],
      },
    ],
    ["cap", { ...terms, offers: [{ ...terms.offers[0], maximumUnitItemAmount: "9.99" }] }],
    ["positive adjustment", { ...terms, adjustmentBps: 1 }],
    ["excess discount", { ...terms, adjustmentBps: -2501 }],
    ["fractional adjustment", { ...terms, adjustmentBps: -1.5 }],
    ["retired field", { ...terms, itemCommitmentAllowance: "100.00" }],
  ])("rejects %s with no events, even with a stale projection", async (_name, invalid) => {
    const { runtime, store, db } = await fixture();
    await seedOffer(store, "off_foreign", "acc_other");
    const before = await store.readAll();
    await expect(preview(runtime, invalid as typeof terms)).rejects.toThrow();
    expect(await store.readAll()).toEqual(before);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("rejects accepted Offers and never mutates their accepted facts", async () => {
    const { runtime, store } = await fixture();
    await store.appendToStream({
      streamId: "marketplace.offer-off_one",
      expectedVersion: 1,
      context,
      events: [
        {
          eventType: "marketplace.offer.accepted",
          payload: {
            offerId: "off_one",
            buyerAccountId: "acc_buyer",
            sellerAccountId: "acc_seller",
            listingId: "lst_one",
            inventoryItemId: "inv_one",
            listingVersion: 1,
            catalogItemId: "cat_one",
            productId: "cat_one::",
            itemTitle: "Item",
            itemSubtitle: null,
            selectedOptions: [],
            productSummary: null,
            shippingDestinationSnapshot: {
              name: "Buyer",
              line1: "1 Main",
              city: "Chicago",
              state: "IL",
              postalCode: "60601",
              country: "US",
            },
            priceCurrencyCode: "USD",
            marketplaceSalesFeeUnitAmount: "0.00",
            sellerNetUnitAmount: "10.00",
            shippingAllowancePercentageBps: 500,
            listingEvidenceSnapshot: buildListingEvidenceSnapshot({
              evidence: [],
              createdAt: "2026-09-27T12:00:00.000Z",
            }),
            acceptedAt: "2026-09-27T12:00:00.000Z",
            priceAmount: "10.00",
            quantityRequested: 2,
          },
        },
      ],
    });
    const before = await store.readAll();
    await expect(preview(runtime, { ...terms, offers: [{ ...terms.offers[0]!, offerVersion: 2 }] })).rejects.toThrow(
      "submitted",
    );
    expect(await store.readAll()).toEqual(before);
  });
  it("binds all Offers and consent atomically, and duplicate/concurrent retries append once", async () => {
    const { runtime, store } = await fixture();
    await seedOffer(store, "off_two");
    const p = await preview(runtime, {
      ...terms,
      offers: [...terms.offers, { ...terms.offers[0]!, offerId: "off_two" }],
    });
    const command: BuyerOfferPolicyRequest = {
      attemptId: String("authorize").padEnd(22, "_"),
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      previewId: p.preview!.previewId,
      consent: true,
      operationId: "authorize",
    };
    const results = await Promise.all([
      runtime.execute("bop_one", command, context),
      runtime.execute("bop_one", command, context),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await runtime.execute("bop_one", command, context)).toEqual(results[0]);
    for (const id of ["off_one", "off_two"])
      expect(await store.readStream({ streamId: `marketplace.offer-${id}` })).toHaveLength(2);
    expect(await store.readStream({ streamId: "marketplace.offer-policy-bop_one" })).toHaveLength(3);
    await expect(runtime.execute("bop_one", { ...command, previewId: "f".repeat(64) }, context)).rejects.toMatchObject({
      code: "attempt_conflict",
    });
  });
  it("a failure at atomic append exposes no partial consent or membership and the same operation retries", async () => {
    let fail = false;
    const { runtime, store } = await fixture(true, (underlying) => ({
      ...underlying,
      appendToStreams: async (inputs) => {
        if (fail) throw new Error("injected before atomic commit");
        return underlying.appendToStreams!(inputs);
      },
    }));
    const p = await preview(runtime);
    const command: BuyerOfferPolicyRequest = {
      attemptId: String("authorize").padEnd(22, "_"),
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      previewId: p.preview!.previewId,
      consent: true,
      operationId: "authorize",
    };
    const before = await store.readAll();
    fail = true;
    await expect(runtime.execute("bop_one", command, context)).rejects.toThrow("injected");
    expect(await store.readAll()).toEqual(before);
    fail = false;
    expect((await runtime.execute("bop_one", command, context)).status).toBe("active");
  });
  it("Offer mutation between validation and atomic append rejects every membership and consent write", async () => {
    let race = false;
    const { runtime, store } = await fixture(true, (underlying) => ({
      ...underlying,
      appendToStreams: async (inputs) => {
        if (race) {
          race = false;
          await underlying.appendToStream({
            streamId: "marketplace.offer-off_one",
            expectedVersion: 1,
            context,
            events: [
              {
                eventType: "marketplace.offer.price-updated",
                payload: {
                  offerId: "off_one",
                  buyerAccountId: "acc_buyer",
                  priceAmount: "11.00",
                  priceCurrencyCode: "USD",
                },
              },
            ],
          });
        }
        return underlying.appendToStreams!(inputs);
      },
    }));
    const p = await preview(runtime);
    race = true;
    await expect(
      runtime.execute(
        "bop_one",
        {
          attemptId: String("authorize").padEnd(22, "_"),
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: p.version,
          previewId: p.preview!.previewId,
          consent: true,
          operationId: "authorize",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect((await runtime.get("bop_one", "acc_buyer")).status).toBe("draft");
    expect((await store.readStream({ streamId: "marketplace.offer-off_one" })).map((e) => e.eventType)).not.toContain(
      "marketplace.offer.buyer-policy-bound",
    );
  });
  it("concurrent preview revision invalidates old consent", async () => {
    const { runtime, store } = await fixture();
    const p = await preview(runtime);
    await preview(runtime, { ...terms, adjustmentBps: -100 }, p.version, "revision");
    const before = await store.readAll();
    await expect(
      runtime.execute(
        "bop_one",
        {
          attemptId: String("authorize").padEnd(22, "_"),
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: p.version,
          previewId: p.preview!.previewId,
          consent: true,
          operationId: "authorize",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "stale_preview" });
    await expect(
      runtime.execute(
        "bop_one",
        {
          attemptId: String("authorize").padEnd(22, "_"),
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: 3,
          previewId: p.preview!.previewId,
          consent: true,
          operationId: "authorize",
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "stale_preview" });
    expect(await store.readAll()).toEqual(before);
  });
  it.each(["active", "paused", "stopped"] as const)(
    "two policies cannot bind the same Offer while its owner is %s",
    async (status) => {
      const { runtime, store } = await fixture();
      const first = await preview(runtime);
      await runtime.execute(
        "bop_two",
        {
          attemptId: String("create").padEnd(22, "_"),
          type: "CreateBuyerOfferPolicy",
          expectedVersion: 0,
          operationId: "create",
        },
        context,
      );
      const second = await runtime.execute(
        "bop_two",
        {
          attemptId: String("preview").padEnd(22, "_"),
          type: "PreviewBuyerOfferPolicy",
          expectedVersion: 1,
          operationId: "preview",
          terms,
        },
        context,
      );
      const results = await Promise.allSettled(
        [first, second].map((p) =>
          runtime.execute(
            p.policyId!,
            {
              attemptId: String("authorize").padEnd(22, "_"),
              type: "AuthorizeBuyerOfferPolicy",
              expectedVersion: p.version,
              previewId: p.preview!.previewId,
              consent: true,
              operationId: "authorize",
            },
            context,
          ),
        ),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = results[0]!.status === "fulfilled" ? "bop_one" : "bop_two";
      const loser = winner === "bop_one" ? "bop_two" : "bop_one";
      if (status !== "active") {
        await runtime.execute(
          winner,
          {
            attemptId: String(status).padEnd(22, "_"),
            type: status === "paused" ? "PauseBuyerOfferPolicy" : "StopBuyerOfferPolicy",
            expectedVersion: 3,
            operationId: status,
          },
          context,
        );
      }
      const before = await store.readAll();
      await expect(
        runtime.execute(
          loser,
          {
            attemptId: String("new_preview").padEnd(22, "_"),
            type: "PreviewBuyerOfferPolicy",
            expectedVersion: 2,
            operationId: "new_preview",
            terms: { ...terms, offers: [{ ...terms.offers[0]!, offerVersion: 2 }] },
          },
          context,
        ),
      ).rejects.toThrow("permanently");
      expect(await store.readAll()).toEqual(before);
      expect(await store.readStream({ streamId: "marketplace.offer-off_one" })).toHaveLength(2);
    },
  );
  it("pause/resume requires fresh preview, revisions require consent, and retries do not resurrect stopped policy", async () => {
    const { runtime } = await fixture();
    await activate(runtime);
    const pause = {
      attemptId: String("pause").padEnd(22, "_"),
      type: "PauseBuyerOfferPolicy",
      expectedVersion: 3,
      operationId: "pause",
    } as const;
    expect((await runtime.execute("bop_one", pause, context)).status).toBe("paused");
    expect((await runtime.execute("bop_one", pause, context)).version).toBe(4);
    const p = await preview(
      runtime,
      { ...terms, adjustmentBps: -100, offers: [{ ...terms.offers[0]!, offerVersion: 2 }] },
      4,
      "resume_preview",
    );
    expect(p.authority!.adjustmentBps).toBe(0);
    const resume = {
      attemptId: String("resume").padEnd(22, "_"),
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      previewId: p.preview!.previewId,
      consent: true,
      operationId: "resume",
    } as const;
    expect((await runtime.execute("bop_one", resume, context)).revision).toBe(2);
    await runtime.execute(
      "bop_one",
      {
        attemptId: String("stop").padEnd(22, "_"),
        type: "StopBuyerOfferPolicy",
        expectedVersion: 6,
        operationId: "stop",
      },
      context,
    );
    expect((await runtime.execute("bop_one", resume, context)).status).toBe("active");
    expect((await runtime.get("bop_one", "acc_buyer")).status).toBe("stopped");
  });
  it("account list is bounded keyset and owner-scoped without per-row totals", async () => {
    const { runtime, db } = await fixture();
    await runtime.list("acc_buyer", "bop_before", 10);
    expect(db.query).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("buyer_account_id = $1 AND policy_id > $2"),
      ["acc_buyer", "bop_before", 10, []],
    );
    await expect(runtime.list("acc_buyer", "", 101)).rejects.toThrow();
  });
});
