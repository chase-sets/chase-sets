import { describe, expect, it } from "vitest";
import type { BuyerOfferPolicyRequest } from "../domain/contracts";
import { activate, context, fixture, preview, seedOffer, terms } from "../tests/fixtures";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { managedFixture } from "../../offers/tests/managed-fixture";
import { createBuyerOfferPolicyRuntime } from "./runtime";
import { vi } from "vitest";
import type { ManagedOfferTarget } from "../../offers/api/managed-authority";

describe("Buyer Offer Policy authoritative runtime", () => {
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
  it("preserves lifetime consumption across pause, fresh consent, resume and terminal stop", async () => {
    const f = await managedFixture(createInMemoryEventStore().eventStore);
    const accepted = await f.acceptance();
    const outcome = await f.offers.acceptOffer(accepted, context);
    const paused = await f.policies.execute(
      "bop_one",
      { type: "PauseBuyerOfferPolicy", expectedVersion: 4, operationId: "pause" },
      context,
    );
    const fresh = await f.policies.execute(
      "bop_one",
      {
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: paused.version,
        operationId: "resume_preview",
        terms: {
          ...terms,
          itemCommitmentAllowance: "40.00",
          offers: [{ ...terms.offers[0]!, offerId: "off_two", offerVersion: 2 }],
        },
      },
      context,
    );
    const resumed = await f.policies.execute(
      "bop_one",
      {
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
      consumedItemAmount: "20.00",
      remainingItemAllowance: "20.00",
      revision: 2,
    });
    const stopped = await f.policies.execute(
      "bop_one",
      { type: "StopBuyerOfferPolicy", expectedVersion: resumed.version, operationId: "stop" },
      context,
    );
    expect(stopped).toMatchObject({ status: "stopped", consumedItemAmount: "20.00" });
    expect(await f.offers.acceptOffer(accepted, context)).toEqual(outcome);
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
    ["allowance overflow", { ...terms, itemCommitmentAllowance: "10000000000.00" }],
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
      code: "operation_conflict",
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
    await preview(runtime, { ...terms, itemCommitmentAllowance: "200.00" }, p.version, "revision");
    const before = await store.readAll();
    await expect(
      runtime.execute(
        "bop_one",
        {
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
        { type: "CreateBuyerOfferPolicy", expectedVersion: 0, operationId: "create" },
        context,
      );
      const second = await runtime.execute(
        "bop_two",
        { type: "PreviewBuyerOfferPolicy", expectedVersion: 1, operationId: "preview", terms },
        context,
      );
      const results = await Promise.allSettled(
        [first, second].map((p) =>
          runtime.execute(
            p.policyId!,
            {
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
    const pause = { type: "PauseBuyerOfferPolicy", expectedVersion: 3, operationId: "pause" } as const;
    expect((await runtime.execute("bop_one", pause, context)).status).toBe("paused");
    expect((await runtime.execute("bop_one", pause, context)).version).toBe(4);
    const p = await preview(
      runtime,
      { ...terms, itemCommitmentAllowance: "200.00", offers: [{ ...terms.offers[0]!, offerVersion: 2 }] },
      4,
      "resume_preview",
    );
    expect(p.authority!.itemCommitmentAllowance).toBe("100.00");
    const resume = {
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      previewId: p.preview!.previewId,
      consent: true,
      operationId: "resume",
    } as const;
    expect((await runtime.execute("bop_one", resume, context)).revision).toBe(2);
    await runtime.execute(
      "bop_one",
      { type: "StopBuyerOfferPolicy", expectedVersion: 6, operationId: "stop" },
      context,
    );
    expect((await runtime.execute("bop_one", resume, context)).status).toBe("stopped");
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
