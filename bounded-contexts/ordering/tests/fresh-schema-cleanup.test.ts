import { describe, expect, it } from "vitest";

import {
  orderingSupplySourceSchemaMigrations,
  orderingSupplySourceSchemaSql,
} from "../features/orders/integrations/supply/supply-source-schema";
import { orderingOrderSchemaMigrations, orderingOrderSchemaSql } from "../features/orders/read-model/schema";

describe("fresh ordering schemas", () => {
  it("keeps one durable claim per order source identity", () => {
    const migrationSql = orderingOrderSchemaMigrations.flatMap((migration) => migration.statements).join("\n");

    expect(orderingOrderSchemaSql).toContain("CREATE TABLE IF NOT EXISTS ordering_order_source_claims");
    expect(orderingOrderSchemaSql).toContain("PRIMARY KEY (source_type, source_reference_id)");
    expect(migrationSql).toContain("INSERT INTO ordering_order_source_claims");
    expect(migrationSql).toContain("jsonb_agg(order_id ORDER BY order_id)");
  });

  it("keeps payment-deadline order-page indexes out of boot-time schema SQL", () => {
    const migrationSql = orderingOrderSchemaMigrations.flatMap((migration) => migration.statements).join("\n");

    expect(orderingOrderSchemaSql).toContain("payment_deadline_at timestamptz NULL");
    expect(orderingOrderSchemaSql).not.toContain("ordering_order_pages_payment_deadline_idx");
    expect(migrationSql).toContain("ALTER TABLE ordering_order_pages ADD COLUMN IF NOT EXISTS payment_deadline_at");
    expect(migrationSql).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_order_pages_payment_deadline_idx");
  });

  it("keeps payment-deadline input indexes out of boot-time schema SQL", () => {
    const migrationSql = orderingSupplySourceSchemaMigrations.flatMap((migration) => migration.statements).join("\n");

    expect(orderingSupplySourceSchemaSql).toContain("CREATE TABLE IF NOT EXISTS ordering_payment_deadline_inputs");
    expect(orderingSupplySourceSchemaSql).not.toContain("ordering_payment_deadline_inputs_due_idx");
    expect(orderingSupplySourceSchemaSql).not.toContain("ordering_payment_deadline_inputs_payment_idx");
    expect(migrationSql).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_payment_deadline_inputs_due_idx");
    expect(migrationSql).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS ordering_payment_deadline_inputs_payment_idx",
    );
  });
});
