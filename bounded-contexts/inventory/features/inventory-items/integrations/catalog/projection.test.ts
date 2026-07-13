import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";

class ProjectionDb implements PgQueryable {
  public readonly externalProductReferences = new Map<string, unknown>();
  public readonly externalCatalogItemReferences = new Map<string, unknown>();
  public readonly catalogItems = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO inventory_catalog_items")) {
      this.catalogItems.set(String(values[0]), {
        catalog_item_id: values[0],
        language_code: values[1],
        title: values[2],
        subtitle: values[3],
        status: "draft",
        updated_at: values[4],
      });
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("SELECT catalog_item_id, language_code, title, subtitle, blueprint_id, status, updated_at")) {
      const item = this.catalogItems.get(String(values[0]));
      return { rows: (item ? [item] : []) as Row[], rowCount: item ? 1 : 0 };
    }

    if (sql.includes("SET product_schema = $2")) {
      this.catalogItems.set(String(values[0]), {
        ...this.catalogItems.get(String(values[0])),
        product_schema: values[1],
        updated_at: values[2],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("UPDATE inventory_catalog_items") && sql.includes("title = $3")) {
      this.catalogItems.set(String(values[0]), {
        ...this.catalogItems.get(String(values[0])),
        language_code: values[1],
        title: values[2],
        subtitle: values[3],
        updated_at: values[4],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("INSERT INTO inventory_catalog_external_product_references")) {
      this.externalProductReferences.set(`${values[0]}:${values[1]}`, {
        provider_key: values[0],
        external_key: values[1],
        catalog_item_id: values[2],
        selected_options: JSON.parse(String(values[3])),
        updated_at: values[4],
      });
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM inventory_catalog_external_product_references")) {
      this.externalProductReferences.delete(`${values[0]}:${values[1]}`);
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO inventory_catalog_external_catalog_item_references")) {
      this.externalCatalogItemReferences.set(`${values[0]}:${values[1]}`, {
        provider_key: values[0],
        external_key: values[1],
        catalog_item_id: values[2],
        updated_at: values[3],
      });
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM inventory_catalog_external_catalog_item_references")) {
      this.externalCatalogItemReferences.delete(`${values[0]}:${values[1]}`);
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId: "catalog.item-cat_1",
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-05-09T00:00:00.000Z", recordedAt: "2026-05-09T00:00:00.000Z" },
  });
}

describe("inventory catalog item projection", () => {
  it("projects catalog item language and resolved English display text", async () => {
    const db = new ProjectionDb();
    const handlers = buildInventoryCatalogItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", {
        itemId: "cat_1",
        languageCode: "ja",
        title: { defaultLocale: "en", values: { en: "Charizard", ja: "リザードン" } },
        subtitle: { defaultLocale: "en", values: { en: "Japanese Base Set", ja: "拡張パック" } },
      }),
    );

    expect(db.catalogItems.get("cat_1")).toMatchObject({
      catalog_item_id: "cat_1",
      language_code: "ja",
      title: "Charizard",
      subtitle: "Japanese Base Set",
    });
  });

  it("updates item labels from Catalog display identity facts", async () => {
    const db = new ProjectionDb();
    const handlers = buildInventoryCatalogItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.created"]!(
      event("catalog.catalog-item.created", {
        itemId: "cat_1",
        title: "Fallback",
        subtitle: null,
      }),
    );

    await handlers["catalog.catalog-item.display-identity-resolved"]!(
      event("catalog.catalog-item.display-identity-resolved", {
        catalogItemId: "cat_1",
        languageCode: "en",
        title: "Charizard 4/102",
        subtitle: "Base Set Rare Holo",
      }),
    );

    expect(db.catalogItems.get("cat_1")).toMatchObject({
      language_code: "en",
      title: "Charizard 4/102",
      subtitle: "Base Set Rare Holo",
    });
  });

  it("does not handle Catalog metadata revisions as display label changes", () => {
    const db = new ProjectionDb();
    const handlers = buildInventoryCatalogItemProjectionHandlers(db);

    expect(handlers["catalog.catalog-item.metadata-revised"]).toBeUndefined();
  });

  it("projects Catalog external product reference links and unlinks", async () => {
    const db = new ProjectionDb();
    const handlers = buildInventoryCatalogItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.external-product-reference-linked"]!(
      event("catalog.catalog-item.external-product-reference-linked", {
        providerKey: "tcgplayer",
        externalKey: "tcg_sku_1",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      }),
    );

    expect(db.externalProductReferences.get("tcgplayer:tcg_sku_1")).toMatchObject({
      catalog_item_id: "cat_1",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    });

    await handlers["catalog.catalog-item.external-product-reference-unlinked"]!(
      event("catalog.catalog-item.external-product-reference-unlinked", {
        providerKey: "tcgplayer",
        externalKey: "tcg_sku_1",
      }),
    );

    expect(db.externalProductReferences.has("tcgplayer:tcg_sku_1")).toBe(false);
  });

  it("projects Catalog external Catalog Item reference links and unlinks", async () => {
    const db = new ProjectionDb();
    const handlers = buildInventoryCatalogItemProjectionHandlers(db);

    await handlers["catalog.catalog-item.external-catalog-item-reference-linked"]!(
      event("catalog.catalog-item.external-catalog-item-reference-linked", {
        providerKey: "tcgplayer",
        externalKey: "product:12345",
      }),
    );

    await handlers["catalog.catalog-item.external-catalog-item-reference-linked"]!(
      event("catalog.catalog-item.external-catalog-item-reference-linked", {
        providerKey: "tcgplayer",
        externalKey: "product:12345",
      }),
    );

    expect(db.externalCatalogItemReferences.get("tcgplayer:product:12345")).toMatchObject({
      catalog_item_id: "cat_1",
    });

    await handlers["catalog.catalog-item.external-catalog-item-reference-unlinked"]!(
      event("catalog.catalog-item.external-catalog-item-reference-unlinked", {
        providerKey: "tcgplayer",
        externalKey: "product:12345",
      }),
    );

    expect(db.externalCatalogItemReferences.has("tcgplayer:product:12345")).toBe(false);
  });
});
