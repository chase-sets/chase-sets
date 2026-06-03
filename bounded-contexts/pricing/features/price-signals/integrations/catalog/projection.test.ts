import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildPricingPriceSignalCatalogProjectionHandlers, derivePricingCatalogProductKey } from "./projection";

class ProjectionDb implements PgQueryable {
  public readonly references = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }> {
    const values = params ?? [];
    if (sql.includes("INSERT INTO pricing_external_product_reference_inputs")) {
      this.references.set(`${values[0]}:${values[1]}`, {
        provider_key: values[0],
        external_key: values[1],
        catalog_item_id: values[2],
        catalog_product_key: values[3],
        selected_options: JSON.parse(String(values[4])),
        updated_at: values[5],
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes("DELETE FROM pricing_external_product_reference_inputs")) {
      this.references.delete(`${values[0]}:${values[1]}`);
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

describe("pricing TCGplayer Catalog Product reference projection", () => {
  it("derives stable Catalog Product keys from selected options", () => {
    expect(
      derivePricingCatalogProductKey("cat_1", [
        { dimensionId: "printing", optionId: "holofoil" },
        { dimensionId: "condition", optionId: "near_mint" },
      ]),
    ).toBe("cat_1::condition:near_mint|printing:holofoil");
  });

  it("projects external Product references idempotently and unlinks them", async () => {
    const db = new ProjectionDb();
    const handlers = buildPricingPriceSignalCatalogProjectionHandlers(db);
    const event = {
      type: "catalog.catalog-item.external-product-reference-linked",
      streamId: "catalog.item-cat_1",
      streamVersion: 1,
      data: {
        providerKey: "tcgplayer",
        externalKey: "sku:9001001",
        selectedOptions: [{ dimensionId: "condition", optionId: "near_mint" }],
      },
      timing: { recordedAt: "2026-06-03T00:00:00.000Z" },
    } as never;

    await handlers["catalog.catalog-item.external-product-reference-linked"]?.(event);
    await handlers["catalog.catalog-item.external-product-reference-linked"]?.(event);

    expect(db.references.get("tcgplayer:sku:9001001")).toMatchObject({
      catalog_item_id: "cat_1",
      catalog_product_key: "cat_1::condition:near_mint",
    });

    await handlers["catalog.catalog-item.external-product-reference-unlinked"]?.({
      type: "catalog.catalog-item.external-product-reference-unlinked",
      streamId: "catalog.item-cat_1",
      streamVersion: 2,
      data: {
        providerKey: "tcgplayer",
        externalKey: "sku:9001001",
      },
      timing: { recordedAt: "2026-06-03T00:01:00.000Z" },
    } as never);

    expect(db.references.has("tcgplayer:sku:9001001")).toBe(false);
  });
});
