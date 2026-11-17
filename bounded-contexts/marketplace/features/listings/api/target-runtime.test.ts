import { describe, expect, it, vi } from "vitest";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore, createInMemoryConfigurationConsumer } from "@chase-sets/event-core/test-support";
import {
  createInMemoryOwnerStreamReservationStore,
  type RequestTerminalBinding,
  type ReserveOwnerStreamInput,
} from "@chase-sets/event-core/owner-stream-reservation";
import type { ConfigurationEpochGrant } from "@chase-sets/event-core/configuration-epoch";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  decideMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../domain/domain";
import { createListingTargetRuntime } from "./target-runtime";
import { createMarketplaceListingRuntime } from "./runtime";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { AcceptListingTargetPriceInput, ListingTargetAuthority } from "./target-contracts";

async function fixture() {
  const listingId = createId("lst"),
    accountId = createId("acc"),
    userId = createId("usr"),
    catalogItemId = createId("cat");
  const context = { tenantId: createId("tnt"), audit: { performedByUserId: userId, forAccountId: accountId } };
  const principal = { userId, membershipId: "membership", sessionId: "session", tokenHash: "test-token-hash" };
  const consumer = createInMemoryConfigurationConsumer({ storeId: "marketplace", incarnation: "consumer-v1" });
  const reservations = createInMemoryOwnerStreamReservationStore({
    consumer: consumer.identity,
    readOwnerSeal: () => ({ version: 1, storeIncarnation: "inventory-v1" }),
    applyInvalidation: () => undefined,
    applyInboundEvidence: () => undefined,
  });
  const { eventStore: store } = createInMemoryEventStore({
    configurationEpoch: consumer,
    ownerStreamReservations: reservations,
  });
  const codec = createPassthroughDomainEventCodec<MarketplaceListingEvent>();
  const created = decideMarketplaceListing(initialMarketplaceListingState, {
    type: "CreateListing",
    publicationScope: "channel-only",
    listingId,
    accountId,
    inventoryItemId: "item",
    catalogItemId,
    productId: `${catalogItemId}::`,
    selectedOptions: [],
    itemTitle: "Card",
    itemSubtitle: null,
    productSummary: null,
    storageLocationName: null,
    shipFromCode: null,
    shipFromAddress: {
      name: "Seller",
      company: null,
      line1: "1 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    priceAmount: "10.00",
    priceCurrencyCode: "USD",
    feeLock: null,
    quantityCap: 1,
    evidenceRequirements: null,
  });
  await store.appendToStream({
    streamId: `marketplace.listing-${listingId}`,
    expectedVersion: "no_stream",
    context,
    events: created.map(codec.encode),
  });
  const keys = [
    `session/${principal.sessionId}`,
    `account/${accountId}`,
    `user/${userId}`,
    `membership/${principal.membershipId}`,
    "connection/connection",
  ];
  const grant = (key: string): ConfigurationEpochGrant => ({
    key,
    sourceIncarnation: `source-${key.split("/")[0]}`,
    keyCreationEpoch: 0,
    epoch: 0,
    consumer: consumer.identity,
    topologyRevision: 1,
    ...(key.startsWith("session/") ? { validUntil: "2099-01-01T00:00:00.000Z" } : {}),
  });
  const authorityFor = (keys: readonly string[]) => ({
    grants: keys.map(grant),
    evidence: keys.flatMap((key) => [
      {
        owner: key.startsWith("session/") ? "auth" : key.startsWith("connection/") ? "channels" : "identity",
        key,
        storeIncarnation: grant(key).sourceIncarnation,
        sealVersion: 1,
        epoch: 0,
      },
      ...(key.startsWith("session/")
        ? [
            {
              owner: "auth",
              key: `session-token/${principal.sessionId}`,
              storeIncarnation: grant(key).sourceIncarnation,
              sealVersion: 1,
              epoch: 0,
            },
          ]
        : []),
    ]),
  });
  const connection = {
    connectionId: "connection",
    providerKey: "test",
    environment: "sandbox" as const,
    identityRevision: 1,
  };
  const authority: ListingTargetAuthority = {
    recoverRequest: vi.fn(async () => {}),
    authorizeManage: vi.fn(async () => authorityFor(keys.slice(0, 4))),
    resolveConnection: vi.fn(async () => ({ ...authorityFor(keys.slice(4)), connection })),
    prepareAllocation: vi.fn(async (request) => {
      const target = {
        listingId: request.listingId,
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        channelConnectionId: request.connectionId,
        catalogItemId: request.catalogItemId,
        productId: request.productId,
        selectedOptions: request.selectedOptions,
      };
      const manifest: ReserveOwnerStreamInput[] = ["allocation", "item"].map((kind) => ({
        reservationId: `${request.requestId}:${kind}`,
        operationId: request.requestId,
        ownerStreamId: kind === "allocation" ? "inventory.channel-stock-allocation-item" : "inventory.item-item",
        purpose: "activation",
        resourceKey: `stock/${accountId}/item`,
        consumer: { ...consumer.identity, requestId: request.requestId },
        seal: { version: 1, storeIncarnation: "inventory-v1" },
        target,
        commandFingerprint: request.commandFingerprint,
      }));
      const terminal: RequestTerminalBinding = {
        consumerStoreId: consumer.identity.storeId,
        consumerIncarnation: consumer.identity.incarnation,
        requestId: request.requestId,
        commandFingerprint: request.commandFingerprint,
        target,
        reservations: manifest,
        preparationDeadline: "2099-01-01T00:00:00.000Z",
      };
      for (const reservation of manifest) await reservations.reserve(reservation);
      await reservations.openRequestTerminal(terminal);
      return {
        terminal,
        reservations: manifest,
        evidence: manifest.map((r) => ({
          owner: "inventory",
          key: r.ownerStreamId,
          storeIncarnation: r.seal.storeIncarnation,
          sealVersion: r.seal.version,
          promiseId: r.reservationId,
        })),
      };
    }),
  };
  const input: AcceptListingTargetPriceInput = {
    accountId,
    listingId,
    expectedListingVersion: 1,
    idempotencyKey: "accept",
    target: { kind: "channel-connection", connectionId: "connection" },
    priceAmount: "12.00",
    priceCurrencyCode: "USD",
    expectedTargetPriceRevision: 0,
    decision: { kind: "seller-reference" },
  };
  const make = (eventStore: EventStore = store) => createListingTargetRuntime({ eventStore, authority });
  const runtime = make();
  const all = () => store.readAll({ limit: 500 });
  return { store, authority, runtime, make, consumer, reservations, input, context, principal, keys, all };
}

describe("channel-only target runtime", () => {
  it("does not expose unfenced target commands through the raw Listing command handler", async () => {
    const f = await fixture();
    const accepted = await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
    const core = createMarketplaceListingRuntime({
      eventStore: f.store,
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
      db: { query: async () => ({ rows: [] }) } as never,
      commercialTermsResolver: { resolveListingTerms: vi.fn() } as never,
    });
    await expect(
      core.commandHandler({
        streamId: `marketplace.listing-${f.input.listingId}`,
        context: f.context,
        command: {
          type: "AcceptListingTargetPrice",
          expectedTargetPriceRevision: 1,
          acceptedTargetPrice: { ...accepted.acceptedTargetPrice, targetPriceRevision: 2 },
        },
      }),
    ).rejects.toThrow("owner-fenced");
    await expect(
      core.commandHandler({
        streamId: `marketplace.listing-${f.input.listingId}`,
        context: f.context,
        command: {
          type: "ActivateListingForChannel",
          connectionId: "connection",
          expectedTargetPriceRevision: 1,
          allocationRevision: 1,
        },
      }),
    ).rejects.toThrow("owner-fenced");
    expect(await f.all()).toHaveLength(3);
  });
  it("accepts then activates from canonical history without native publication or projection reads", async () => {
    const f = await fixture();
    const accepted = await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
    const activated = await f.runtime.activateListingForChannel(
      {
        accountId: f.input.accountId,
        listingId: f.input.listingId,
        expectedListingVersion: accepted.version,
        idempotencyKey: "activate",
        connectionId: "connection",
        expectedTargetPriceRevision: 1,
        allocationRevision: 1,
      },
      f.context,
      f.principal,
    );
    expect(activated.state.status).toBe("active");
    expect(activated.state.nativeVisibility).toBe("disabled");
    expect(activated.state.feeLocks).toEqual([]);
    expect((await f.all()).map((e) => e.eventType)).not.toContain("marketplace.listing.published");
    expect((await f.all()).map((e) => e.eventType)).not.toContain("marketplace.listing.price-updated");
    expect(
      (
        await f.runtime.readAcceptedListingTargetPrices({
          accountId: f.input.accountId,
          targets: [{ listingId: f.input.listingId, target: f.input.target }],
        })
      )[0].acceptedTargetPrice,
    ).toEqual(accepted.acceptedTargetPrice);
  });
  it("replays the original complete-command result before rechecking authority and conflicts on changes", async () => {
    const f = await fixture();
    const first = await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
    vi.mocked(f.authority.authorizeManage).mockRejectedValue(new Error("revoked"));
    expect(await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal)).toEqual(first);
    await expect(
      f.runtime.acceptListingTargetPrice({ ...f.input, priceCurrencyCode: "EUR" }, f.context, f.principal),
    ).rejects.toThrow("different command");
    expect(await f.all()).toHaveLength(3);
  });
  it("recovers a lost committed reply by reading the durable original result", async () => {
    const f = await fixture();
    const runtime = f.make({
      ...f.store,
      appendToStreams: async (inputs) => {
        await f.store.appendToStreams!(inputs);
        throw new Error("lost reply");
      },
    });
    const result = await runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
    expect(result.version).toBe(2);
    expect(await f.all()).toHaveLength(3);
  });
  it("records equal amounts with a new authority as a new complete acceptance", async () => {
    const f = await fixture();
    const first = await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
    const second = await f.runtime.acceptListingTargetPrice(
      { ...f.input, expectedListingVersion: 2, expectedTargetPriceRevision: 1, idempotencyKey: "accept-again" },
      f.context,
      f.principal,
    );
    expect(second.acceptedTargetPrice.targetPriceRevision).toBe(2);
    expect(second.acceptedTargetPrice.sourceEventId).not.toBe(first.acceptedTargetPrice.sourceEventId);
    expect(second.acceptedTargetPrice.priceCurrencyCode).toBe("USD");
  });
  it.each(["priceAmount", "priceCurrencyCode"] as const)(
    "refuses a partial pair missing %s with zero events",
    async (missing) => {
      const f = await fixture();
      const input = { ...f.input, [missing]: undefined };
      await expect(f.runtime.acceptListingTargetPrice(input as never, f.context, f.principal)).rejects.toThrow();
      expect(await f.all()).toHaveLength(1);
    },
  );
  it("refuses an unrecognized currency without recording acceptance", async () => {
    const f = await fixture();
    await expect(
      f.runtime.acceptListingTargetPrice({ ...f.input, priceCurrencyCode: "ZZZ" }, f.context, f.principal),
    ).rejects.toThrow("ISO-4217");
    expect(await f.all()).toHaveLength(1);
  });
  it.each([0, 1, 2, 3, 4])(
    "class C CLOSED-THROUGH after capture refuses predicate %i at append with zero events",
    async (index) => {
      const f = await fixture();
      const runtime = f.make({
        ...f.store,
        appendToStreams: async (inputs) => {
          const key = f.keys[index];
          f.consumer.closeThrough(key, {
            sourceIncarnation: `source-${key.split("/")[0]}`,
            keyCreationEpoch: 0,
            closedThroughEpoch: 0,
            topologyRevision: 1,
          });
          return f.store.appendToStreams!(inputs);
        },
      });
      await expect(runtime.acceptListingTargetPrice(f.input, f.context, f.principal)).rejects.toThrow();
      expect(await f.all()).toHaveLength(1);
    },
  );
  it("refuses incomplete grant manifests and Pricing evaluation with zero business events", async () => {
    const f = await fixture();
    vi.mocked(f.authority.authorizeManage).mockResolvedValue({ grants: [], evidence: [] });
    await expect(f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal)).rejects.toThrow("incomplete");
    await expect(
      f.runtime.acceptListingTargetPrice(
        {
          ...f.input,
          decision: {
            kind: "pricing-evaluation",
            evaluationId: "evaluation",
            evaluationRevision: "1",
            basePriceRevision: 1,
            standingAuthorizationId: "standing",
            standingAuthorizationRevision: "1",
          },
        },
        f.context,
        f.principal,
      ),
    ).rejects.toThrow("Pricing");
    expect(await f.all()).toHaveLength(1);
  });
  it.each(["missing-token", "duplicate", "foreign-owner", "extra"])(
    "refuses %s authorization evidence",
    async (mutation) => {
      const f = await fixture();
      const capture = await f.authority.authorizeManage(
        { accountId: f.input.accountId, principal: f.principal },
        f.context,
      );
      const evidence =
        mutation === "missing-token"
          ? capture.evidence.filter((e) => !e.key.startsWith("session-token/"))
          : mutation === "duplicate"
            ? [...capture.evidence, capture.evidence[0]]
            : mutation === "foreign-owner"
              ? capture.evidence.map((e) => ({ ...e, owner: "foreign" }))
              : [...capture.evidence, { ...capture.evidence[0], key: "extra" }];
      vi.mocked(f.authority.authorizeManage).mockResolvedValue({ ...capture, evidence });
      await expect(f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal)).rejects.toThrow();
      expect(await f.all()).toHaveLength(1);
    },
  );
  it("validates bounded read input and folds a repeated Listing only once", async () => {
    const f = await fixture();
    const readStream = vi.fn(f.store.readStream);
    const runtime = f.make({ ...f.store, readStream });
    await expect(runtime.readAcceptedListingTargetPrices({ accountId: "", targets: [] })).rejects.toThrow();
    expect(readStream).not.toHaveBeenCalled();
    const target = { listingId: f.input.listingId, target: f.input.target };
    expect(
      await runtime.readAcceptedListingTargetPrices({ accountId: f.input.accountId, targets: [target, target] }),
    ).toHaveLength(2);
    expect(readStream).toHaveBeenCalledTimes(1);
  });
  it("refuses activation without an exact current acceptance and bounds target reads", async () => {
    const f = await fixture();
    await expect(
      f.runtime.activateListingForChannel(
        {
          accountId: f.input.accountId,
          listingId: f.input.listingId,
          expectedListingVersion: 1,
          idempotencyKey: "activate",
          connectionId: "connection",
          expectedTargetPriceRevision: 1,
          allocationRevision: 1,
        },
        f.context,
        f.principal,
      ),
    ).rejects.toThrow();
    await expect(
      f.runtime.readAcceptedListingTargetPrices({
        accountId: f.input.accountId,
        targets: Array.from({ length: 501 }, () => ({ listingId: f.input.listingId, target: f.input.target })),
      }),
    ).rejects.toThrow("500");
    expect(await f.all()).toHaveLength(1);
  });
  it.each(["listing-version", "target-revision", "wrong-target", "connection-revision"])(
    "refuses activation with stale or wrong %s acceptance before preparing Inventory",
    async (mutation) => {
      const f = await fixture();
      await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
      if (mutation === "connection-revision") {
        const prior = await f.authority.resolveConnection({ accountId: f.input.accountId, connectionId: "connection" });
        vi.mocked(f.authority.resolveConnection).mockResolvedValue({
          ...prior,
          connection: { ...prior.connection, identityRevision: 2 },
        });
      }
      await expect(
        f.runtime.activateListingForChannel(
          {
            accountId: f.input.accountId,
            listingId: f.input.listingId,
            expectedListingVersion: mutation === "listing-version" ? 1 : 2,
            expectedTargetPriceRevision: mutation === "target-revision" ? 2 : 1,
            connectionId: mutation === "wrong-target" ? "other" : "connection",
            allocationRevision: 1,
            idempotencyKey: "activate",
          },
          f.context,
          f.principal,
        ),
      ).rejects.toThrow();
      expect(f.authority.prepareAllocation).not.toHaveBeenCalled();
      expect(await f.all()).toHaveLength(3);
    },
  );
  it.each([false, true])(
    "class M original-terminal abort CAS rejects an invalidation; omission mutant=%s",
    async (mutant) => {
      const f = await fixture();
      await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
      const runtime = f.make({
        ...f.store,
        appendToStreams: async (inputs) => {
          const terminal = inputs.find((value) => value.requestTerminal)?.requestTerminal;
          if (!terminal) throw new Error("missing test terminal");
          await f.reservations.abortRequestTerminal(terminal);
          return f.store.appendToStreams!(
            mutant ? inputs.map(({ requestTerminal: _terminal, ...input }) => input) : inputs,
          );
        },
      });
      const run = runtime.activateListingForChannel(
        {
          accountId: f.input.accountId,
          listingId: f.input.listingId,
          expectedListingVersion: 2,
          idempotencyKey: "activate",
          connectionId: "connection",
          expectedTargetPriceRevision: 1,
          allocationRevision: 1,
        },
        f.context,
        f.principal,
      );
      if (mutant) {
        await expect(run).resolves.toMatchObject({ version: 3 });
        expect(await f.all()).toHaveLength(5);
      } else {
        await expect(run).rejects.toThrow();
        expect(await f.all()).toHaveLength(3);
      }
    },
  );
  it.each(["seller", "inventory-capacity", "channel-inbound-dark"] as const)(
    "does not clear a %s pause",
    async (reason) => {
      const f = await fixture();
      await f.runtime.acceptListingTargetPrice(f.input, f.context, f.principal);
      await f.store.appendToStream({
        streamId: `marketplace.listing-${f.input.listingId}`,
        expectedVersion: 2,
        context: f.context,
        events: [{ eventType: "marketplace.listing.paused", payload: { reason } }],
      });
      await expect(
        f.runtime.activateListingForChannel(
          {
            accountId: f.input.accountId,
            listingId: f.input.listingId,
            expectedListingVersion: 3,
            idempotencyKey: "activate",
            connectionId: "connection",
            expectedTargetPriceRevision: 1,
            allocationRevision: 1,
          },
          f.context,
          f.principal,
        ),
      ).rejects.toThrow("Paused");
      expect(await f.all()).toHaveLength(4);
      expect(f.authority.prepareAllocation).not.toHaveBeenCalled();
    },
  );
});
