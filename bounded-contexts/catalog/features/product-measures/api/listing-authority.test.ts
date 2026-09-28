import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION, type EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createListingAuthorityFence,
  type ListingAuthorityOperationInput,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import {
  listingAuthorityConformance,
  type ListingAuthorityConformanceFixture,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { createCatalogListingAuthority } from "./listing-authority";
import { createProductMeasureRuntime, type ProductMeasureProfileInput } from "./runtime";
import { createCatalogItemRuntime } from "../../catalog-items/api/runtime";

const profile: ProductMeasureProfileInput = {
  profileId: "pmp_synthetic",
  key: "synthetic-profile",
  name: "Synthetic profile",
  unitLengthInches: 1,
  unitWidthInches: 1,
  unitHeightInches: 1,
  unitWeightOunces: 1,
  physicalFlags: ["rigid"],
  stackBehavior: "non-stackable",
  confidence: "measured",
};

async function fixture(withProfile = true) {
  const { eventStore: sourceStore } = createInMemoryEventStore();
  const { eventStore: consumerStore } = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  const currentRead = { current: true };
  const deps = {
    eventStore: sourceStore,
    db: {
      query: async <Row>(sql: string) => ({
        rows: sql.includes("WITH expected AS")
          ? ([{ generated_at: new Date(), current: currentRead.current }] as Row[])
          : ([] as Row[]),
      }),
    },
    checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => {} },
  };
  function restart() {
    const authority = createCatalogListingAuthority(deps, () => fence.forParticipant("catalog"));
    const fence = createListingAuthorityFence({
      eventStore: consumerStore,
      owner: "marketplace",
      participants: [authority.source],
    });
    const guardedDeps = { ...deps, eventStore: authority.eventStore };
    const measures = createProductMeasureRuntime(guardedDeps);
    const items = createCatalogItemRuntime(guardedDeps);
    const input: ListingAuthorityOperationInput = {
      tenantId: context.tenantId,
      accountId: context.audit.forAccountId,
      actor: { kind: "user", userId: context.audit.performedByUserId },
      committingOwner: "marketplace",
      kind: "native-visibility",
      requestId: "synthetic-catalog-request",
      command: { nativeVisibility: "enabled" },
      listingId: "lst_synthetic",
      subject: {
        inventoryItemId: "inv_synthetic",
        catalogItemId: "cat_synthetic",
        productId: "cat_synthetic::",
        selectedOptions: [],
        quantity: 1,
        pair: { amount: "12.00", currencyCode: "USD" },
        allocationRevision: null,
        commitmentSourceId: null,
      },
      target: { kind: "native-marketplace" },
      expectedListingRevision: 1,
      expectedTargetRevision: 1,
      expectedVisibilityRevision: 1,
      expectedPublicationRevision: null,
      participants: [authority.source.participant],
    };
    return {
      context,
      currentRead,
      input,
      sourceStore,
      consumerStore,
      source: authority.source,
      fence,
      authority,
      measures,
      items,
      restart,
      invalidate: async () => {
        await items.commandHandler({
          streamId: "catalog.item-cat_synthetic",
          command: { type: "ArchiveCatalogItem" },
          context,
        });
      },
    };
  }
  const f = restart();
  await f.authority.eventStore.appendToStream({
    streamId: "catalog.blueprint-bp_synthetic",
    expectedVersion: 0,
    context,
    events: [
      {
        eventType: "catalog.blueprint.created",
        payload: { blueprintId: "bp_synthetic", key: "synthetic", name: { en: "Synthetic" }, description: { en: "" } },
      },
      { eventType: "catalog.blueprint.published", payload: {} },
    ],
  });
  await f.authority.eventStore.appendToStream({
    streamId: "catalog.item-cat_synthetic",
    expectedVersion: 0,
    context,
    events: [
      {
        eventType: "catalog.catalog-item.created",
        payload: {
          itemId: "cat_synthetic",
          languageCode: "en",
          title: { en: "Synthetic" },
          subtitle: null,
          description: { en: "" },
        },
      },
      { eventType: "catalog.catalog-item.blueprint-assigned", payload: { blueprintId: "bp_synthetic" } },
      { eventType: "catalog.catalog-item.published", payload: { blueprintId: "bp_synthetic" } },
    ],
  });
  if (withProfile) await f.measures.upsertProfile(profile, context);
  return f;
}

