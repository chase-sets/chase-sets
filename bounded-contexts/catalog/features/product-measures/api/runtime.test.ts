import {
  assertMeasurePublicationConsumer,
  withMeasurePublicationStaging,
} from "@chase-sets/event-core-postgres/measure-publication-test-support";
import { describe, expect, it, vi } from "vitest";
import { drainSubscriptionRunners, type ContextSubscriptionRunner } from "@chase-sets/bounded-context-runtime";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { isTransientProjectionError, type ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  assembleProductMeasurePublication,
  parseProductMeasurePublicationPart,
  productMeasurePublicationCompleted,
  productMeasurePublicationPartRecorded,
  type ProductMeasureSnapshot,
} from "@chase-sets/product-measures";
import { createProductMeasureRuntime } from "./runtime";

type ProfileRow = Readonly<{
  profile_id: string;
  key: string;
  name: string;
  status: string;
  match_blueprint_id: string | null;
  match_category_ids: unknown;
  match_selected_options: unknown;
  measure_snapshot: unknown;
  precedence: number;
  updated_at: string;
}>;

type CatalogItemRow = Readonly<{
  catalog_item_id: string;
  blueprint_id: string | null;
  category_ids: unknown;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type ResolvedMeasureRow = Readonly<{
  product_id: string;
  catalog_item_id: string;
  selected_options: unknown;
  measure_snapshot: unknown;
  missing_reason: string | null;
  updated_at: string;
}>;

function parseJson(value: unknown) {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function createMeasureDb(item: CatalogItemRow) {
  const profiles: ProfileRow[] = [];
  const resolved = new Map<string, ResolvedMeasureRow>();

  const db = {
    query: vi.fn(async <T>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO catalog_product_measure_profiles")) {
        profiles.push({
          profile_id: String(params?.[0] ?? ""),
          key: String(params?.[1] ?? ""),
          name: String(params?.[2] ?? ""),
          status: "active",
          match_blueprint_id: typeof params?.[3] === "string" ? String(params[3]) : null,
          match_category_ids: parseJson(params?.[4]),
          match_selected_options: parseJson(params?.[5]),
          measure_snapshot: parseJson(params?.[6]),
          precedence: Number(params?.[7] ?? 100),
          updated_at: "2026-05-21T00:00:00.000Z",
        });
        return { rows: [] as T[] };
      }

      if (sql.includes("FROM catalog_items") && sql.includes("catalog_item_id = $1")) {
        return { rows: [item] as T[] };
      }

      if (sql.includes("FROM catalog_product_measure_profiles")) {
        return {
          rows: [...profiles].sort(
            (left, right) => left.precedence - right.precedence || left.key.localeCompare(right.key),
          ) as T[],
        };
      }

      if (sql.includes("DELETE FROM catalog_resolved_product_measures")) {
        for (const [productId, row] of [...resolved.entries()]) {
          if (row.catalog_item_id === params?.[0]) {
            resolved.delete(productId);
          }
        }
        return { rows: [] as T[] };
      }

      if (sql.includes("INSERT INTO catalog_resolved_product_measures")) {
        const row: ResolvedMeasureRow = {
          product_id: String(params?.[0] ?? ""),
          catalog_item_id: String(params?.[1] ?? ""),
          selected_options: parseJson(params?.[2]),
          measure_snapshot: parseJson(params?.[3]),
          missing_reason: typeof params?.[4] === "string" ? String(params[4]) : null,
          updated_at: "2026-05-21T00:00:00.000Z",
        };
        resolved.set(row.product_id, row);
        return { rows: [] as T[] };
      }

      if (sql.includes("FROM catalog_resolved_product_measures")) {
        return {
          rows: [...resolved.values()].sort((left, right) => left.product_id.localeCompare(right.product_id)) as T[],
        };
      }

      return { rows: [] as T[] };
    }),
  } as unknown as PgQueryable;

  return { db, resolved };
}

function storedEvent(streamVersion: number, eventType = "catalog.product-measures.control"): StoredEvent {
  return {
    eventId: `evt_measures_${streamVersion}` as never,
    streamId: "catalog.product-measures-cat_1",
    streamVersion,
    globalPosition: String(streamVersion) as never,
    tenantId: "tnt_test" as never,
    eventType,
    payload: {},
    metadata: {},
    occurredAt: "2026-05-25T00:00:00.000Z" as never,
    recordedAt: "2026-05-25T00:00:00.000Z" as never,
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  };
}

const eventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_test" as never },
};

function resolvedStoredEvent(streamVersion: number, payload: StoredEvent["payload"]): StoredEvent {
  return {
    ...storedEvent(streamVersion, "catalog.catalog-item.product-measures-resolved"),
    payload,
  };
}

