import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, ReadAllInput, ReadStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { createProductContentRuntime } from "./runtime";

type ProductContentTypeRow = Readonly<{
  content_type_id: string;
  key: string;
  display_name: unknown;
  status: string;
  sort_order: number;
  discovery_search_weight: number | null;
  updated_at: string;
}>;

type InclusionPolicyRow = Readonly<{
  inclusion_policy_id: string;
  key: string;
  display_name: unknown;
  status: string;
  sort_order: number;
  updated_at: string;
}>;

type CatalogItemRow = Readonly<{
  catalog_item_id: string;
  status: string;
  blueprint_id: string | null;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type ProductContentRow = Readonly<{
  line_id: string;
  container_catalog_item_id: string;
  container_selected_options: unknown;
  container_product_id: string | null;
  contained_catalog_item_id: string | null;
  contained_selected_options: unknown;
  contained_product_id: string | null;
  quantity: number | null;
  content_type_id: string;
  content_type_display_name: unknown;
  content_type_discovery_search_weight: number | null;
  inclusion_policy_id: string | null;
  inclusion_policy_display_name: unknown;
  provenance: unknown;
  resolution_status: "resolved" | "unresolved";
  target_lifecycle_status: string | null;
  resolved_fact_hash: string;
  resolver_version: number;
  resolved_at: string;
  updated_at: string;
}>;

function parseJson(value: unknown) {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function createContentDb(items: readonly CatalogItemRow[]) {
  const contentTypes: ProductContentTypeRow[] = [];
  const inclusionPolicies: InclusionPolicyRow[] = [];
  const resolved = new Map<string, ProductContentRow>();

  const db = {
    query: vi.fn(async <T>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO catalog_product_content_types")) {
        const row: ProductContentTypeRow = {
          content_type_id: String(params?.[0] ?? ""),
          key: String(params?.[1] ?? ""),
          display_name: parseJson(params?.[2]),
          status: "active",
          sort_order: Number(params?.[3] ?? 100),
          discovery_search_weight: params?.[4] === null || params?.[4] === undefined ? null : Number(params[4]),
          updated_at: "2026-07-01T00:00:00.000Z",
        };
        contentTypes.splice(
          Math.max(
            contentTypes.findIndex((existing) => existing.content_type_id === row.content_type_id),
            contentTypes.length,
          ),
          1,
          row,
        );
        return { rows: [] as T[] };
      }

      if (sql.includes("INSERT INTO catalog_product_content_inclusion_policies")) {
        const row: InclusionPolicyRow = {
          inclusion_policy_id: String(params?.[0] ?? ""),
          key: String(params?.[1] ?? ""),
          display_name: parseJson(params?.[2]),
          status: "active",
          sort_order: Number(params?.[3] ?? 100),
          updated_at: "2026-07-01T00:00:00.000Z",
        };
        inclusionPolicies.splice(
          Math.max(
            inclusionPolicies.findIndex((existing) => existing.inclusion_policy_id === row.inclusion_policy_id),
            inclusionPolicies.length,
          ),
          1,
          row,
        );
        return { rows: [] as T[] };
      }

      if (sql.includes("FROM catalog_items") && sql.includes("catalog_item_id = $1")) {
        return { rows: items.filter((item) => item.catalog_item_id === params?.[0]) as T[] };
      }

      if (sql.includes("FROM catalog_product_content_types")) {
        return {
          rows: [...contentTypes].sort(
            (left, right) => left.sort_order - right.sort_order || left.key.localeCompare(right.key),
          ) as T[],
        };
      }

      if (sql.includes("FROM catalog_product_content_inclusion_policies")) {
        return {
          rows: [...inclusionPolicies].sort(
            (left, right) => left.sort_order - right.sort_order || left.key.localeCompare(right.key),
          ) as T[],
        };
      }

      if (sql.includes("SELECT container_catalog_item_id") && sql.includes("contained_catalog_item_id IS NOT NULL")) {
        return {
          rows: [...resolved.values()].filter((row) => row.contained_catalog_item_id !== null) as T[],
        };
      }

      if (sql.includes("DELETE FROM catalog_resolved_product_contents")) {
        for (const [lineId, row] of [...resolved.entries()]) {
          if (row.container_catalog_item_id === params?.[0] && row.container_product_id === (params?.[1] ?? null)) {
            resolved.delete(lineId);
          }
        }
        return { rows: [] as T[] };
      }

      if (sql.includes("INSERT INTO catalog_resolved_product_contents")) {
        const row: ProductContentRow = {
          line_id: String(params?.[0] ?? ""),
          container_catalog_item_id: String(params?.[1] ?? ""),
          container_selected_options: parseJson(params?.[2]),
          container_product_id: typeof params?.[3] === "string" ? String(params[3]) : null,
          contained_catalog_item_id: typeof params?.[4] === "string" ? String(params[4]) : null,
          contained_selected_options: parseJson(params?.[5]),
          contained_product_id: typeof params?.[6] === "string" ? String(params[6]) : null,
          quantity: typeof params?.[7] === "number" ? Number(params[7]) : null,
          content_type_id: String(params?.[8] ?? ""),
          content_type_display_name: parseJson(params?.[9]),
          content_type_discovery_search_weight:
            params?.[10] === null || params?.[10] === undefined ? null : Number(params[10]),
          inclusion_policy_id: typeof params?.[11] === "string" ? String(params[11]) : null,
          inclusion_policy_display_name: parseJson(params?.[12]),
          provenance: parseJson(params?.[13]),
          resolution_status: params?.[14] === "unresolved" ? "unresolved" : "resolved",
          target_lifecycle_status: typeof params?.[15] === "string" ? String(params[15]) : null,
          resolved_fact_hash: String(params?.[16] ?? ""),
          resolver_version: Number(params?.[17] ?? 1),
          resolved_at: String(params?.[18] ?? ""),
          updated_at: "2026-07-01T00:00:00.000Z",
        };
        resolved.set(row.line_id, row);
        return { rows: [] as T[] };
      }

      if (sql.includes("FROM catalog_resolved_product_contents") && sql.includes("container_catalog_item_id = $1")) {
        return {
          rows: [...resolved.values()]
            .filter((row) => row.container_catalog_item_id === params?.[0])
            .sort((left, right) => left.content_type_id.localeCompare(right.content_type_id)) as T[],
        };
      }

      if (sql.includes("FROM catalog_resolved_product_contents") && sql.includes("contained_catalog_item_id = $1")) {
        return {
          rows: [...resolved.values()]
            .filter((row) => row.contained_catalog_item_id === params?.[0])
            .sort((left, right) => left.content_type_id.localeCompare(right.content_type_id)) as T[],
        };
      }

      return { rows: [] as T[] };
    }),
  } as unknown as PgQueryable;

  return { db, resolved, contentTypes, inclusionPolicies };
}

