import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createMarketplaceAttempt,
  hashMarketplaceRequest,
  marketplaceAttemptBinding,
  marketplaceAttemptStream,
  type MarketplaceAttemptInput,
} from "./attempt";
import { createMarketplaceMutationLookup } from "./lookup";
import { marketplaceOfferCanonicalRequest } from "../domain/contracts";
import { offerAttemptResultSchema } from "../../offers/api/attempt-result";
import { context } from "../../offer-policy/tests/fixtures";

const submit: MarketplaceAttemptInput = {
  attemptId: "attempt_core_identity_0001",
  accountId: "acc_buyer",
  mutationKind: "offer.submit",
  target: { kind: "product", id: "cat_one::" },
  request: { productId: "cat_one::", priceAmount: "10.00", priceCurrencyCode: "USD", quantityRequested: 1 },
};
const checkoutKey = "sell-confirm:slc_chk_sell_1:sll_1:selected:off_one";
const accept = (attemptId: string): MarketplaceAttemptInput => ({
  attemptId,
  accountId: "acc_seller",
  mutationKind: "offer.accept",
  target: { kind: "offer", id: "off_one" },
  request: { offerId: "off_one", listingId: "lst_one" },
});
const as = (accountId: string): EventStoreContext => ({
  ...context,
  audit: { ...context.audit, forAccountId: accountId as never },
});

function observedStore() {
  const store = createInMemoryEventStore().eventStore;
  return { store, read: vi.spyOn(store, "readStream"), append: vi.spyOn(store, "appendToStreams") };
}

describe("Marketplace attempt core", () => {
  it.each([
    ["a short id", { ...submit, attemptId: "too_short" }],
    ["a Checkout key outside acceptance", { ...submit, attemptId: checkoutKey }],
    ["an unrecognised acceptance key", accept("handoff:2f1c9b7e-0000-4000-8000-000000000000")],
    ["a Checkout segment with whitespace", accept("sell-confirm:slc_1:sll 1:selected:off_one")],
    ["a Checkout segment over 128 characters", accept(`sell-confirm:${"a".repeat(129)}:sll_1:match:off_one`)],
  ])("refuses %s before any read or append", async (_name, input) => {
    const { store, read, append } = observedStore();
    expect(() => createMarketplaceAttempt(store, input, offerAttemptResultSchema)).toThrow(
      expect.objectContaining({ code: "invalid_attempt" }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it.each([checkoutKey, checkoutKey.replace(":selected:", ":match:"), "c0ffee00-1111-4222-8333-444455556666"])(
    "binds the unchanged acceptance key %s",
    (key) => {
      expect(marketplaceAttemptBinding(accept(key)).ownerStatus).toBe("not-observed");
    },
  );

  it("conflicts a supplied request hash that differs from the command before any read or append", async () => {
    const { store, read, append } = observedStore();
    const canonical = hashMarketplaceRequest(
      marketplaceOfferCanonicalRequest("offer.submit", submit.request as Record<string, unknown>),
    );
    expect(
      createMarketplaceAttempt(store, { ...submit, requestHash: canonical }, offerAttemptResultSchema).binding,
    ).toMatchObject({ canonicalRequestHash: canonical });
    for (const requestHash of ["f".repeat(64), "not-a-hash"])
      expect(() => createMarketplaceAttempt(store, { ...submit, requestHash }, offerAttemptResultSchema)).toThrow(
        expect.objectContaining({ code: "attempt_conflict" }),
      );
    expect(read).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses a completed attempt whose audit account differs from its actor binding", async () => {
    const store = createInMemoryEventStore().eventStore;
    const attempt = createMarketplaceAttempt(store, submit, offerAttemptResultSchema);
    const result = { offerId: "off_one" as never, version: 1 };
    await store.appendToStreams!([attempt.append(result, { id: "off_one", version: 1 }, as("acc_other"))]);
    await expect(attempt.read()).rejects.toMatchObject({ code: "history_incomplete" });

    const owned = createInMemoryEventStore().eventStore;
    const control = createMarketplaceAttempt(owned, submit, offerAttemptResultSchema);
    await owned.appendToStreams!([control.append(result, { id: "off_one", version: 1 }, as("acc_buyer"))]);
    await expect(control.read()).resolves.toMatchObject(result);
  });

  it("gives a wrong owner of an incomplete shared acceptance stream the same not-observed as a missing attempt", async () => {
    const store = createInMemoryEventStore().eventStore;
    const binding = marketplaceAttemptBinding(accept(checkoutKey));
    await store.appendToStreams!([
      {
        streamId: marketplaceAttemptStream(binding),
        expectedVersion: "no_stream",
        context: as("acc_seller"),
        events: [{ eventType: "marketplace.unexpected", payload: {} }],
      },
    ]);
    const query = (accountId: string) => ({
      attemptId: checkoutKey,
      accountId,
      mutationKind: "offer.accept" as const,
      target: { kind: "offer" as const, id: "off_one" },
      requestHash: binding.canonicalRequestHash,
    });
    const owner = await createMarketplaceMutationLookup(store)(query("acc_seller"));
    expect(owner).toMatchObject({ ownerStatus: "ambiguous", reason: "history-incomplete" });
    const wrong = await createMarketplaceMutationLookup(store)(query("acc_intruder"));
    const missing = await createMarketplaceMutationLookup(createInMemoryEventStore().eventStore)(query("acc_intruder"));
    expect(wrong).toEqual(missing);
    expect(wrong.ownerStatus).toBe("not-observed");
  });
});