function createEventStore(existingEvents: readonly StoredEvent[] = []) {
  const events = [...existingEvents];
  const appended: AppendToStreamInput[] = [];
  const reads: ReadStreamInput[] = [];
  const eventStore: EventStore = {
    appendToStream: vi.fn(async (input: AppendToStreamInput) => {
      appended.push(input);
      if (typeof input.expectedVersion !== "number") {
        throw new Error("Product Measures fixture requires a numeric expected stream version.");
      }
      let streamVersion = input.expectedVersion;
      for (const event of input.events) {
        streamVersion += 1;
        events.push({
          ...storedEvent(streamVersion, event.eventType),
          streamId: input.streamId,
          payload: event.payload,
        });
      }
      return [];
    }),
    readStream: async (input: ReadStreamInput): Promise<StoredEvent[]> => {
      reads.push(input);
      const fromIndex = (input.fromVersion ?? 1) - 1;
      return events.slice(fromIndex, fromIndex + (input.limit ?? 500));
    },
    readAll: async (_input?: ReadAllInput): Promise<StoredEvent[]> => [],
  };
  return { eventStore, events, appended, reads };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
}

async function createProfiledMeasureFixture(existingEvents: readonly StoredEvent[] = []) {
  const { db } = createMeasureDb({
    catalog_item_id: "cat_1",
    blueprint_id: "bp_card",
    category_ids: ["cat_pokemon"],
    canonical_dimension_order: ["form"],
    dimension_rules: [
      {
        dimensionId: "form",
        required: true,
        allowedOptions: [{ optionId: "raw" }, { optionId: "graded" }],
      },
    ],
  });
  const store = createEventStore(existingEvents);
  const services = createProductMeasureRuntime({
    db,
    eventStore: store.eventStore,
    checkpointStore: createCheckpointStore(),
  });

  await services.upsertProfile({
    profileId: "p_card",
    key: "pokemon-card",
    name: "Pokemon card",
    matchCategoryIds: ["cat_pokemon"],
    precedence: 100,
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.012,
    unitWeightOunces: 0.064,
    physicalFlags: ["bendable"],
    stackBehavior: "stackable-thickness",
    confidence: "measured",
  });

  return { db, services, ...store };
}

async function resolvedCandidatePayload() {
  const fixture = await createProfiledMeasureFixture();
  await fixture.services.resolveCatalogItemMeasures("cat_1", eventStoreContext);
  const payload = fixture.appended[0]?.events[0]?.payload;
  if (!payload) {
    throw new Error("Product Measures fixture did not author its initial resolved fact.");
  }
  return { db: fixture.db, payload };
}

function reverseObjectProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectProperties);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, entry]) => [key, reverseObjectProperties(entry)]),
    );
  }
  return value;
}

function resolvedFactCount(events: readonly StoredEvent[]): number {
  return events.filter(({ eventType }) => eventType === "catalog.catalog-item.product-measures-resolved").length;
}

async function createSyntheticMeasureFixture(
  optionIds = Array.from({ length: 255 }, (_, index) => `synthetic-${index}`),
) {
  const item: CatalogItemRow = {
    catalog_item_id: "cat_synthetic_multipart",
    blueprint_id: null,
    category_ids: [],
    canonical_dimension_order: ["form"],
    dimension_rules: [{ dimensionId: "form", required: true, allowedOptionIds: optionIds }],
  };
  const { db, resolved } = createMeasureDb(item);
  const store = createEventStore();
  const services = createProductMeasureRuntime({
    db,
    eventStore: store.eventStore,
    checkpointStore: createCheckpointStore(),
  });
  await services.upsertProfile({
    profileId: "p_synthetic",
    key: "synthetic-multipart",
    name: "Synthetic multipart regression",
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.012,
    unitWeightOunces: 0.064,
    physicalFlags: ["bendable"],
    stackBehavior: "stackable-thickness",
    confidence: "measured",
  });
  return { item, optionIds, db, resolved, services, ...store };
}

async function completePublicationProducts(events: readonly StoredEvent[]) {
  const completion = events.at(-1)!;
  return assembleProductMeasurePublication(
    { ...completion, data: completion.payload },
    events.slice(0, -1).map((event) => ({ ...event, data: event.payload })),
  );
}

