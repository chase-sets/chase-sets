import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../domain/domain";
import { createListingTargetRuntime } from "./target-runtime";
import type { AcceptListingTargetPriceInput, ListingTargetAuthority } from "./target-contracts";
import { createSyntheticListingAuthority } from "./authority-test-support";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
};
async function fixture(overrides: Partial<ListingTargetAuthority> = {}) {
  const { eventStore } = createInMemoryEventStore();
  const { repository, commandHandler } = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });
  await commandHandler({
    streamId: "marketplace.listing-lst_test",
    context,
    command: {
      type: "CreateListing",
      publicationScope: "channel-only",
      listingId: "lst_test" as never,
      accountId: "acc_seller" as never,
      inventoryItemId: "inv_test",
      catalogItemId: "cat_test" as never,
      productId: "cat_test::" as never,
      itemTitle: null,
      itemSubtitle: null,
      selectedOptions: [],
      productSummary: null,
      storageLocationName: null,
      shipFromCode: null,
      shipFromAddress: {
        name: "Seller",
        company: null,
        line1: "1 Test St",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
        phone: null,
        email: null,
      },
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      feeLock: null,
      quantityCap: 2,
      evidenceRequirements: null,
    },
  });
  const participantFixture = createSyntheticListingAuthority(eventStore);
  const authority: ListingTargetAuthority = { ...participantFixture.authority, ...overrides };
  const services = createListingTargetRuntime({
    eventStore,
    authority,
    load: (id) => repository.load(`marketplace.listing-${id}`),
    prepareNativeEnable: async () => {
      throw new Error("Synthetic fixture has no native readiness.");
    },
    capacityAppends: async () => ({ appends: [], reservations: [] }),
  });
  const input: AcceptListingTargetPriceInput = {
    accountId: "acc_seller",
    listingId: "lst_test",
    expectedListingVersion: 1,
    expectedTargetPriceRevision: 0,
    idempotencyKey: "price-1",
    target: { kind: "channel-connection", connectionId: "con_one" },
    priceAmount: "12.00",
    priceCurrencyCode: "CAD",
    decision: {
      kind: "pricing-evaluation",
      evaluationId: "synthetic-evaluation",
      evaluationRevision: "1",
      policyId: "synthetic-policy",
      policyRevision: "1",
      goal: null,
      inputEvidenceRefs: ["synthetic-input"],
      curveEvidenceRefs: [],
      economicsSourceRevision: null,
      economicsOverrideRevision: null,
      basePriceRevision: 1,
      standingAuthorizationId: "synthetic-authorization",
      standingAuthorizationRevision: "1",
    },
  };
  return { services, eventStore, repository, commandHandler, authority, input, participantFixture };
}

