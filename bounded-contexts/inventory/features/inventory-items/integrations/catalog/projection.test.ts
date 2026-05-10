import { describe, expect, it } from "vitest";
import type { PgQueryResult, PgQueryable } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildInventoryCatalogItemProjectionHandlers } from "./projection";

class ProjectionDb implements PgQueryable {
  public readonly externalReferences = new Map<string, unknown>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO inventory_catalog_external_product_references")) {
      this.externalReferences.set(`${values[0]}:${values[1]}`, {
        provider_key: values[0],
        external_key: values[1],
        catalog_item_id: values[2],
        selected_options: JSON.parse(String(values[3])),
        updated_at: values[4],
      });
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM inventory_catalog_external_product_references")) {
      this.externalReferences.delete(`${values[0]}:${values[1]}`);
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(type: string, data: Record<string, unknown>): TransportEvent {
  return {
    id: "evt_1" as never,
    type,
    streamId: "catalog.item-cat_1" as never,
    streamVersion: 1 as never,
    globalPosition: 1 as never,
    tenantId: "tnt_1" as never,
    data,
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

describe("inventory catalog item projection", () => {
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

    expect(db.externalReferences.get("tcgplayer:tcg_sku_1")).toMatchObject({
      catalog_item_id: "cat_1",
      selected_options: [{ dimensionId: "condition", optionId: "near_mint" }],
    });

    await handlers["catalog.catalog-item.external-product-reference-unlinked"]!(
      event("catalog.catalog-item.external-product-reference-unlinked", {
        providerKey: "tcgplayer",
        externalKey: "tcg_sku_1",
      }),
    );

    expect(db.externalReferences.has("tcgplayer:tcg_sku_1")).toBe(false);
  });
});
