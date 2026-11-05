import { describe, expect, it, vi } from "vitest";
import type { PgQueryFunction, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as platformOperationsModule } from "../../../index";
import { createPlatformOperationsServices } from "../../../support/runtime-support/services";
import { sellerComplianceCohortPolicy } from "../domain/seller-compliance-cohort-policy";
import {
  sellerComplianceCohortSchemaMigrations,
  sellerComplianceCohortSchemaSql,
  sellerComplianceCohortSchemaStatements,
} from "./cohort-schema";

describe("seller compliance cohort schema", () => {
  it("registers the same additive evaluator DDL for boot and migration, without runtime tables", () => {
    expect(sellerComplianceCohortSchemaSql).toBe(`${sellerComplianceCohortSchemaStatements.join(";\n\n")};\n`);
    expect(platformOperationsModule.schemaSql).toContain(sellerComplianceCohortSchemaSql);
    expect(platformOperationsModule.schemaMigrations).toEqual(
      expect.arrayContaining(sellerComplianceCohortSchemaMigrations),
    );
    expect(sellerComplianceCohortSchemaMigrations[0]?.statements).toBe(sellerComplianceCohortSchemaStatements);
    expect(sellerComplianceCohortSchemaSql.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)).toEqual([
      "CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_cohorts",
      "CREATE TABLE IF NOT EXISTS platform_operations_seller_compliance_cohort_transitions",
    ]);
    expect(sellerComplianceCohortSchemaSql).not.toMatch(/evaluation_failures|sweep_checkpoints|policy_evidence/);
    expect(sellerComplianceCohortSchemaSql).not.toMatch(/\b(?:DROP|ALTER|DELETE|UPDATE)\b/);
  });

  it("indexes due work, publication and numeric seller transition order", () => {
    expect(sellerComplianceCohortSchemaSql).toContain("(next_reevaluation_at) WHERE next_reevaluation_at IS NOT NULL");
    expect(sellerComplianceCohortSchemaSql).toContain("(recorded_at) WHERE published_at IS NULL");
    expect(sellerComplianceCohortSchemaSql).toContain("(seller_account_id, transition_version)");
    expect(sellerComplianceCohortSchemaSql).toContain("transition_version bigint NOT NULL");
    expect(sellerComplianceCohortSchemaSql).toContain("published_at timestamptz NULL");
  });

  it("registers the inert approved policy in the production policy console composition", () => {
    const query = vi.fn<PgQueryFunction>().mockResolvedValue({ rows: [], rowCount: 0 });
    const pool: PgTransactionalPool = { query, connect: async () => ({ query, release: vi.fn() }) };
    const services = createPlatformOperationsServices(pool, {});
    expect(
      services.policyConsoleEntries.filter((entry) => entry.policyKey === sellerComplianceCohortPolicy.policyKey),
    ).toEqual([
      expect.objectContaining({ contextName: "platform-operations", definition: sellerComplianceCohortPolicy }),
    ]);
    expect(query).not.toHaveBeenCalled();
  });
});
