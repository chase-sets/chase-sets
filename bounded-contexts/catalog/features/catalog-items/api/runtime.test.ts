import { Hono } from "hono";
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
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import type { ItemFieldValue } from "../domain/domain";
import { resolveCatalogItemDisplayIdentity } from "../read-model/display-identity";
import { catalogItemRoutes } from "./route";
import { createCatalogItemRuntime, type CatalogItemServices } from "./runtime";

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
  blueprint_id: "bpr_card" as string | null,
  field_values: [] as unknown,
  category_ids: [],
};

const nameValue = { fieldId: "fld_name" as never, value: "Charizard" } as ItemFieldValue;
const legacyFields = { blueprintIsActive: true, requiredFieldIds: [] };
const outdatedRefusal = {
  code: "display-identity-outdated",
  message: "Display identity is outdated. Recheck and retry publication.",
  readiness: "outdated",
  missingTokens: [],
};

function preconditionRefusal(message: string, missingFieldIds: readonly string[] = []) {
  return { code: "publication-precondition", reason_code: "publication-precondition", message, missingFieldIds };
}

describe("Catalog Item publication runtime", () => {
  it("derives current evidence and binds an omitted or any version to the validated stream version", async () => {
    const harness = await createHarness("current");

    const result = await harness.services.commandHandler({
      streamId: "catalog.item-cat_1",
      command: { type: "PublishCatalogItem" },
      context,
      expectedVersion: "any",
    });

    expect(result.state.status).toBe("active");
    expect(harness.appends).toHaveLength(1);
    expect(harness.appends[0]?.expectedVersion).toBe(2);
    expect(harness.appends[0]?.events.map((event) => event.eventType)).toEqual(["catalog.catalog-item.published"]);
  });

  it("refuses a non-active blueprint from Catalog records despite conflicting legacy command values", async () => {
    const harness = await createHarness("current", false, rawItem, { blueprintStatus: "deprecated" });

    await expect(
      harness.services.commandHandler({
        streamId: "catalog.item-cat_1",
        command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
        context,
      }),
    ).rejects.toMatchObject({
      code: "publication-precondition",
      message: "Catalog Item blueprint must be active before publish.",
      missingFieldIds: [],
    });
    expect(harness.appends).toHaveLength(0);
  });

  it("refuses every missing required field from Catalog records before append", async () => {
    const harness = await createHarness("current", false, rawItem, {
      blueprintFieldRules: [
        { fieldId: "fld_name", required: true },
        { fieldId: "fld_set", required: true },
      ],
    });

    await expect(
      harness.services.commandHandler({
        streamId: "catalog.item-cat_1",
        command: { type: "PublishCatalogItem", blueprintIsActive: true, requiredFieldIds: [] },
        context,
      }),
    ).rejects.toMatchObject({
      code: "publication-precondition",
      message: "Missing required field values: fld_name, fld_set.",
      missingFieldIds: ["fld_name", "fld_set"],
    });
    expect(harness.appends).toHaveLength(0);
  });

  it("uses aggregate field values when the bulk projection is ahead", async () => {
    const harness = await createHarness("current", false, rawItem, {
      blueprintFieldRules: [{ fieldId: "fld_name", required: true }],
      projectedFieldValues: [{ fieldId: "fld_name", value: "Charizard" }],
    });

    await expect(
      harness.services.commandHandler({
        streamId: "catalog.item-cat_1",
        command: { type: "PublishCatalogItem" },
        context,
      }),
    ).rejects.toMatchObject({
      code: "publication-precondition",
      message: "Missing required field values: fld_name.",
      missingFieldIds: ["fld_name"],
    });
    expect(harness.appends).toHaveLength(0);
  });

  it("uses aggregate field values when the bulk projection is behind", async () => {
    const harness = await createHarness("current", false, rawItem, {
      blueprintFieldRules: [{ fieldId: "fld_name", required: true }],
      aggregateFieldValues: [nameValue],
    });

    await expect(
      harness.services.commandHandler({
        streamId: "catalog.item-cat_1",
        command: { type: "PublishCatalogItem" },
        context,
      }),
    ).rejects.toMatchObject({ code: "display-identity-outdated" });
    expect(harness.appends).toHaveLength(0);
  });

  it("preserves a caller's conflicting numeric and no_stream versions", async () => {
    for (const expectedVersion of [1, "no_stream"] as const) {
      const harness = await createHarness("current", true);
      await expect(
        harness.services.commandHandler({
          streamId: "catalog.item-cat_1",
          command: { type: "PublishCatalogItem" },
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
      command: { type: "PublishCatalogItem" },
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
        command: { type: "PublishCatalogItem" },
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

describe("Catalog Item publication precondition seam", () => {
  const previousBlueprint = { status: "active", fieldRules: [] };
  const requiresSet = [{ fieldId: "fld_set", required: true }];
  const seamCases: readonly PublishSeamCase[] = [
    { name: "publishes the aligned control", publication: {}, status: 200, appends: 1 },
    {
      name: "refuses a deprecated aggregate blueprint despite forged legacy request fields",
      body: legacyFields,
      publication: { blueprintStatus: "deprecated" },
      status: 409,
      error: preconditionRefusal("Catalog Item blueprint must be active before publish."),
      appends: 0,
    },
    {
      name: "refuses every missing required field despite forged legacy request fields",
      body: legacyFields,
      publication: {
        blueprintFieldRules: [
          { fieldId: "fld_name", required: true },
          { fieldId: "fld_set", required: true },
        ],
      },
      status: 409,
      error: preconditionRefusal("Missing required field values: fld_name, fld_set.", ["fld_name", "fld_set"]),
      appends: 0,
    },
    {
      name: "publishes when every required field is present",
      publication: {
        blueprintFieldRules: [{ fieldId: "fld_name", required: true }],
        aggregateFieldValues: [nameValue],
        projectedFieldValues: [nameValue],
      },
      status: 200,
      appends: 1,
    },
    {
      name: "ignores forged legacy request fields that would block an eligible draft",
      body: { blueprintIsActive: false, requiredFieldIds: ["fld_name"] },
      publication: {},
      status: 200,
      appends: 1,
    },
    {
      name: "refuses from aggregate field values when projection field values are ahead",
      publication: {
        blueprintFieldRules: [{ fieldId: "fld_name", required: true }],
        projectedFieldValues: [nameValue],
      },
      status: 409,
      error: preconditionRefusal("Missing required field values: fld_name.", ["fld_name"]),
      appends: 0,
    },
    {
      name: "fails closed as outdated when projection field values are behind",
      publication: {
        blueprintFieldRules: [{ fieldId: "fld_name", required: true }],
        aggregateFieldValues: [nameValue],
      },
      status: 409,
      error: outdatedRefusal,
      appends: 0,
    },
    {
      name: "refuses a deprecated aggregate blueprint when the projection blueprint ID is behind and catches up mid-command",
      publication: {
        blueprintStatus: "deprecated",
        otherBlueprints: { bpr_old: previousBlueprint },
        aggregateBlueprintIds: ["bpr_old", "bpr_card"],
        projectedBlueprintIds: ["bpr_old", "bpr_card"],
      },
      status: 409,
      error: preconditionRefusal("Catalog Item blueprint must be active before publish."),
      appends: 0,
    },
    {
      name: "refuses the aggregate blueprint's missing field when the projection blueprint ID is behind and catches up mid-command",
      publication: {
        blueprintFieldRules: requiresSet,
        otherBlueprints: { bpr_old: previousBlueprint },
        aggregateBlueprintIds: ["bpr_old", "bpr_card"],
        projectedBlueprintIds: ["bpr_old", "bpr_card"],
      },
      status: 409,
      error: preconditionRefusal("Missing required field values: fld_set.", ["fld_set"]),
      appends: 0,
    },
    {
      name: "fails closed as outdated while the projection blueprint ID is behind on a deprecated previous blueprint",
      publication: {
        otherBlueprints: { bpr_old: { status: "deprecated", fieldRules: [] } },
        aggregateBlueprintIds: ["bpr_old", "bpr_card"],
        projectedBlueprintIds: ["bpr_old"],
      },
      status: 409,
      error: outdatedRefusal,
      appends: 0,
    },
    {
      name: "fails closed as outdated when the projection blueprint ID is ahead on a deprecated blueprint",
      publication: {
        otherBlueprints: { bpr_next: { status: "deprecated", fieldRules: [] } },
        projectedBlueprintIds: ["bpr_next"],
      },
      status: 409,
      error: outdatedRefusal,
      appends: 0,
    },
    {
      name: "fails closed as outdated when the projection blueprint ID is ahead on a blueprint requiring a missing field",
      publication: {
        otherBlueprints: { bpr_next: { status: "active", fieldRules: requiresSet } },
        projectedBlueprintIds: ["bpr_next"],
      },
      status: 409,
      error: outdatedRefusal,
      appends: 0,
    },
    {
      name: "refuses an aggregate without a blueprint",
      publication: { aggregateBlueprintIds: [] },
      status: 409,
      error: preconditionRefusal("Catalog Item requires a blueprint before publish."),
      appends: 0,
    },
    {
      name: "refuses an aggregate blueprint that has no Catalog blueprint record",
      publication: { aggregateBlueprintIds: ["bpr_gone"] },
      status: 409,
      error: preconditionRefusal("Catalog Item blueprint must be active before publish."),
      appends: 0,
    },
  ];

  for (const seamCase of seamCases) {
    it(seamCase.name, async () => {
      const harness = await createHarness("current", false, rawItem, seamCase.publication);

      const response = await publishOverHttp(harness.services, seamCase.body ?? {});

      expect(response.status).toBe(seamCase.status);
      await expect(response.json()).resolves.toEqual(
        seamCase.error ? { error: seamCase.error } : expect.objectContaining({ id: "cat_1", status: "active" }),
      );
      expect(harness.appends).toHaveLength(seamCase.appends);
    });
  }
});

type PublishSeamCase = Readonly<{
  name: string;
  body?: Readonly<Record<string, unknown>>;
  publication: HarnessPublication;
  status: 200 | 409;
  error?: Readonly<Record<string, unknown>>;
  appends: 0 | 1;
}>;

type HarnessBlueprint = Readonly<{ status: string; fieldRules: unknown }>;

type HarnessPublication = Readonly<{
  blueprintStatus?: string;
  blueprintFieldRules?: unknown;
  otherBlueprints?: Readonly<Record<string, HarnessBlueprint>>;
  aggregateBlueprintIds?: readonly string[];
  /** The item projection's blueprint per catalog_items read; the last one holds once the projector catches up. */
  projectedBlueprintIds?: readonly (string | null)[];
  projectedFieldValues?: unknown;
  aggregateFieldValues?: readonly ItemFieldValue[];
}>;

const unusedBulkJobs = {} as CatalogAuthoringBulkJobServices;

async function publishOverHttp(services: CatalogItemServices, body: Readonly<Record<string, unknown>>) {
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("*", async (c, next) => {
    c.set("context", context);
    await next();
  });
  app.route("/items", catalogItemRoutes(services, unusedBulkJobs));
  return app.fetch(
    new Request("http://catalog.test/items/cat_1/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function createHarness(
  factState: "current" | "outdated" | "missing",
  rejectConflictingAppend = false,
  item = rawItem,
  publication: HarnessPublication = {},
) {
  const publicationOptions = {
    blueprintStatus: "active",
    blueprintFieldRules: [],
    aggregateBlueprintIds: ["bpr_card"],
    ...publication,
  };
  const blueprints: Readonly<Record<string, HarnessBlueprint>> = {
    bpr_card: { status: publicationOptions.blueprintStatus, fieldRules: publicationOptions.blueprintFieldRules },
    ...publicationOptions.otherBlueprints,
  };
  const projectedBlueprintIds = publicationOptions.projectedBlueprintIds ?? [
    publicationOptions.aggregateBlueprintIds.at(-1) ?? null,
  ];
  const projectedItem = (read: number) => ({
    ...item,
    blueprint_id: projectedBlueprintIds[Math.min(read, projectedBlueprintIds.length - 1)] ?? null,
    field_values: publicationOptions.projectedFieldValues ?? item.field_values,
  });
  let projectionReads = 0;
  const appends: AppendToStreamInput[] = [];
  const stored = aggregateHistory(publicationOptions.aggregateBlueprintIds, publicationOptions.aggregateFieldValues);
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
      return input.events.map((event, index) => storedEvent(stored.length + 1 + index, event.eventType, event.payload));
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
        return { rows: [publicationRow(projectedItem(projectionReads++), fact)] as T[] };
      }
      if (statement.includes("FROM catalog_items AS item") && statement.includes("blueprint.field_rules")) {
        const projected = projectedItem(projectionReads++);
        const blueprint = projected.blueprint_id ? blueprints[projected.blueprint_id] : undefined;
        return {
          rows: [
            {
              ...projected,
              blueprint_name: blueprint ? "Pokemon Card" : null,
              blueprint_status: blueprint?.status ?? null,
              blueprint_field_rules: blueprint?.fieldRules ?? null,
              status: "draft",
              source_providers: [],
              updated_at: "2026-09-05T00:00:00.000Z",
            },
          ] as T[],
        };
      }
      if (statement.includes("FROM catalog_blueprints AS blueprint")) {
        const blueprint = blueprints[String(params?.[0])];
        return {
          rows: (blueprint
            ? [{ blueprint_status: blueprint.status, blueprint_field_rules: blueprint.fieldRules }]
            : []) as T[],
        };
      }
      return { rows: [] as T[] };
    },
  };

  const identity = await resolveCatalogItemDisplayIdentity(db, projectedItem(projectedBlueprintIds.length - 1));
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

function publicationRow(item: Readonly<Record<string, unknown>>, fact: Record<string, unknown> | null) {
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

function aggregateHistory(blueprintIds: readonly string[], fieldValues: readonly ItemFieldValue[] = []): StoredEvent[] {
  return [
    storedEvent(1, "catalog.catalog-item.created", {
      itemId: "cat_1",
      languageCode: "en",
      title,
      subtitle: null,
      description: localizedTextMapFromEnglish(""),
    }),
    ...blueprintIds.map((blueprintId, index) =>
      storedEvent(2 + index, "catalog.catalog-item.blueprint-assigned", { blueprintId }),
    ),
    ...fieldValues.map((fieldValue, index) =>
      storedEvent(2 + blueprintIds.length + index, "catalog.catalog-item.field-value-set", fieldValue),
    ),
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