describe("Catalog owner protocol conformance", () => {
  listingAuthorityConformance(it, async (): Promise<ListingAuthorityConformanceFixture> => fixture());
});

describe("Catalog Product and measures participation", () => {
  it("does not re-record structurally identical profiles after durable writer canonicalization", async () => {
    const f = await fixture();
    const before = await f.sourceStore.readStream({ streamId: "catalog.product-measure-profiles" });
    await f.measures.upsertProfile({ ...profile }, f.context);
    expect(await f.sourceStore.readStream({ streamId: "catalog.product-measure-profiles" })).toEqual(before);
  });
  it("reads bounded current Products without creating reservations and deduplicates source histories", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    await f.source.prepare(operation, f.context);
    const before = await f.sourceStore.readAll();
    const reads = vi.spyOn(f.sourceStore, "readStream");
    const result = await f.authority.readCurrentProducts(
      Array.from({ length: 100 }, () => f.input.subject),
      { maxAgeMs: 60_000 },
    );
    expect(result.value).toHaveLength(100);
    expect(result.value[0]?.productMeasureSnapshot?.productId).toBe(f.input.subject.productId);
    expect(reads.mock.calls.filter(([input]) => input.streamId === "catalog.product-measure-profiles")).toHaveLength(1);
    expect(reads.mock.calls.filter(([input]) => input.streamId === "catalog.item-cat_synthetic")).toHaveLength(1);
    expect(await f.sourceStore.readAll()).toEqual(before);
    f.currentRead.current = false;
    await expect(f.authority.readCurrentProducts([f.input.subject], { maxAgeMs: 60_000 })).rejects.toThrow(
      "stale or unreconciled",
    );
    await expect(
      f.authority.readCurrentProducts(
        Array.from({ length: 101 }, () => f.input.subject),
        { maxAgeMs: 60_000 },
      ),
    ).rejects.toThrow("100");
  });
  it("reserves actual Product and current measures with no consumer mirror or Catalog projection", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    expect(grant.value.productMeasureSnapshot).toMatchObject({ productId: "cat_synthetic::", unitWeightOunces: 1 });
    const facts = await f.sourceStore.readStream({ streamId: "catalog.product-measures-cat_synthetic" });
    expect(grant.value.productMeasureRevision).toBe(facts.at(-1)?.streamVersion);
    expect(await f.consumerStore.readStream({ streamId: "catalog.product-measures-cat_synthetic" })).toEqual([]);
  });

  it("protects absent and newly competing profiles across authoring tenants", async () => {
    const f = await fixture(false);
    const operation = await f.fence.open(f.input, f.context);
    expect((await f.source.prepare(operation, f.context)).value.productMeasureSnapshot).toBeNull();
    await f.measures.upsertProfile(profile, { ...f.context, tenantId: "tnt_synthetic_catalog_author" });
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-profile-added" }, f.context);
    expect((await f.source.prepare(next, f.context)).value.productMeasureSnapshot).not.toBeNull();
    await f.measures.upsertProfile(
      { ...profile, profileId: "pmp_competing", key: "competing", precedence: 1, unitWeightOunces: 2 },
      f.context,
    );
    expect((await f.fence.inspect(next)).status).toBe("aborted");
  });

  it("keeps a committed decision while an actual item archive rejects the next authorization", async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    await f.consumerStore.appendToStreams!([await f.fence.prepareCommit(operation, [grant], { enabled: true })]);
    await f.invalidate();
    expect((await f.fence.inspect(operation)).status).toBe("committed");
    const next = await f.fence.open({ ...f.input, requestId: "synthetic-after-archive" }, f.context);
    await expect(f.restart().source.prepare(next, f.context)).rejects.toThrow("not currently published");
  });
});