function storedEvent(streamVersion: number, eventType: string, payload: StoredEvent["payload"] = {}): StoredEvent {
  return {
    eventId: `evt_contents_${streamVersion}` as never,
    streamId: "catalog.product-contents-cat_box",
    streamVersion,
    globalPosition: String(streamVersion) as never,
    tenantId: "tnt_test" as never,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-07-01T00:00:00.000Z" as never,
    recordedAt: "2026-07-01T00:00:00.000Z" as never,
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

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_test" as never },
};

describe("product content runtime", () => {
  it("publishes resolved product contents and projects forward and reverse lookup rows", async () => {
    const { db, resolved } = createContentDb([
      {
        catalog_item_id: "cat_box",
        status: "active",
        blueprint_id: "bp_sealed",
        canonical_dimension_order: ["language"],
        dimension_rules: [
          {
            dimensionId: "language",
            required: true,
            allowedOptions: [{ optionId: "en" }, { optionId: "ja" }],
          },
        ],
      },
      {
        catalog_item_id: "cat_card",
        status: "active",
        blueprint_id: "bp_card",
        canonical_dimension_order: ["finish"],
        dimension_rules: [
          {
            dimensionId: "finish",
            required: true,
            allowedOptions: [{ optionId: "standard" }, { optionId: "foil" }],
          },
        ],
      },
    ]);
    const { eventStore, appended } = createEventStore();
    const services = createProductContentRuntime({ db, eventStore, checkpointStore: createCheckpointStore() });

    await services.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: localizedTextMapFromEnglish("Included item"),
      sortOrder: 10,
      discoverySearchWeight: 0.5,
    });
    await services.upsertInclusionPolicy({
      inclusionPolicyId: "pcp_guaranteed",
      key: "guaranteed",
      displayName: localizedTextMapFromEnglish("Guaranteed"),
      sortOrder: 10,
    });

    const fact = await services.replaceProductContents(
      {
        containerCatalogItemId: "cat_box" as never,
        containerSelectedOptions: [{ dimensionId: "language", optionId: "en" }],
        lines: [
          {
            containedCatalogItemId: "cat_card" as never,
            containedSelectedOptions: [{ dimensionId: "finish", optionId: "foil" }],
            quantity: 1,
            contentTypeId: "pct_included_item",
            inclusionPolicyId: "pcp_guaranteed",
            provenance: { source: "manual" },
          },
        ],
      },
      context,
    );
    expect(fact.lines[0]).toMatchObject({
      contentTypeDisplayName: localizedTextMapFromEnglish("Included item"),
      contentTypeDiscoverySearchWeight: 0.5,
      inclusionPolicyDisplayName: localizedTextMapFromEnglish("Guaranteed"),
    });

    expect(eventStore.appendToStream).toHaveBeenCalledTimes(1);
    expect(appended[0]?.events.map((event) => event.eventType)).toEqual([
      "catalog.product-contents.replaced",
      "catalog.product-contents.resolved",
    ]);
    expect(appended[0]?.events[1]?.payload).toMatchObject({
      containerCatalogItemId: "cat_box",
      containerProductId: "cat_box::language:en",
      lines: [
        {
          containedCatalogItemId: "cat_card",
          containedProductId: "cat_card::finish:foil",
          quantity: 1,
          contentTypeId: "pct_included_item",
          contentTypeDisplayName: localizedTextMapFromEnglish("Included item"),
          contentTypeDiscoverySearchWeight: 0.5,
          inclusionPolicyId: "pcp_guaranteed",
          inclusionPolicyDisplayName: localizedTextMapFromEnglish("Guaranteed"),
          resolutionStatus: "resolved",
        },
      ],
    });

    const handler = services.projectors[0]?.handlers["catalog.product-contents.resolved"];
    await handler?.({
      id: "evt_1",
      type: "catalog.product-contents.resolved",
      data: appended[0]?.events[1]?.payload,
      tenantId: "tnt_test",
      streamId: appended[0]?.streamId,
      streamVersion: 2,
      globalPosition: "1",
      trace: { traceId: null },
      audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
      timing: {
        occurredAt: "2026-07-01T00:00:00.000Z",
        recordedAt: "2026-07-01T00:00:00.000Z",
      },
      metadata: {},
    } as never);

    expect(resolved.size).toBe(1);
    expect((await services.listProductContentsForContainer("cat_box"))[0]).toMatchObject({
      containerProductId: "cat_box::language:en",
      containedProductId: "cat_card::finish:foil",
      provenance: { source: "manual" },
    });
    expect((await services.listProductContainersForContained("cat_card"))[0]).toMatchObject({
      containerCatalogItemId: "cat_box",
      containedCatalogItemId: "cat_card",
    });
  });

  it("replays resolved product contents through an already connected projection client", async () => {
    const { db, resolved } = createContentDb([]);
    const connect = vi.fn(async () => {
      throw new Error("Client has already been connected. You cannot reuse a client.");
    });
    const connectedClientDb = {
      query: db.query,
      connect,
    } as unknown as PgQueryable;
    const { eventStore } = createEventStore();
    const services = createProductContentRuntime({
      db: connectedClientDb,
      eventStore,
      checkpointStore: createCheckpointStore(),
    });
    const handler = services.projectors[0]?.handlers["catalog.product-contents.resolved"];
    expect(handler).toBeDefined();

    await expect(
      handler!({
        id: "evt_projection_client",
        type: "catalog.product-contents.resolved",
        data: {
          containerCatalogItemId: "cat_box",
          containerSelectedOptions: [],
          containerProductId: null,
          lines: [
            {
              lineId: "pcl_1",
              containerCatalogItemId: "cat_box",
              containerSelectedOptions: [],
              containerProductId: null,
              containedCatalogItemId: "cat_card",
              containedSelectedOptions: [],
              containedProductId: null,
              quantity: 1,
              contentTypeId: "pct_included_item",
              contentTypeDisplayName: localizedTextMapFromEnglish("Included item"),
              contentTypeDiscoverySearchWeight: null,
              inclusionPolicyId: null,
              inclusionPolicyDisplayName: null,
              provenance: { source: "manual" },
              resolutionStatus: "resolved",
              targetLifecycleStatus: "active",
            },
          ],
          resolvedFactHash: "resolved-hash",
          resolverVersion: 1,
          resolvedAt: "2026-07-01T00:00:00.000Z",
        },
        tenantId: "tnt_test",
        streamId: "catalog.product-contents-cat_box",
        streamVersion: 1,
        globalPosition: "1",
        trace: { traceId: null },
        audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
        timing: {
          occurredAt: "2026-07-01T00:00:00.000Z",
          recordedAt: "2026-07-01T00:00:00.000Z",
        },
        metadata: {},
      } as never),
    ).resolves.toBeUndefined();

    expect(connect).not.toHaveBeenCalled();
    expect(resolved.size).toBe(1);
  });

  it("repairs the owned read model from Product Contents commands before projection catch-up", async () => {
    const { db } = createContentDb([
      {
        catalog_item_id: "cat_box",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
      {
        catalog_item_id: "cat_card",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
    ]);
    const initialEventStore = createEventStore();
    const initialServices = createProductContentRuntime({
      db,
      eventStore: initialEventStore.eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await initialServices.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: localizedTextMapFromEnglish("Included item"),
      sortOrder: 10,
      discoverySearchWeight: null,
    });

    const input = {
      containerCatalogItemId: "cat_box" as never,
      lines: [
        {
          containedCatalogItemId: "cat_card" as never,
          quantity: 1,
          contentTypeId: "pct_included_item",
          provenance: { source: "manual" },
        },
      ],
    };
    const fact = await initialServices.replaceProductContents(input, context);
    expect(fact.lines).toHaveLength(1);
    expect((await initialServices.listProductContentsForContainer("cat_box"))[0]).toMatchObject({
      containedCatalogItemId: "cat_card",
      quantity: 1,
      contentTypeId: "pct_included_item",
    });
  });

  it("repairs product contents through an already connected pg client without reconnecting it", async () => {
    const { db, resolved } = createContentDb([
      {
        catalog_item_id: "cat_box",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
      {
        catalog_item_id: "cat_card",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
    ]);
    const connect = vi.fn(async () => {
      throw new Error("Client has already been connected. You cannot reuse a client.");
    });
    const connectedClientDb = {
      query: db.query,
      connect,
    } as unknown as PgQueryable;
    const { eventStore } = createEventStore();
    const services = createProductContentRuntime({
      db: connectedClientDb,
      eventStore,
      checkpointStore: createCheckpointStore(),
    });

    await services.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: localizedTextMapFromEnglish("Included item"),
    });
    await expect(
      services.replaceProductContents(
        {
          containerCatalogItemId: "cat_box" as never,
          lines: [{ containedCatalogItemId: "cat_card" as never, quantity: 1, contentTypeId: "pct_included_item" }],
        },
        context,
      ),
    ).resolves.toMatchObject({
      containerCatalogItemId: "cat_box",
      lines: [expect.objectContaining({ containedCatalogItemId: "cat_card" })],
    });

    expect(connect).not.toHaveBeenCalled();
    expect(resolved.size).toBe(1);
  });

  it("issue-6299-acceptance-control does not duplicate retained authoring state beyond the first page", async () => {
    const { db } = createContentDb([
      {
        catalog_item_id: "cat_box",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
      {
        catalog_item_id: "cat_card",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
    ]);
    const input = {
      containerCatalogItemId: "cat_box" as never,
      lines: [
        {
          containedCatalogItemId: "cat_card" as never,
          quantity: 1,
          contentTypeId: "pct_included_item",
        },
      ],
    };
    const firstStore = createEventStore();
    const firstServices = createProductContentRuntime({
      db,
      eventStore: firstStore.eventStore,
      checkpointStore: createCheckpointStore(),
    });
    await firstServices.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: localizedTextMapFromEnglish("Included item"),
    });
    await firstServices.replaceProductContents(input, context);
    const retainedPayload = firstStore.appended[0]?.events[1]?.payload;
    expect(retainedPayload).toBeDefined();
    if (!retainedPayload) {
      throw new Error("Expected the initial Product Contents resolve event.");
    }

    const history = [
      ...Array.from({ length: 500 }, (_, index) =>
        storedEvent(index + 1, "catalog.product-contents.authoring-control"),
      ),
      storedEvent(501, "catalog.product-contents.resolved", retainedPayload),
    ];
    const replayStore = createEventStore(history);
    const replayServices = createProductContentRuntime({
      db,
      eventStore: replayStore.eventStore,
      checkpointStore: createCheckpointStore(),
    });

    const replayed = await replayServices.replaceProductContents(input, context);

    expect(replayStore.reads.map((read) => read.fromVersion)).toEqual([1, 501]);
    expect(replayStore.appended).toEqual([]);
    expect(replayed).toEqual(retainedPayload);
  });

  it("rejects duplicate, self-referential, and cyclic resolved lines", async () => {
    const { db, resolved } = createContentDb([
      {
        catalog_item_id: "cat_a",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
      {
        catalog_item_id: "cat_b",
        status: "active",
        blueprint_id: "bp_plain",
        canonical_dimension_order: [],
        dimension_rules: [],
      },
    ]);
    const { eventStore } = createEventStore();
    const services = createProductContentRuntime({ db, eventStore, checkpointStore: createCheckpointStore() });
    await services.upsertContentType({
      contentTypeId: "pct_included_item",
      key: "included-item",
      displayName: localizedTextMapFromEnglish("Included item"),
    });

    await expect(
      services.replaceProductContents(
        {
          containerCatalogItemId: "cat_a" as never,
          lines: [{ containedCatalogItemId: "cat_a" as never, quantity: 1, contentTypeId: "pct_included_item" }],
        },
        context,
      ),
    ).rejects.toThrow("Product Content Line cannot contain itself.");

    resolved.set("existing", {
      line_id: "existing",
      container_catalog_item_id: "cat_b",
      container_selected_options: null,
      container_product_id: null,
      contained_catalog_item_id: "cat_a",
      contained_selected_options: null,
      contained_product_id: null,
      quantity: 1,
      content_type_id: "pct_included_item",
      content_type_display_name: localizedTextMapFromEnglish("Included item"),
      content_type_discovery_search_weight: null,
      inclusion_policy_id: null,
      inclusion_policy_display_name: null,
      provenance: {},
      resolution_status: "resolved",
      target_lifecycle_status: "active",
      resolved_fact_hash: "hash",
      resolver_version: 1,
      resolved_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });

    await expect(
      services.replaceProductContents(
        {
          containerCatalogItemId: "cat_a" as never,
          lines: [{ containedCatalogItemId: "cat_b" as never, quantity: 1, contentTypeId: "pct_included_item" }],
        },
        context,
      ),
    ).rejects.toThrow("Product Contents cannot create cycles.");
  });
});
