import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import {
  ZERO_GLOBAL_POSITION,
  type AppendToStreamInput,
  type ReadAllInput,
  type ReadStreamInput,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { resolveCatalogItemDisplayIdentity } from "../read-model/display-identity";
import { createCatalogItemRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_test" as never },
};

const title = localizedTextMapFromEnglish("Charizard");
const rawItem = {
  catalog_item_id: "cat_1",
  language_code: "en",
  title_i18n: title,
  title: "Charizard",
  projected_title: "Charizard",
  subtitle_i18n: null,
  subtitle: null,
  projected_subtitle: null,
  blueprint_id: "bpr_card",
  field_values: [],
  category_ids: [],
};

describe("Catalog Item publication runtime", () => {
  it("derives current evidence and binds an omitted or any version to the validated stream version", async () => {
    const harness = await createHarness("current");

    const result = await harness.services.commandHandler({
      streamId: "catalog.item-cat_1",
      command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
      context,
      expectedVersion: "any",
    });

    expect(result.state.status).toBe("active");
    expect(harness.appends).toHaveLength(1);
    expect(harness.appends[0]?.expectedVersion).toBe(2);
    expect(harness.appends[0]?.events.map((event) => event.eventType)).toEqual(["catalog.catalog-item.published"]);
  });

  it("preserves a caller's conflicting numeric and no_stream versions", async () => {
    for (const expectedVersion of [1, "no_stream"] as const) {
      const harness = await createHarness("current", true);
      await expect(
        harness.services.commandHandler({
          streamId: "catalog.item-cat_1",
          command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
          context,
          expectedVersion,
        }),
      ).rejects.toThrow("expected version conflict");
      expect(harness.appends[0]?.expectedVersion).toBe(expectedVersion);
    }
  });

  it("performs one guarded update-only refresh, re-reads, and then publishes", async () => {
    const harness = await createHarness("outdated");

    const result = await harness.services.commandHandler({
      streamId: "catalog.item-cat_1",
      command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
      context,
    });

    expect(result.state.status).toBe("active");
    expect(harness.guardedUpdates).toBe(1);
    expect(
      harness.sql.some((statement) => statement.includes("UPDATE catalog_item_display_identities AS identity")),
    ).toBe(true);
    expect(harness.sql.some((statement) => statement.includes("RETURNING identity.catalog_item_id"))).toBe(true);
  });

  it("fails closed for a missing fact and a lagged raw tuple without appending", async () => {
    const missing = await createHarness("missing");
    await expect(
      missing.services.commandHandler({
        streamId: "catalog.item-cat_1",
        command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
        context,
      }),
    ).rejects.toMatchObject({ code: "display-identity-unavailable" });
    expect(missing.appends).toHaveLength(0);

    const lagged = await createHarness("current", false, { ...rawItem, title: "Older title" });
    await expect(
      lagged.services.commandHandler({
        streamId: "catalog.item-cat_1",
        command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
        context,
      }),
    ).rejects.toMatchObject({ code: "display-identity-outdated" });
    expect(lagged.guardedUpdates).toBe(0);
    expect(lagged.appends).toHaveLength(0);
  });

  it("lets an all-outdated bulk candidate reach the same adapter and reports the real append", async () => {
    const harness = await createHarness("outdated");
    const preview = await harness.services.previewBulkPublish({ mode: "ids", ids: ["cat_1"] });
    expect(preview).toMatchObject({ ready_count: 0, blocked_count: 1 });
    expect(preview.candidates[0]).toMatchObject({
      reason_code: "display-identity-outdated",
      retryable: true,
      missing_tokens: [],
    });

    const result = await harness.services.publishBulk(["cat_1"], context);
    expect(result).toMatchObject({ published_count: 1, failed_count: 0, skipped_count: 0 });
    expect(result.candidates[0]).toMatchObject({
      outcome: "published",
      display_identity_readiness: "current-resolved",
    });
  });
});

async function createHarness(
  factState: "current" | "outdated" | "missing",
  rejectConflictingAppend = false,
  item = rawItem,
) {
  const appends: AppendToStreamInput[] = [];
  const stored = aggregateHistory();
  const eventStore: EventStore = {
    readStream: async (input: ReadStreamInput) => {
      const from = (input.fromVersion ?? 1) - 1;
      return stored.slice(from, from + (input.limit ?? 500));
    },
    readAll: async (_input?: ReadAllInput) => [],
    appendToStream: vi.fn(async (input: AppendToStreamInput) => {
      appends.push(input);
      if (rejectConflictingAppend && input.expectedVersion !== 2) {
        throw new Error("expected version conflict");
      }
      return input.events.map((event, index) => storedEvent(3 + index, event.eventType, event.payload));
    }),
  };
  let fact: Record<string, unknown> | null = null;
  let guardedUpdates = 0;
  const sql: string[] = [];
  const db: PgQueryable = {
    query: async <T>(statement: string, params?: readonly unknown[]) => {
      sql.push(statement);
      if (statement.includes("FROM catalog_display_templates")) {
        return {
          rows: [
            {
              key: "global-item-title",
              target_kind: "global",
              target_id: null,
              priority: 0,
              title_template: "{item.title}",
              subtitle_template: null,
              required_field_keys: [],
            },
          ] as T[],
        };
      }
      if (
        statement.includes("catalog_alias") ||
        statement.includes("catalog_reference_records") ||
        statement.includes("FROM catalog_fields")
      ) {
        return { rows: [] as T[] };
      }
      if (statement.includes("UPDATE catalog_item_display_identities AS identity")) {
        guardedUpdates += 1;
        fact = factFromGuardParams(params);
        return { rows: [{ catalog_item_id: "cat_1" }] as T[] };
      }
      if (statement.includes("LEFT JOIN catalog_item_display_identities AS identity")) {
        return { rows: [publicationRow(item, fact)] as T[] };
      }
      if (statement.includes("FROM catalog_items AS item") && statement.includes("blueprint.field_rules")) {
        return {
          rows: [
            {
              ...item,
              blueprint_name: "Pokemon Card",
              blueprint_status: "active",
              blueprint_field_rules: [],
              status: "draft",
              source_providers: [],
              updated_at: "2026-09-05T00:00:00.000Z",
            },
          ] as T[],
        };
      }
      return { rows: [] as T[] };
    },
  };

  const identity = await resolveCatalogItemDisplayIdentity(db, item);
  if (factState !== "missing") {
    fact = {
      catalog_item_id: identity.catalogItemId,
      language_code: identity.languageCode,
      title: identity.title,
      subtitle: identity.subtitle,
      display_template_key: identity.templateKey,
      display_template_target_kind: identity.templateTargetKind,
      display_template_target_id: identity.templateTargetId,
      display_identity_hash: factState === "current" ? identity.hash : "older-hash",
      resolver_version: 3,
      resolved_at: "2026-09-05T00:00:00.000Z",
      resolution_status: "resolved",
      missing_tokens: [],
    };
  }

  const checkpointStore: ProjectionCheckpointStore = {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => undefined,
  };
  const services = createCatalogItemRuntime({ eventStore, checkpointStore, db });
  return {
    services,
    appends,
    sql,
    get guardedUpdates() {
      return guardedUpdates;
    },
  };
}

function publicationRow(item: typeof rawItem, fact: Record<string, unknown> | null) {
  return {
    ...item,
    identity_catalog_item_id: fact?.catalog_item_id ?? null,
    identity_language_code: fact?.language_code ?? null,
    identity_title: fact?.title ?? null,
    identity_subtitle: fact?.subtitle ?? null,
    display_template_key: fact?.display_template_key ?? null,
    display_template_target_kind: fact?.display_template_target_kind ?? null,
    display_template_target_id: fact?.display_template_target_id ?? null,
    display_identity_hash: fact?.display_identity_hash ?? null,
    resolver_version: fact?.resolver_version ?? null,
    resolved_at: fact?.resolved_at ?? null,
    resolution_status: fact?.resolution_status ?? null,
    missing_tokens: fact?.missing_tokens ?? null,
  };
}

function factFromGuardParams(params?: readonly unknown[]) {
  return {
    catalog_item_id: params?.[10],
    language_code: params?.[11],
    title: params?.[0],
    subtitle: params?.[1],
    display_template_key: params?.[2],
    display_template_target_kind: params?.[3],
    display_template_target_id: params?.[4],
    display_identity_hash: params?.[5],
    resolver_version: params?.[6],
    resolved_at: params?.[7],
    resolution_status: params?.[8],
    missing_tokens: JSON.parse(String(params?.[9] ?? "[]")),
  };
}

function aggregateHistory(): StoredEvent[] {
  return [
    storedEvent(1, "catalog.catalog-item.created", {
      itemId: "cat_1",
      languageCode: "en",
      title,
      subtitle: null,
      description: localizedTextMapFromEnglish(""),
    }),
    storedEvent(2, "catalog.catalog-item.blueprint-assigned", { blueprintId: "bpr_card" }),
  ];
}

function storedEvent(streamVersion: number, eventType: string, payload: StoredEvent["payload"]): StoredEvent {
  return {
    eventId: `evt_${streamVersion}` as never,
    streamId: "catalog.item-cat_1",
    streamVersion,
    globalPosition: String(streamVersion) as never,
    tenantId: "tnt_test" as never,
    eventType,
    payload,
    metadata: {},
    occurredAt: "2026-09-05T00:00:00.000Z" as never,
    recordedAt: "2026-09-05T00:00:00.000Z" as never,
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  };
}