describe("Catalog multipart publication", () => {
  it("publishes all 255 synthetic Products once in enumeration order within every event byte budget", async () => {
    const fixture = await createSyntheticMeasureFixture();
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
    expect(fixture.appended).toHaveLength(1);
    expect(fixture.appended[0]!.expectedVersion).toBe(0);
    expect(fixture.events.length).toBeGreaterThanOrEqual(3);
    expect(fixture.events.at(-1)!.eventType).toBe(productMeasurePublicationCompleted);
    expect(
      fixture.events.slice(0, -1).every((event) => event.eventType === productMeasurePublicationPartRecorded),
    ).toBe(true);
    const ledger = fixture.events.map((event) => ({
      version: event.streamVersion,
      bytes: Buffer.byteLength(JSON.stringify(event.payload), "utf8"),
      productIds:
        event.eventType === productMeasurePublicationPartRecorded
          ? parseProductMeasurePublicationPart(event.payload).products.map(({ productId }) => productId)
          : [],
    }));
    expect(
      ledger.every(({ bytes }) => bytes <= 64_512),
      JSON.stringify(ledger),
    ).toBe(true);
    const products = await completePublicationProducts(fixture.events);
    expect(products.map(({ productId }) => productId)).toEqual(
      fixture.optionIds.map((option) => `${fixture.item.catalog_item_id}::form:${option}`),
    );
    expect(new Set(products.map(({ productId }) => productId)).size).toBe(255);
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
    expect(fixture.appended).toHaveLength(1);
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id);
    expect([...fixture.resolved.values()].map(({ measure_snapshot }) => measure_snapshot)).toEqual(products);
  });

  it("appends fresh legacy A after multipart B, then no-ops only against current A", async () => {
    const fixture = await createSyntheticMeasureFixture();
    const largeRules = fixture.item.dimension_rules;
    Object.assign(fixture.item, {
      dimension_rules: [{ dimensionId: "form", required: true, allowedOptionIds: ["synthetic-0"] }],
    });
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
    const a = fixture.events[0]!.payload;
    Object.assign(fixture.item, { dimension_rules: largeRules });
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
    expect(fixture.events.at(-1)!.eventType).toBe(productMeasurePublicationCompleted);
    const bVersion = fixture.events.at(-1)!.streamVersion;
    Object.assign(fixture.item, {
      dimension_rules: [{ dimensionId: "form", required: true, allowedOptionIds: ["synthetic-0"] }],
    });
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
    expect(fixture.appended).toHaveLength(3);
    expect(fixture.appended[2]!.expectedVersion).toBe(bVersion);
    expect(fixture.events.at(-1)!.payload).toEqual(a);
    await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
    expect(fixture.appended).toHaveLength(3);
  });

  it("never accepts a partial tail or poisoned completion as current publication", async () => {
    for (const poison of ["partial-tail", "digest", "identity", "part-type", "count"] as const) {
      const fixture = await createSyntheticMeasureFixture();
      await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
      if (poison === "partial-tail") {
        fixture.events.push({ ...fixture.events[0]!, streamVersion: fixture.events.at(-1)!.streamVersion + 1 });
      } else if (poison === "part-type") {
        fixture.events[0] = { ...fixture.events[0]!, eventType: "catalog.product-measures.control" };
      } else {
        const completion = fixture.events.at(-1)!;
        fixture.events[fixture.events.length - 1] = {
          ...completion,
          payload: {
            ...completion.payload,
            ...(poison === "digest"
              ? { productsDigest: "0".repeat(64) }
              : poison === "identity"
                ? { catalogItemId: "cat_other" }
                : { productCount: 1 }),
          },
        };
      }
      const before = fixture.events.length;
      await fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext);
      expect(fixture.appended, poison).toHaveLength(2);
      expect(fixture.appended[1]!.expectedVersion, poison).toBe(before);
      expect((await completePublicationProducts(fixture.events.slice(before))).length, poison).toBe(255);
    }
  });

  it("refuses one oversized synthetic Product before any append rather than truncating it", async () => {
    const fixture = await createSyntheticMeasureFixture(["synthetic-" + "\u00e9".repeat(40_000)]);
    await expect(
      fixture.services.resolveCatalogItemMeasures(fixture.item.catalog_item_id, eventStoreContext),
    ).rejects.toMatchObject({
      code: "product_measure_publication_too_large",
      catalogItemId: fixture.item.catalog_item_id,
      productId: `${fixture.item.catalog_item_id}::form:${fixture.optionIds[0]}`,
    });
    expect(fixture.appended).toHaveLength(0);
    expect(fixture.events).toHaveLength(0);
  });

  it("retains byte-identical fitting legacy publication payloads", async () => {
    const fixture = await createProfiledMeasureFixture();
    await fixture.services.resolveCatalogItemMeasures("cat_1", eventStoreContext);
    const products: ProductMeasureSnapshot[] = ["raw", "graded"].map((optionId) => ({
      measureVersion: "pokemon-card:v1",
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.012,
      unitWeightOunces: 0.064,
      physicalFlags: ["bendable"],
      stackBehavior: "stackable-thickness",
      source: "profile",
      confidence: "measured",
      catalogItemId: "cat_1",
      productId: `cat_1::form:${optionId}`,
      selectedOptions: [{ dimensionId: "form", optionId }],
    }));
    expect(fixture.events[0]!.eventType).toBe("catalog.catalog-item.product-measures-resolved");
    expect(JSON.stringify(fixture.events[0]!.payload)).toBe(JSON.stringify({ catalogItemId: "cat_1", products }));
  });
});

