import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutCatalogProjectionHandlers } from "./catalog-projection";

class ProjectionDb implements PgQueryable {
  public readonly catalogItems = new Map<string, Record<string, unknown>>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_catalog_items")) {
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

describe("checkout catalog projection", () => {
  it("projects catalog item language and resolved English display text", async () => {
    const db = new ProjectionDb();
    const handlers = buildCheckoutCatalogProjectionHandlers(db);

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
});
