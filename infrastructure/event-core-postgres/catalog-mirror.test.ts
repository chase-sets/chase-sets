import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import {
  asArray,
  asStringArray,
  buildCatalogMirrorProjectionHandlers,
  buildVersionSchema,
  catalogMirrorTables,
  coerceDimensionOptionLabel,
  type CatalogMirrorSpec,
} from "./catalog-mirror";
import { createCatalogMirrorReplayDb } from "./catalog-mirror-replay";

function event(type: string, data: Record<string, unknown>, streamId = "catalog.item-cat_1"): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: streamId as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_1" as never,
    data: data as never,
    metadata: {},
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-09T00:00:00.000Z" as never,
      recordedAt: "2026-05-09T00:00:00.000Z" as never,
    },
  };
}

const CORE_EVENT_TYPES = [
  "catalog.catalog-item.created",
  "catalog.catalog-item.blueprint-assigned",
  "catalog.catalog-item.published",
  "catalog.catalog-item.retired",
  "catalog.catalog-item.archived",
  "catalog.blueprint.created",
  "catalog.blueprint.revised",
  "catalog.blueprint.dimensions-set",
  "catalog.blueprint.product-resolution-rules-set",
  "catalog.blueprint.published",
  "catalog.dimension.created",
  "catalog.dimension.revised",
  "catalog.dimension.option-added",
  "catalog.dimension.option-revised",
];