describe("Listing target owner authority", () => {
  it("accepts unchanged authority from its distinct owning event store", async () => {
    const { services, input, eventStore, participantFixture } = await fixture();
    const identityStore = participantFixture.stores.get("identity")!;
    const streamId = "identity.synthetic-manage-listing";
    await participantFixture.change("manage-listing", context);

    await expect(services.acceptListingTargetPrice(input, context)).resolves.toMatchObject({
      listingId: input.listingId,
      version: 2,
    });
    expect(await identityStore.readStream({ streamId })).toHaveLength(1);
    expect(await eventStore.readStream({ streamId })).toHaveLength(0);
  });

  it("rejects a changed source authority even when a local mirror still matches its prior revision", async () => {
    const { services, input, eventStore, participantFixture } = await fixture();
    const streamId = "identity.synthetic-manage-listing";
    const grant = {
      streamId,
      expectedVersion: 0,
      context,
      events: [{ eventType: "identity.synthetic-authority-changed", payload: { enabled: true } }],
    };
    await participantFixture.change("manage-listing", context);
    // A caught-up local mirror is not a lock on the separately owned source.
    await eventStore.appendToStream(grant);
    const append = eventStore.appendToStreams!;
    vi.spyOn(eventStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await participantFixture.change("manage-listing", context, false);
      const source = participantFixture.sources.find((candidate) => candidate.participant.owner === "identity")!;
      const operation = (await participantFixture.stores.get("identity")!.readAll()).find((event) =>
        event.eventType.endsWith(".reserved"),
      )!.payload
        .reservation as unknown as import("@chase-sets/event-core/listing-authority").ListingAuthorityReservation;
      expect((await source.inspect(operation.operation))?.status).toBe("reserved");
      const fence = (await import("@chase-sets/platform-runtime/listing-authority-fence")).createListingAuthorityFence({
        eventStore,
        owner: "marketplace",
        participants: [],
      });
      expect((await fence.inspect(operation.operation)).status).toBe("aborted");
      return append(appends);
    });

    await expect(services.acceptListingTargetPrice(input, context)).rejects.toThrow();
    expect(await eventStore.readStream({ streamId: `marketplace.listing-${input.listingId}` })).toHaveLength(1);
    expect(
      (await eventStore.readAll()).filter((event) => event.eventType === "marketplace.listing-request.completed"),
    ).toHaveLength(0);
  });

  it("recovers a whole native batch from an unknown post-commit outcome without resending", async () => {
    const { services, input, eventStore } = await fixture();
    const append = eventStore.appendToStreams!;
    const spy = vi.spyOn(eventStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await append(appends);
      throw new Error("Synthetic connection loss after commit");
    });
    const updates = [
      { listingId: input.listingId, priceAmount: "12.00", priceCurrencyCode: "USD", idempotencyKey: "unknown-result" },
    ];
    const first = await services.applyNativePrices({ accountId: input.accountId, updates }, context);
    expect(first).toEqual([{ listingId: input.listingId, version: 2, outcome: "applied" }]);
    expect(await services.applyNativePrices({ accountId: input.accountId, updates }, context)).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(2);
  });

  it("rolls back native no-op request results if capability changes before commit", async () => {
    const { services, input, eventStore, participantFixture } = await fixture();
    const append = eventStore.appendToStreams!;
    vi.spyOn(eventStore, "appendToStreams").mockImplementationOnce(async (appends) => {
      await participantFixture.change("manage-listing", context);
      return append(appends);
    });
    const updates = [
      { listingId: input.listingId, priceAmount: "10.00", priceCurrencyCode: "USD", idempotencyKey: "guarded-noop" },
    ];
    expect(await services.applyNativePrices({ accountId: input.accountId, updates }, context)).toMatchObject([
      { outcome: "conflict" },
    ]);
    expect(
      (await eventStore.readAll()).filter((event) => event.eventType === "marketplace.listing-request.completed"),
    ).toHaveLength(0);
    expect(await services.applyNativePrices({ accountId: input.accountId, updates }, context)).toMatchObject([
      { outcome: "error" },
    ]);
    expect(
      await services.applyNativePrices(
        { accountId: input.accountId, updates: updates.map((update) => ({ ...update, idempotencyKey: "new-noop" })) },
        context,
      ),
    ).toEqual([{ listingId: input.listingId, version: 1, outcome: "no_op" }]);
  });

  it("routes native reference edits through canonical acceptance without native fee prerequisites", async () => {
    const { services, input, eventStore, repository } = await fixture();
    await services.updateNativePrice(
      {
        accountId: input.accountId,
        listingId: input.listingId,
        priceAmount: "14.00",
        priceCurrencyCode: "EUR",
        idempotencyKey: "native-edit",
        feeQuoteFingerprint: "not-a-native-enrollment",
      },
      context,
    );
    const events = await eventStore.readStream({ streamId: "marketplace.listing-lst_test" });
    expect(events[1]).toMatchObject({
      eventType: "marketplace.listing.price-updated",
      payload: {
        schemaVersion: 2,
        acceptedTargetPrice: {
          target: { kind: "native-marketplace" },
          priceAmount: "14.00",
          priceCurrencyCode: "EUR",
          decision: { kind: "seller-reference" },
          sourceEventId: events[1]!.eventId,
        },
      },
    });
    expect((await repository.load("marketplace.listing-lst_test")).state).toMatchObject({
      nativeVisibility: "disabled",
      feeLocks: [],
    });
  });

  it("durably replays native no-ops after later edits and rejects changed currency on the same key", async () => {
    const { services, input, eventStore } = await fixture();
    const update = {
      listingId: input.listingId,
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      idempotencyKey: "native-noop",
    };
    const original = await services.applyNativePrices({ accountId: input.accountId, updates: [update] }, context);
    expect(original).toEqual([{ listingId: input.listingId, version: 1, outcome: "no_op" }]);
    await services.updateNativePrice(
      { ...update, accountId: input.accountId, priceAmount: "15.00", idempotencyKey: "later" },
      context,
    );
    expect(await services.applyNativePrices({ accountId: input.accountId, updates: [update] }, context)).toEqual(
      original,
    );
    expect(
      await services.applyNativePrices(
        { accountId: input.accountId, updates: [{ ...update, priceCurrencyCode: "CAD" }] },
        context,
      ),
    ).toMatchObject([{ outcome: "error", message: "Listing request key was already used for a different command." }]);
    expect(await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).toHaveLength(2);
  });

  it("never treats an idempotency-key prefix as Pricing provenance", async () => {
    const { services, input, eventStore } = await fixture();
    await services.updateNativePrice(
      {
        accountId: input.accountId,
        listingId: input.listingId,
        priceAmount: "11.00",
        priceCurrencyCode: "USD",
        idempotencyKey: "repricing:forged",
      },
      context,
    );
    const event = (await eventStore.readStream({ streamId: "marketplace.listing-lst_test" }))[1]!;
    expect(event.payload).not.toHaveProperty("changeSource");
    await expect(
      services.updateNativePrice(
        {
          accountId: input.accountId,
          listingId: input.listingId,
          priceAmount: "12.00",
          priceCurrencyCode: "USD",
          changeSource: "repricing-engine",
        },
        context,
      ),
    ).rejects.toThrow("verified decision authority");
  });

  it("retains a verified new decision at the same numeric native price instead of suppressing it", async () => {
    const { services, input, eventStore } = await fixture();
    expect(
      await services.applyNativePrices(
        {
          accountId: input.accountId,
          updates: [
            {
              listingId: input.listingId,
              priceAmount: "10.00",
              priceCurrencyCode: "USD",
              decision: input.decision,
              changeSource: "repricing-engine",
              idempotencyKey: "decision-native",
              minimumChange: { mode: "absolute", amount: "100.00" },
            },
          ],
        },
        context,
      ),
    ).toMatchObject([{ outcome: "applied", version: 2 }]);
    expect((await eventStore.readStream({ streamId: "marketplace.listing-lst_test" }))[1]?.payload).toMatchObject({
      changeSource: "repricing-engine",
      acceptedTargetPrice: { decision: input.decision },
    });
  });

  it("keeps target-keyed bulk results, durable duplicate replay, and changed-command conflicts", async () => {
    const { services, input, eventStore } = await fixture();
    const append = vi.spyOn(eventStore, "appendToStreams");
    const outcomes = await services.acceptListingTargetPrices(
      { accountId: input.accountId, updates: [input, input, { ...input, priceCurrencyCode: "EUR" }] },
      context,
    );
    expect(outcomes[0]?.result?.acceptedTargetPrice.priceCurrencyCode).toBe("CAD");
    expect(outcomes[1]?.result).toEqual(outcomes[0]?.result);
    expect(outcomes[2]?.error).toContain("different command");
    expect(append).toHaveBeenCalledTimes(3);
    expect(await eventStore.readAll()).toHaveLength(5);
    expect(
      (await eventStore.readAll()).filter(
        (event) => event.eventType === "marketplace.listing-authority-operation.committed",
      ),
    ).toHaveLength(1);
  });

  it("retains independent exact target pairs without changing the hidden native reference or fees", async () => {
    const { services, input, repository } = await fixture();
    await services.acceptListingTargetPrice(input, context);
    await services.acceptListingTargetPrice(
      {
        ...input,
        idempotencyKey: "price-2",
        expectedListingVersion: 2,
        target: { kind: "channel-connection", connectionId: "con_two" },
        priceAmount: "15.00",
        priceCurrencyCode: "EUR",
      },
      context,
    );
    const reads = await services.readAcceptedListingTargetPrices({
      accountId: input.accountId,
      targets: [
        { listingId: input.listingId, target: input.target },
        { listingId: input.listingId, target: { kind: "channel-connection", connectionId: "con_two" } },
      ],
    });
    expect(
      reads.map((read) => [read.acceptedTargetPrice?.priceAmount, read.acceptedTargetPrice?.priceCurrencyCode]),
    ).toEqual([
      ["12.00", "CAD"],
      ["15.00", "EUR"],
    ]);
    expect((await repository.load("marketplace.listing-lst_test")).state).toMatchObject({
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      nativeVisibility: "disabled",
      feeLocks: [],
    });
  });

  it("returns one durable acceptance for concurrent identical requests and rejects changed currency", async () => {
    const { services, input, eventStore } = await fixture();
    const [one, two] = await Promise.all([
      services.acceptListingTargetPrice(input, context),
      services.acceptListingTargetPrice(input, context),
    ]);
    expect(one).toEqual(two);
    await expect(services.acceptListingTargetPrice({ ...input, priceCurrencyCode: "EUR" }, context)).rejects.toThrow(
      "different command",
    );
    expect((await eventStore.readStream({ streamId: "marketplace.listing-lst_test" })).length).toBe(2);
  });

  it("fences concurrent different acceptances at the Listing version", async () => {
    const { services, input } = await fixture();
    const results = await Promise.allSettled([
      services.acceptListingTargetPrice(input, context),
      services.acceptListingTargetPrice({ ...input, idempotencyKey: "other", priceAmount: "13.00" }, context),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it.each(["capability", "connection", "decision"])("fails closed for missing %s authority", async (kind) => {
    const missing = async () => ({ value: null, reservations: [] });
    const { services, input, eventStore } = await fixture(
      kind === "capability"
        ? { authorizeManage: async () => ({ value: false, reservations: [] }) }
        : kind === "connection"
          ? { resolveConnection: missing }
          : { verifyDecision: async () => ({ value: false, reservations: [] }) },
    );
    await expect(services.acceptListingTargetPrice(input, context)).rejects.toThrow();
    const history = await eventStore.readAll();
    expect(history).toHaveLength(3);
    expect(history.at(-1)?.eventType).toBe("marketplace.listing-authority-operation.aborted");
    expect(await eventStore.readStream({ streamId: `marketplace.listing-${input.listingId}` })).toHaveLength(1);
  });

  it("rejects foreign accounts and fabricated external hard-price intent", async () => {
    const { services, input } = await fixture();
    await expect(services.acceptListingTargetPrice({ ...input, accountId: "acc_foreign" }, context)).rejects.toThrow(
      "account authority mismatch",
    );
    await expect(
      services.acceptListingTargetPrice({ ...input, decision: { kind: "seller-reference" } }, context),
    ).rejects.toThrow("verified Pricing decision");
  });

  it("activates only the accepted target and never records native publication", async () => {
    const { services, input, eventStore } = await fixture();
    await services.acceptListingTargetPrice(input, context);
    await services.activateListingForChannel(
      {
        accountId: input.accountId,
        listingId: input.listingId,
        expectedListingVersion: 2,
        expectedTargetPriceRevision: 2,
        idempotencyKey: "activate",
        connectionId: "con_one",
        allocationRevision: 1,
      },
      context,
    );
    expect(
      (await services.readNativeListingEligibility({ accountId: input.accountId, listingIds: [input.listingId] }))[0],
    ).toMatchObject({ eligible: false, blockingReason: "native-disabled", nativePublicationRevision: null });
    expect((await eventStore.readAll()).some((event) => event.eventType === "marketplace.listing.published")).toBe(
      false,
    );
  });

  it("rejects missing Inventory allocation and leaves the listing draft", async () => {
    const { services, input, repository } = await fixture({
      resolveAllocation: async () => ({ value: null, reservations: [] }),
    });
    await services.acceptListingTargetPrice(input, context);
    await expect(
      services.activateListingForChannel(
        {
          accountId: input.accountId,
          listingId: input.listingId,
          expectedListingVersion: 2,
          expectedTargetPriceRevision: 2,
          idempotencyKey: "activate",
          connectionId: "con_one",
          allocationRevision: 1,
        },
        context,
      ),
    ).rejects.toThrow("Inventory allocation");
    expect((await repository.load("marketplace.listing-lst_test")).state.status).toBe("draft");
  });
});
