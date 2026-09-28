import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
} from "../../listings/domain/domain";
import { marketplaceListingCodec } from "../../listings/domain/codec";
import { createListingTargetRuntime } from "../../listings/api/target-runtime";
import { createSyntheticListingAuthority } from "../../listings/api/authority-test-support";
import { createListingInboundClampOwnership } from "./ownership";

async function fixture() {
  const memory = createInMemoryEventStore();
  const eventStore = memory.eventStore;
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  const { repository, commandHandler } = createAggregateCommandHandler({
    eventStore,
    codec: marketplaceListingCodec,
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });
  await commandHandler({
    streamId: "marketplace.listing-lst_synthetic",
    context,
    command: {
      type: "CreateListing",
      publicationScope: "channel-only",
      listingId: "lst_synthetic",
      accountId: "acc_synthetic",
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions: [],
      itemTitle: null,
      itemSubtitle: null,
      productSummary: null,
      storageLocationName: null,
      shipFromCode: null,
      shipFromAddress: {
        name: "Synthetic seller",
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
      quantityCap: 1,
      evidenceRequirements: null,
    },
  });
  await eventStore.appendToStream({
    streamId: "marketplace.listing-lst_synthetic",
    expectedVersion: 1,
    context,
    events: [
      {
        eventType: "marketplace.listing.channel-activated",
        payload: { connectionId: "con_synthetic", targetPriceRevision: 1, allocationRevision: 1 },
      },
    ],
  });
  const synthetic = createSyntheticListingAuthority(eventStore);
  const targets = createListingTargetRuntime({
    eventStore,
    authority: synthetic.authority,
    load: (id) => repository.load(`marketplace.listing-${id}`),
    prepareNativeEnable: async () => {
      throw new Error("Native publication must not run during recovery.");
    },
    capacityAppends: async (_state, _events, _context, operation) => ({
      appends: [],
      reservations: await synthetic.reserve("stock-allocation", operation),
    }),
  });
  const listings = {
    commandHandler,
    loadListingState: async (id: string) => (await repository.load(`marketplace.listing-${id}`)).state,
    resumeListing: targets.resumeListing,
  };
  let legacy: { connection_id: string; run_id: string; paused_stream_version: number }[] = [];
  const db: PgQueryable = {
    async query<Row>(sql: string, params?: readonly unknown[]) {
      if (sql.includes("FROM marketplace_channel_inbound_clamps")) return { rows: legacy as Row[] };
      const operations = [...memory.streams.values()]
        .flat()
        .filter((event) => event.eventType === "marketplace.listing-authority-operation.opened")
        .map((event) => ({ operation: event.payload.operation as unknown as ListingAuthorityOperation }))
        .filter(
          ({ operation }) =>
            operation.tenantId === params![0] &&
            operation.accountId === params![1] &&
            operation.listingId === params![2] &&
            operation.kind === "resume" &&
            JSON.stringify(operation.command.inboundClamp) ===
              JSON.stringify({ connectionId: params![3], runId: params![4], generation: Number(params![5]) }),
        );
      return { rows: operations.slice(-1) as Row[] };
    },
  };
  const restart = () => createListingInboundClampOwnership({ eventStore, db, listings });
  const owner = { accountId: "acc_synthetic", listingId: "lst_synthetic", connectionId: "con_one", runId: "run_one" };
  return {
    eventStore,
    context,
    listings,
    restart,
    owner,
    setLegacy: (rows: typeof legacy) => {
      legacy = rows;
    },
  };
}

describe("source-owned inbound clamp recovery", () => {
  it("adopts the complete retained legacy owner set under the Listing revision before releasing one owner", async () => {
    const f = await fixture();
    await f.listings.commandHandler({
      streamId: "marketplace.listing-lst_synthetic",
      context: f.context,
      command: { type: "PauseListing", reason: "channel-inbound-dark" },
    });
    const paused = (await f.listings.loadListingState(f.owner.listingId)).streamRevision;
    f.setLegacy([
      { connection_id: f.owner.connectionId, run_id: f.owner.runId, paused_stream_version: paused },
      { connection_id: "con_legacy", run_id: "run_legacy", paused_stream_version: paused },
    ]);
    expect(await f.restart().release(f.owner, f.context)).toMatchObject({ retained: true });
    expect(await f.listings.loadListingState(f.owner.listingId)).toMatchObject({
      status: "paused",
      inboundClampOwners: [{ connectionId: "con_legacy" }],
      nativeVisibility: "disabled",
    });
    await f.restart().release({ ...f.owner, connectionId: "con_legacy", runId: "run_legacy" }, f.context);
    expect(await f.listings.loadListingState(f.owner.listingId)).toMatchObject({
      status: "active",
      nativePublicationRevision: null,
    });
  });
  it("does not adopt incomplete legacy ownership or a mismatched pause revision", async () => {
    const f = await fixture();
    await f.listings.commandHandler({
      streamId: "marketplace.listing-lst_synthetic",
      context: f.context,
      command: { type: "PauseListing", reason: "channel-inbound-dark" },
    });
    f.setLegacy([{ connection_id: f.owner.connectionId, run_id: f.owner.runId, paused_stream_version: 2 }]);
    await expect(f.restart().release(f.owner, f.context)).rejects.toThrow("Legacy inbound clamp ownership");
    expect((await f.listings.loadListingState(f.owner.listingId)).inboundClampOwners).toEqual([]);
  });
  it("retains another arrival and resumes the last owner without publishing native scope", async () => {
    const f = await fixture();
    const second = { ...f.owner, connectionId: "con_two", runId: "run_two" };
    await f.restart().engage(f.owner, f.context);
    await f.restart().engage(second, f.context);
    expect(await f.restart().release(f.owner, f.context)).toMatchObject({ retained: true });
    expect((await f.listings.loadListingState(f.owner.listingId)).status).toBe("paused");
    await f.restart().release(second, f.context);
    expect(await f.listings.loadListingState(f.owner.listingId)).toMatchObject({
      status: "active",
      nativeVisibility: "disabled",
      nativePublicationRevision: null,
      feeLocks: [],
    });
    await expect(f.restart().engage(f.owner, f.context)).rejects.toThrow("cannot be reused");
  });
  it("replays durable release after a lost resume acknowledgement without another event", async () => {
    const f = await fixture();
    await f.restart().engage(f.owner, f.context);
    const resume = f.listings.resumeListing;
    vi.spyOn(f.listings, "resumeListing").mockImplementationOnce(async (...args) => {
      await resume(...args);
      throw new Error("synthetic lost acknowledgement");
    });
    await expect(f.restart().release(f.owner, f.context)).rejects.toThrow("lost acknowledgement");
    const before = await f.eventStore.readStream({ streamId: "marketplace.listing-lst_synthetic" });
    expect(await f.restart().release(f.owner, f.context)).toMatchObject({ retained: false });
    expect(await f.eventStore.readStream({ streamId: "marketplace.listing-lst_synthetic" })).toEqual(before);
  });
  it("rejects an old resume when a new clamp wins immediately before its atomic append", async () => {
    const f = await fixture();
    await f.restart().engage(f.owner, f.context);
    const append = f.eventStore.appendToStreams!;
    let raced = false;
    vi.spyOn(f.eventStore, "appendToStreams").mockImplementation(async (inputs) => {
      if (
        !raced &&
        inputs.some((input) => input.events.some((event) => event.eventType === "marketplace.listing.resumed"))
      ) {
        raced = true;
        await f.restart().engage({ ...f.owner, connectionId: "con_new", runId: "run_new" }, f.context);
      }
      return append(inputs);
    });
    await expect(f.restart().release(f.owner, f.context)).rejects.toMatchObject({ code: "concurrency_conflict" });
    expect((await f.listings.loadListingState(f.owner.listingId)).inboundClampOwners).toHaveLength(2);
    expect(await f.restart().release(f.owner, f.context)).toMatchObject({ retained: true });
    expect(await f.listings.loadListingState(f.owner.listingId)).toMatchObject({
      status: "paused",
      nativeVisibility: "disabled",
      inboundClampOwners: [{ connectionId: "con_new" }],
    });
  });
});
