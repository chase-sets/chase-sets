import { expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  assertMeasurePublicationConsumer,
  withMeasurePublicationStaging,
} from "@chase-sets/event-core-postgres/measure-publication-test-support";
import { buildDiscoveryMarketProjectionHandlers } from "./projection";

it("stages 85 Products without changing market tables or Listing patches before completion", async () => {
  const measures = new Map<string, unknown>();
  let snapshot: unknown = null;
  let updatedAt: unknown;
  const writes: unknown[] = [];
  const db: PgQueryable = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const products = () => JSON.parse(String(values[1])) as { productId: string }[];
      if (sql.includes("DELETE FROM discovery_market_product_measures")) {
        const retained = new Set(products().map((product) => product.productId));
        for (const id of measures.keys()) if (!retained.has(id)) measures.delete(id);
      } else if (sql.includes("INSERT INTO discovery_market_product_measures")) {
        for (const product of products()) measures.set(product.productId, product);
        updatedAt = values[2];
      } else if (sql.includes("UPDATE discovery_market_listings AS listing") && sql.includes("resolved_products")) {
        snapshot = products().find((product) => product.productId === "prd_1") ?? null;
        return { rows: [{ listing_id: "synthetic-listing" }] as Row[] };
      } else if (sql.includes("listing.*") && sql.includes("FROM discovery_market_listings AS listing")) {
        return {
          rows: [
            {
              listing_id: "synthetic-listing",
              catalog_catalog_item_id: "cat_1",
              account_id: "synthetic-account",
              status: "active",
              product_measure_snapshot: snapshot,
              visible_quantity: 1,
              seller_listing_availability_status: "available",
            },
          ] as Row[],
        };
      }
      if (/^\s*(INSERT|UPDATE|DELETE|WITH)/.test(sql)) writes.push({ sql, values });
      if (sql.includes("INSERT INTO realtime_projection_outbox (") && sql.includes("RETURNING outbox_id")) {
        return { rows: [{ outbox_id: writes.length }] as Row[] };
      }
      return { rows: [] as Row[] };
    },
  };
  const staging = withMeasurePublicationStaging(db);
  await assertMeasurePublicationConsumer({
    handlers: buildDiscoveryMarketProjectionHandlers(staging.db),
    staging,
    visible: () => ({ measures: [...measures.values()], snapshot, updatedAt, writes }),
    assertProducts: (products) => {
      expect(Object.fromEntries(measures)).toEqual(
        Object.fromEntries(products.map((product) => [product.productId, product])),
      );
      expect(snapshot).toEqual(products.find((product) => product.productId === "prd_1") ?? null);
    },
  });
  expect(writes.some((write) => JSON.stringify(write).includes("projection.patch"))).toBe(true);
});