describe("catalog mirror primitives", () => {
  it.each([
    { value: [1, 2], expected: [1, 2] },
    { value: "nope", expected: [] },
    { value: null, expected: [] },
  ])("coerces $value to an array", ({ value, expected }) => {
    expect(asArray(value)).toEqual(expected);
  });

  it("filters non-string entries from string arrays", () => {
    expect(asStringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
  });

  it.each([
    {
      name: "locale entry arrays",
      value: [
        { locale: "en", value: "Near Mint" },
        { locale: "ja", value: "ほぼ新品" },
        "junk",
        { locale: 7, value: "skipped" },
      ],
      expected: { defaultLocale: "en", values: { en: "Near Mint", ja: "ほぼ新品" } },
    },
    {
      name: "localized text maps",
      value: { defaultLocale: "en", values: { en: "Near Mint" } },
      expected: { defaultLocale: "en", values: { en: "Near Mint" } },
    },
    {
      name: "plain strings",
      value: "Near Mint",
      expected: { defaultLocale: "en", values: { en: "Near Mint" } },
    },
  ])("coerces dimension option labels from $name", ({ value, expected }) => {
    expect(coerceDimensionOptionLabel(value)).toEqual(expected);
  });

  it("derives the four mirror table names from the prefix", () => {
    expect(catalogMirrorTables("checkout_catalog")).toEqual({
      items: "checkout_catalog_items",
      blueprints: "checkout_catalog_blueprints",
      dimensions: "checkout_catalog_dimensions",
      dimensionOptions: "checkout_catalog_dimension_options",
    });
  });

  it("rejects table prefixes that are not SQL identifiers", () => {
    expect(() => catalogMirrorTables("checkout; DROP TABLE")).toThrowError(/Invalid SQL identifier/);
  });
});

describe("buildCatalogMirrorProjectionHandlers", () => {
  it.each([
    {
      name: "core spec",
      spec: { tablePrefix: "checkout_catalog" } satisfies CatalogMirrorSpec,
      expected: [...CORE_EVENT_TYPES],
    },
    {
      name: "metadata-revised opt-in",
      spec: {
        tablePrefix: "checkout_catalog",
        optionalHandlers: { metadataRevised: true },
      } satisfies CatalogMirrorSpec,
      expected: [...CORE_EVENT_TYPES, "catalog.catalog-item.metadata-revised"],
    },
    {
      name: "display-identity-resolved opt-in",
      spec: {
        tablePrefix: "inventory_catalog",
        optionalHandlers: { displayIdentityResolved: true },
      } satisfies CatalogMirrorSpec,
      expected: [...CORE_EVENT_TYPES, "catalog.catalog-item.display-identity-resolved"],
    },
  ])("emits exactly the declared handler map for the $name", ({ spec, expected }) => {
    const replayDb = createCatalogMirrorReplayDb(spec.tablePrefix);
    const handlers = buildCatalogMirrorProjectionHandlers(replayDb.db, spec);

    expect(Object.keys(handlers).sort()).toEqual([...expected].sort());
  });

  it("rejects status transitions that are not safe SQL literals", () => {
    const replayDb = createCatalogMirrorReplayDb("checkout_catalog");

    expect(() =>
      buildCatalogMirrorProjectionHandlers(replayDb.db, {
        tablePrefix: "checkout_catalog",
        itemStatusTransitions: { retired: "x'; DROP TABLE" },
      }),
    ).toThrowError(/Invalid catalog mirror status/);
  });

  it.each([
    { transition: "published", eventType: "catalog.catalog-item.published", status: "live" },
    { transition: "retired", eventType: "catalog.catalog-item.retired", status: "retired" },
    { transition: "archived", eventType: "catalog.catalog-item.archived", status: "gone" },
  ])("writes the declared $transition status transition", async ({ transition, eventType, status }) => {
    const replayDb = createCatalogMirrorReplayDb("marketplace_catalog");
    const handlers = buildCatalogMirrorProjectionHandlers(replayDb.db, {
      tablePrefix: "marketplace_catalog",
      itemStatusTransitions: { [transition]: status },
    });

    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", { itemId: "cat_1", title: "Item", subtitle: null }),
    );
    await handlers[eventType]!(event(eventType, {}));

    expect(replayDb.snapshotState().items.cat_1).toMatchObject({ status });
    const statusEffect = replayDb.effects.find((effect) => effect.sql.includes("SET status = $2"));
    expect(statusEffect).toMatchObject({ params: ["cat_1", status, expect.any(String)] });
    expect(statusEffect?.sql).not.toContain(`'${status}'`);
  });

  it("projects created items with resolved localized display text", async () => {
    const replayDb = createCatalogMirrorReplayDb("checkout_catalog");
    const handlers = buildCatalogMirrorProjectionHandlers(replayDb.db, { tablePrefix: "checkout_catalog" });

    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", {
        itemId: "cat_1",
        languageCode: "ja",
        title: { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } },
        subtitle: { defaultLocale: "en", values: { en: "Japanese Base Set", ja: "拡張パック" } },
      }),
    );

    expect(replayDb.snapshotState().items.cat_1).toMatchObject({
      catalog_item_id: "cat_1",
      language_code: "ja",
      title: "Charizard",
      subtitle: "Japanese Base Set",
      status: "draft",
    });
  });

  it("refreshes the product schema on publish only when the spec opts in", async () => {
    for (const refreshProductSchemaOnItemPublished of [false, true]) {
      const replayDb = createCatalogMirrorReplayDb("inventory_catalog");
      const handlers = buildCatalogMirrorProjectionHandlers(replayDb.db, {
        tablePrefix: "inventory_catalog",
        refreshProductSchemaOnItemPublished,
      });

      await handlers["catalog.catalog-item.created"]!(
        event("catalog.catalog-item.created", { itemId: "cat_1", title: "Item", subtitle: null }),
      );
      const effectCountBefore = replayDb.effects.length;
      await handlers["catalog.catalog-item.published"]!(event("catalog.catalog-item.published", {}));

      const publishEffects = replayDb.effects.slice(effectCountBefore).map((effect) => effect.sql);
      expect(publishEffects.some((sql) => sql.includes("SET product_schema"))).toBe(
        refreshProductSchemaOnItemPublished,
      );
    }
  });

  it("seeds blueprint draft status on upsert only when the spec opts in", async () => {
    const withStatus = createCatalogMirrorReplayDb("checkout_catalog");
    const withStatusHandlers = buildCatalogMirrorProjectionHandlers(withStatus.db, {
      tablePrefix: "checkout_catalog",
    });
    await withStatusHandlers["catalog.blueprint.created"]!(
      event("catalog.blueprint.created", { blueprintId: "bp_1", name: "Blueprint" }, "catalog.blueprint-bp_1"),
    );
    await withStatusHandlers["catalog.blueprint.revised"]!(
      event("catalog.blueprint.revised", { name: "Blueprint v2" }, "catalog.blueprint-bp_1"),
    );

    expect(withStatus.effects[0]!.sql).toContain("'draft'");
    expect(withStatus.effects[1]!.sql).toContain("COALESCE((SELECT status FROM checkout_catalog_blueprints");

    const withoutStatus = createCatalogMirrorReplayDb("inventory_catalog");
    const withoutStatusHandlers = buildCatalogMirrorProjectionHandlers(withoutStatus.db, {
      tablePrefix: "inventory_catalog",
      blueprintDraftStatusOnUpsert: false,
    });
    await withoutStatusHandlers["catalog.blueprint.created"]!(
      event("catalog.blueprint.created", { blueprintId: "bp_1", name: "Blueprint" }, "catalog.blueprint-bp_1"),
    );
    await withoutStatusHandlers["catalog.blueprint.revised"]!(
      event("catalog.blueprint.revised", { name: "Blueprint v2" }, "catalog.blueprint-bp_1"),
    );

    for (const effect of withoutStatus.effects.filter((entry) => entry.sql.startsWith("INSERT INTO"))) {
      expect(effect.sql).not.toContain("status");
    }
  });

  it("cascades blueprint and dimension changes into item product schemas", async () => {
    const replayDb = createCatalogMirrorReplayDb("checkout_catalog");
    const handlers = buildCatalogMirrorProjectionHandlers(replayDb.db, { tablePrefix: "checkout_catalog" });

    await handlers["catalog.dimension.created"]!(
      event(
        "catalog.dimension.created",
        { dimensionId: "dim_condition", name: "Condition" },
        "catalog.dimension-dim_condition",
      ),
    );
    await handlers["catalog.dimension.option-added"]!(
      event(
        "catalog.dimension.option-added",
        { optionId: "opt_nm", code: "NM", label: [{ locale: "en", value: "Near Mint" }] },
        "catalog.dimension-dim_condition",
      ),
    );
    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", { itemId: "cat_1", title: "Charizard", subtitle: null }),
    );
    await handlers["catalog.blueprint.created"]!(
      event("catalog.blueprint.created", { blueprintId: "bp_1", name: "Card" }, "catalog.blueprint-bp_1"),
    );
    await handlers["catalog.blueprint.dimensions-set"]!(
      event(
        "catalog.blueprint.dimensions-set",
        {
          dimensionRules: [{ dimensionId: "dim_condition", required: true, allowedOptionIds: ["opt_nm", "opt_gone"] }],
        },
        "catalog.blueprint-bp_1",
      ),
    );
    await handlers["catalog.catalog-item.blueprint-assigned"]!(
      event("catalog.catalog-item.blueprint-assigned", { blueprintId: "bp_1" }),
    );

    const productSchema = JSON.parse(String(replayDb.snapshotState().items.cat_1!.product_schema));
    expect(productSchema).toEqual({
      canonicalDimensionOrder: [],
      dimensions: [
        {
          dimensionId: "dim_condition",
          dimensionName: "Condition",
          required: true,
          appliesWhen: [],
          allowedOptions: [
            {
              optionId: "opt_nm",
              code: "NM",
              label_i18n: { defaultLocale: "en", values: { en: "Near Mint" } },
              label: "Near Mint",
            },
            {
              optionId: "opt_gone",
              code: "opt_gone",
              label_i18n: { defaultLocale: "en", values: { en: "opt_gone" } },
              label: "opt_gone",
            },
          ],
        },
      ],
    });
  });

  it("returns a null version schema for unknown blueprints", async () => {
    const replayDb = createCatalogMirrorReplayDb("checkout_catalog");

    expect(await buildVersionSchema(replayDb.db, catalogMirrorTables("checkout_catalog"), "bp_missing")).toBeNull();
  });
});
