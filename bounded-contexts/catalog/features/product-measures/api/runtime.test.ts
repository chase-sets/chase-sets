import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
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

function createEventStore(existingEvents: readonly StoredEvent[] = []) {
  const appended: AppendToStreamInput[] = [];
  const reads: ReadStreamInput[] = [];
  const eventStore: EventStore = {
    appendToStream: vi.fn(async (input: AppendToStreamInput) => {
      appended.push(input);
      return [];
    }),
    readStream: async (input: ReadStreamInput): Promise<StoredEvent[]> => {
      reads.push(input);
      const fromIndex = (input.fromVersion ?? 1) - 1;
      return existingEvents.slice(fromIndex, fromIndex + (input.limit ?? 500));
    },
    readAll: async (_input?: ReadAllInput): Promise<StoredEvent[]> => [],
  };
  return { eventStore, appended, reads };
}

function createCheckpointStore(): ProjectionCheckpointStore {
  return {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
}

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
      physicalFlags: ["raw-card"],
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
      physicalFlags: ["slab", "rigid"],
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
      physicalFlags: ["raw-card"],
      unitWeightOunces: 0.064,
    });
    expect(resolved.get("cat_1::form:graded-psa")?.measure_snapshot).toMatchObject({
      productId: "cat_1::form:graded-psa",
      physicalFlags: ["slab", "rigid"],
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
      physicalFlags: ["raw-card"],
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
  });
});