describe("product measure runtime", () => {
  it("resolves product measures from the most specific matching profile", async () => {
    const { db, resolved } = createMeasureDb({
      catalog_item_id: "cat_1",
      blueprint_id: "bp_card",
      category_ids: ["cat_pokemon"],
      canonical_dimension_order: ["form"],
      dimension_rules: [
        {
          dimensionId: "form",
          required: true,
          allowedOptions: [{ optionId: "raw" }, { optionId: "graded-psa" }],
        },
      ],
    });
    const { eventStore, appended } = createEventStore();
    const services = createProductMeasureRuntime({
      db,
      eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await services.upsertProfile({
      profileId: "p_raw",
      key: "pokemon-raw",
      name: "Pokemon raw single",
      matchCategoryIds: ["cat_pokemon"],
      matchSelectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      precedence: 100,
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.012,
      unitWeightOunces: 0.064,
      physicalFlags: ["bendable"],
      stackBehavior: "stackable-thickness",
      confidence: "measured",
    });
    await services.upsertProfile({
      profileId: "p_psa",
      key: "pokemon-psa",
      name: "Pokemon PSA slab",
      matchCategoryIds: ["cat_pokemon"],
      matchSelectedOptions: [{ dimensionId: "form", optionId: "graded-psa" }],
      precedence: 90,
      unitLengthInches: 5.375,
      unitWidthInches: 3.25,
      unitHeightInches: 0.3,
      unitWeightOunces: 2.1,
      physicalFlags: ["rigid"],
      stackBehavior: "stackable-height",
      confidence: "measured",
    });

    await services.resolveCatalogItemMeasures("cat_1", {
      tenantId: "tnt_test" as never,
      audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_test" as never },
    });

    expect(resolved.size).toBe(0);
    expect(eventStore.appendToStream).toHaveBeenCalledTimes(1);
    expect(appended[0]?.events[0]?.eventType).toBe("catalog.catalog-item.product-measures-resolved");
    expect(appended[0]?.events[0]?.payload).toMatchObject({
      catalogItemId: "cat_1",
    });

    const appendedEvent = appended[0]?.events[0];
    const handler = appendedEvent ? services.projectors[0]?.handlers[appendedEvent.eventType] : undefined;
    await handler?.({
      id: "evt_1",
      type: appendedEvent?.eventType,
      data: appendedEvent?.payload,
      tenantId: "tnt_test",
      streamId: appended[0]?.streamId,
      streamVersion: 1,
      globalPosition: "1",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: {
        occurredAt: "2026-05-25T00:00:00.000Z",
        recordedAt: "2026-05-25T00:00:00.000Z",
      },
      metadata: {},
    } as never);

    expect(resolved.get("cat_1::form:raw")?.measure_snapshot).toMatchObject({
      productId: "cat_1::form:raw",
      physicalFlags: ["bendable"],
      unitWeightOunces: 0.064,
    });
    expect(resolved.get("cat_1::form:graded-psa")?.measure_snapshot).toMatchObject({
      productId: "cat_1::form:graded-psa",
      physicalFlags: ["rigid"],
      unitWeightOunces: 2.1,
    });
  });

  it("runs direct repair replacement in one database transaction when supported", async () => {
    const { db, resolved } = createMeasureDb({
      catalog_item_id: "cat_1",
      blueprint_id: "bp_card",
      category_ids: ["cat_pokemon"],
      canonical_dimension_order: ["form"],
      dimension_rules: [
        {
          dimensionId: "form",
          required: true,
          allowedOptions: [{ optionId: "raw" }],
        },
      ],
    });
    const transactionStatements: string[] = [];
    const transactionalDb = {
      ...db,
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
          transactionStatements.push(sql);
          return db.query(sql, params);
        }),
        release: vi.fn(),
      })),
    };
    const { eventStore } = createEventStore();
    const services = createProductMeasureRuntime({
      db: transactionalDb,
      eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await services.upsertProfile({
      profileId: "p_raw",
      key: "pokemon-raw",
      name: "Pokemon raw single",
      matchCategoryIds: ["cat_pokemon"],
      matchSelectedOptions: [{ dimensionId: "form", optionId: "raw" }],
      precedence: 100,
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.012,
      unitWeightOunces: 0.064,
      physicalFlags: ["bendable"],
      stackBehavior: "stackable-thickness",
      confidence: "measured",
    });

    await services.resolveCatalogItemMeasures("cat_1");

    expect(transactionStatements[0]).toBe("BEGIN");
    expect(transactionStatements).toContain("COMMIT");
    expect(transactionStatements.join("\n")).toContain("DELETE FROM catalog_resolved_product_measures");
    expect(transactionStatements.join("\n")).toContain("INSERT INTO catalog_resolved_product_measures");
    expect(resolved.get("cat_1::form:raw")).toBeDefined();
  });

  it("issue-6299-acceptance-control appends after a complete 501-event history at the final stream version", async () => {
    const { db } = createMeasureDb({
      catalog_item_id: "cat_1",
      blueprint_id: null,
      category_ids: [],
      canonical_dimension_order: [],
      dimension_rules: [],
    });
    const history = Array.from({ length: 501 }, (_, index) => storedEvent(index + 1));
    const { eventStore, appended, reads } = createEventStore(history);
    const services = createProductMeasureRuntime({
      db,
      eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await services.resolveCatalogItemMeasures("cat_1", {
      tenantId: "tnt_test" as never,
      audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_test" as never },
    });

    expect(reads.map((read) => read.fromVersion)).toEqual([1, 501]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.expectedVersion).toBe(501);

    const matchingHistory = [
      ...Array.from({ length: 500 }, (_, index) => storedEvent(index + 1)),
      resolvedStoredEvent(501, { products: [], catalogItemId: "cat_1" }),
    ];
    const matchingStore = createEventStore(matchingHistory);
    const matchingServices = createProductMeasureRuntime({
      db,
      eventStore: matchingStore.eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await matchingServices.resolveCatalogItemMeasures("cat_1", eventStoreContext);

    expect(matchingStore.reads.map((read) => read.fromVersion)).toEqual([1, 501]);
    expect(matchingStore.appended).toHaveLength(0);
  });

  it("does not append an unchanged resolved fact after nested JSONB key reordering", async () => {
    const { db, payload } = await resolvedCandidatePayload();
    const reorderedPayload = reverseObjectProperties(payload) as StoredEvent["payload"];
    expect(Object.keys(reorderedPayload)).not.toEqual(Object.keys(payload));
    expect(Object.keys((reorderedPayload.products as unknown[])[0] as object)).not.toEqual(
      Object.keys((payload.products as unknown[])[0] as object),
    );

    const store = createEventStore([resolvedStoredEvent(1, reorderedPayload)]);
    const services = createProductMeasureRuntime({
      db,
      eventStore: store.eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await services.resolveCatalogItemMeasures("cat_1", eventStoreContext);

    expect(store.appended).toHaveLength(0);
    expect(resolvedFactCount(store.events)).toBe(1);
  });

  it("appends one resolved fact when products or their array order changes", async () => {
    const { db, payload } = await resolvedCandidatePayload();
    const candidate = structuredClone(payload) as Record<string, unknown>;
    const products = candidate.products as Record<string, unknown>[];
    const cases = [
      {
        name: "one Product measure changes",
        payload: { ...candidate, products: [{ ...products[0], unitWeightOunces: 9.5 }, ...products.slice(1)] },
      },
      { name: "Product array order changes", payload: { ...candidate, products: [...products].reverse() } },
    ];

    for (const testCase of cases) {
      const store = createEventStore([resolvedStoredEvent(1, testCase.payload as StoredEvent["payload"])]);
      const services = createProductMeasureRuntime({
        db,
        eventStore: store.eventStore,
        checkpointStore: createCheckpointStore(),
      });
      const before = resolvedFactCount(store.events);

      await services.resolveCatalogItemMeasures("cat_1", eventStoreContext);

      expect(resolvedFactCount(store.events) - before, testCase.name).toBe(1);
      expect(store.appended, testCase.name).toHaveLength(1);
    }
  });

  it("settles repeated Product Measures resolution at one semantic snapshot", async () => {
    const fixture = await createProfiledMeasureFixture();

    await fixture.services.resolveCatalogItemMeasures("cat_1", eventStoreContext);
    await fixture.services.resolveCatalogItemMeasures("cat_1", eventStoreContext);
    await fixture.services.resolveCatalogItemMeasures("cat_1", eventStoreContext);

    expect(resolvedFactCount(fixture.events)).toBe(1);
    expect(fixture.appended).toHaveLength(1);
  });

  it("requires exact identity and JSON shape for an unchanged Product Measures fact", async () => {
    const { db, payload } = await resolvedCandidatePayload();
    const candidate = structuredClone(payload) as Record<string, unknown>;
    const products = candidate.products as Record<string, unknown>[];
    const [firstProduct, ...remainingProducts] = products;
    const { measureVersion: _missingMeasureVersion, ...missingNestedKey } = firstProduct;
    const cases = [
      { name: "mismatched Catalog Item identity", payload: { ...candidate, catalogItemId: "cat_other" } },
      { name: "missing top-level products key", payload: { catalogItemId: "cat_1" } },
      { name: "extra top-level key", payload: { ...candidate, unexpected: true } },
      { name: "malformed products value", payload: { ...candidate, products: {} } },
      {
        name: "missing nested measure key",
        payload: { ...candidate, products: [missingNestedKey, ...remainingProducts] },
      },
      {
        name: "extra nested measure key",
        payload: { ...candidate, products: [{ ...firstProduct, unexpected: true }, ...remainingProducts] },
      },
      {
        name: "malformed nested measure value",
        payload: { ...candidate, products: [{ ...firstProduct, selectedOptions: {} }, ...remainingProducts] },
      },
    ];

    for (const testCase of cases) {
      const store = createEventStore([resolvedStoredEvent(1, testCase.payload as StoredEvent["payload"])]);
      const services = createProductMeasureRuntime({
        db,
        eventStore: store.eventStore,
        checkpointStore: createCheckpointStore(),
      });
      const before = resolvedFactCount(store.events);

      await services.resolveCatalogItemMeasures("cat_1", eventStoreContext);

      expect(resolvedFactCount(store.events) - before, testCase.name).toBe(1);
      expect(store.appended, testCase.name).toHaveLength(1);
    }
  });
});

type ResolutionProfile = "matching" | "other-blueprint" | "none";

const cardProfile = {
  profileId: "p_card",
  key: "pokemon-card",
  name: "Pokemon card",
  matchCategoryIds: ["cat_pokemon"],
  precedence: 100,
  unitLengthInches: 3.5,
  unitWidthInches: 2.5,
  unitHeightInches: 0.012,
  unitWeightOunces: 0.064,
  physicalFlags: ["bendable"],
  stackBehavior: "stackable-thickness",
  confidence: "measured",
} as const;

// A Catalog Item as the reaction reads it: the catalog_items row, its
// Blueprint row's status (null when the row is absent), whether
// catalog-item-projection has applied the event, and the profile table.
async function createResolutionFixture(profile: ResolutionProfile = "matching") {
  const item = {
    catalog_item_id: "cat_1",
    status: "active",
    blueprint_id: "bp_card" as string | null,
    category_ids: ["cat_pokemon"] as string[],
    canonical_dimension_order: ["form"],
    dimension_rules: [
      { dimensionId: "form", required: true, allowedOptions: [{ optionId: "raw" }, { optionId: "graded" }] },
    ],
  };
  const store = createEventStore();
  const state = {
    itemProjectionApplied: true,
    removed: false,
    blueprintStatus: "active" as string | null,
    append: store.eventStore.appendToStream,
  };
  const rows = createMeasureDb(item);
  const db = {
    query: vi.fn(async <T>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("AS applied")) {
        return { rows: [{ applied: state.itemProjectionApplied }] as T[] };
      }
      if (sql.includes("has_product_measure_profiles")) {
        if (state.removed) return { rows: [] as T[] };
        const profiles = await rows.db.query("SELECT * FROM catalog_product_measure_profiles");
        return {
          rows: [
            {
              status: item.status,
              blueprint_id: item.blueprint_id,
              blueprint_status: item.blueprint_id === null ? null : state.blueprintStatus,
              has_product_measure_profiles: profiles.rows.length > 0,
            },
          ] as T[],
        };
      }
      if (state.removed && sql.includes("FROM catalog_items")) return { rows: [] as T[] };
      return rows.db.query<T>(sql, params);
    }),
  } as unknown as PgQueryable;
  const eventStore: EventStore = { ...store.eventStore, appendToStream: (input) => state.append(input) };
  const services = createProductMeasureRuntime({ db, eventStore, checkpointStore: createCheckpointStore() });
  const seedProfile = () =>
    services.upsertProfile(
      profile === "other-blueprint" ? { ...cardProfile, matchBlueprintId: "bp_other" } : cardProfile,
    );
  if (profile !== "none") await seedProfile();

  const event = (type: string) =>
    buildTransportEvent(
      type,
      {},
      {
        id: "evt_item_1",
        streamId: "catalog.item-cat_1",
        streamVersion: 4,
        globalPosition: "42",
        tenantId: "tnt_catalog",
        audit: { performedByUserId: "usr_operator", forAccountId: "acc_operator" },
        trace: { traceId: "trc_publish" as never },
      },
    );
  const handle = (type = "catalog.catalog-item.published") =>
    services.resolveMeasuresForCatalogItemEvent(event(type), { db: db as never });

  return { item, state, db, services, seedProfile, handle, appended: store.appended };
}

type ResolutionFixture = Awaited<ReturnType<typeof createResolutionFixture>>;

// A synchronous drain gives a dependency wait one more pass before it
// rethrows it, and rethrows any other failure at once.
async function drainOutcome(handle: () => Promise<void>) {
  let passes = 0;
  const runner = {
    subscriptionName: "catalog.product-measure-resolution",
    projectionName: "catalog-product-measure-resolution",
    sourceContextName: "catalog",
    targetContextName: "catalog",
    subscriptionVersion: 1,
    checkpointKey: "catalog-product-measure-resolution:catalog:v1",
    order: 100,
    runOnce: async () => {
      passes += 1;
      await handle();
      return { processed: 0 };
    },
  } as unknown as ContextSubscriptionRunner;
  const failure: unknown = await drainSubscriptionRunners([runner]).then(
    () => null,
    (error: unknown) => error,
  );
  return { passes, failure };
}

async function expectDependencyWait(handle: () => Promise<void>, message: string) {
  const { passes, failure } = await drainOutcome(handle);
  expect(isTransientProjectionError(failure), message).toBe(true);
  expect(String(failure)).toContain(message);
  expect(passes, message).toBe(2);
}

function publishedProductIds(appended: readonly AppendToStreamInput[]) {
  return appended.map((input) => {
    expect(input.streamId).toBe("catalog.product-measures-cat_1");
    expect(input.events.map((event) => event.eventType)).toEqual(["catalog.catalog-item.product-measures-resolved"]);
    expect(input.events[0]!.payload.catalogItemId).toBe("cat_1");
    return (input.events[0]!.payload.products as { productId: string }[]).map((product) => product.productId);
  });
}

describe("Catalog Item event measure resolution", () => {
  it("publishes every matched Product once for a published item under the event's tenant, audit and trace", async () => {
    const fixture = await createResolutionFixture();

    await fixture.handle();

    expect(publishedProductIds(fixture.appended)).toEqual([["cat_1::form:raw", "cat_1::form:graded"]]);
    expect(fixture.appended[0]!.expectedVersion).toBe(0);
    expect(fixture.appended[0]!.context).toEqual({
      tenantId: "tnt_catalog",
      audit: { performedByUserId: "usr_operator", forAccountId: "acc_operator" },
      trace: { traceId: "trc_publish" },
    });
    expect(fixture.db.query).toHaveBeenCalledWith(expect.stringContaining("event_subscription_applications"), [
      "catalog-item-projection:catalog:v1",
      "evt_item_1",
      "catalog.item-cat_1",
      "42",
    ]);

    await fixture.handle();

    expect(fixture.appended).toHaveLength(1);
  });

  it("publishes for a Category event only when the resolved set differs from the latest one", async () => {
    const fixture = await createResolutionFixture();
    await fixture.handle();

    fixture.item.category_ids = ["cat_pokemon", "cat_promo"];
    await fixture.handle("catalog.catalog-item.category-assigned");
    expect(fixture.appended).toHaveLength(1);

    fixture.item.category_ids = ["cat_promo"];
    await fixture.handle("catalog.catalog-item.category-removed");
    await fixture.handle("catalog.catalog-item.category-removed");
    expect(publishedProductIds(fixture.appended)).toEqual([["cat_1::form:raw", "cat_1::form:graded"], []]);

    fixture.item.category_ids = ["cat_promo", "cat_pokemon"];
    await fixture.handle("catalog.catalog-item.category-assigned");
    await fixture.handle("catalog.catalog-item.category-assigned");
    expect(publishedProductIds(fixture.appended)).toEqual([
      ["cat_1::form:raw", "cat_1::form:graded"],
      [],
      ["cat_1::form:raw", "cat_1::form:graded"],
    ]);
  });

  it("publishes exactly one empty set for an active item that no profile matches", async () => {
    const fixture = await createResolutionFixture("other-blueprint");

    await fixture.handle();
    await fixture.handle("catalog.catalog-item.category-assigned");
    await fixture.handle("catalog.catalog-item.category-removed");

    expect(publishedProductIds(fixture.appended)).toEqual([[]]);
  });

  it("succeeds without publishing or waiting for an item that is removed, not active or has no Blueprint", async () => {
    const cases: Readonly<Record<string, (fixture: ResolutionFixture) => void>> = {
      draft: (fixture) => {
        fixture.item.status = "draft";
      },
      retired: (fixture) => {
        fixture.item.status = "retired";
      },
      archived: (fixture) => {
        fixture.item.status = "archived";
      },
      removed: (fixture) => {
        fixture.state.removed = true;
      },
      "no Blueprint": (fixture) => {
        fixture.item.blueprint_id = null;
      },
    };

    for (const [name, arrange] of Object.entries(cases)) {
      // No profile and no Blueprint row: either would hold an active item.
      const fixture = await createResolutionFixture("none");
      fixture.state.blueprintStatus = null;
      arrange(fixture);

      for (const type of [
        "catalog.catalog-item.published",
        "catalog.catalog-item.category-assigned",
        "catalog.catalog-item.category-removed",
      ]) {
        await expect(fixture.handle(type), `${name}: ${type}`).resolves.toBeUndefined();
      }
      expect(fixture.appended, name).toHaveLength(0);
    }
  });

  it("waits for catalog-item-projection, the Blueprint row and a profile, then publishes once each clears", async () => {
    const cases: Readonly<
      Record<
        string,
        Readonly<{
          profile?: ResolutionProfile;
          hold: (fixture: ResolutionFixture) => void;
          clear: (fixture: ResolutionFixture) => void | Promise<void>;
          message: string;
        }>
      >
    > = {
      "event not applied by catalog-item-projection": {
        hold: (fixture) => {
          fixture.state.itemProjectionApplied = false;
        },
        clear: (fixture) => {
          fixture.state.itemProjectionApplied = true;
        },
        message: "catalog-item-projection has not applied catalog.catalog-item.published evt_item_1 yet.",
      },
      "Blueprint row absent": {
        hold: (fixture) => {
          fixture.state.blueprintStatus = null;
        },
        clear: (fixture) => {
          fixture.state.blueprintStatus = "active";
        },
        message: "Blueprint bp_card of Catalog Item cat_1 is not projected as published yet.",
      },
      "Blueprint row draft": {
        hold: (fixture) => {
          fixture.state.blueprintStatus = "draft";
        },
        clear: (fixture) => {
          fixture.state.blueprintStatus = "active";
        },
        message: "Blueprint bp_card of Catalog Item cat_1 is not projected as published yet.",
      },
      "profile table empty": {
        profile: "none",
        hold: () => undefined,
        clear: (fixture) => fixture.seedProfile(),
        message: "No Product Measure Profile exists yet to resolve Catalog Item cat_1.",
      },
    };

    for (const [name, testCase] of Object.entries(cases)) {
      const fixture = await createResolutionFixture(testCase.profile);
      testCase.hold(fixture);

      await expectDependencyWait(fixture.handle, testCase.message);
      expect(fixture.appended, name).toHaveLength(0);

      await testCase.clear(fixture);
      await fixture.handle();
      await fixture.handle();

      expect(publishedProductIds(fixture.appended), name).toEqual([["cat_1::form:raw", "cat_1::form:graded"]]);
    }
  });

  it("fails the loser of an append race as transient, and its rerun publishes nothing", async () => {
    const fixture = await createResolutionFixture();
    const append = fixture.state.append;
    let raced = false;
    fixture.state.append = async (input) => {
      if (raced) return append(input);
      raced = true;
      // Another writer's equal publication lands between this handler's read and its append.
      await append(input);
      throw createEventStoreError("concurrency_conflict", "Expected stream version does not match current version.");
    };

    const { passes, failure } = await drainOutcome(fixture.handle);

    expect(isTransientProjectionError(failure)).toBe(true);
    expect(String(failure)).toContain("Product Measure Publication for Catalog Item cat_1 lost an append race.");
    expect((failure as Error).cause).toMatchObject({ code: "concurrency_conflict" });
    expect(passes).toBe(1);
    expect(fixture.appended).toHaveLength(1);

    await fixture.handle();

    expect(fixture.appended).toHaveLength(1);
  });

  it("does not turn any other append failure into a retry", async () => {
    const fixture = await createResolutionFixture();
    fixture.state.append = async () => {
      throw createEventStoreError("payload_too_large", "Event payload exceeds the store limit.");
    };

    const failure: unknown = await fixture.handle().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "payload_too_large" });
    expect(isTransientProjectionError(failure)).toBe(false);
  });
});

it("stages 85 Products without partial visibility, rejects mismatch without mutation, and replaces at completion", async () => {
  const { db, resolved } = createMeasureDb({
    catalog_item_id: "cat_1",
    blueprint_id: null,
    category_ids: [],
    dimension_rules: [],
    canonical_dimension_order: [],
  });
  const staging = withMeasurePublicationStaging(db);
  const services = createProductMeasureRuntime({
    db: staging.db,
    eventStore: createEventStore().eventStore,
    checkpointStore: createCheckpointStore(),
  });
  await assertMeasurePublicationConsumer({
    handlers: services.projectors[0]!.handlers,
    staging,
    visible: () => [...resolved.values()],
    assertProducts: (products) => expect([...resolved.values()].map((row) => row.measure_snapshot)).toEqual(products),
  });
});
