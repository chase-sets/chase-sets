import { describe, expect, it } from "vitest";
import { supportRequestSchemaMigrations, supportRequestSchemaSql } from "./schema";

describe("support request read-model schema", () => {
  it("adds a support-case display reference and its partial unique index migration", () => {
    expect(supportRequestSchemaSql).toContain("display_reference text NOT NULL DEFAULT ''");
    expect(supportRequestSchemaMigrations).toContainEqual(
      expect.objectContaining({
        migrationId: "20260712_support_request_display_reference_unique_idx",
        statements: expect.arrayContaining([
          expect.stringContaining(
            "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS support_request_pages_display_reference_key",
          ),
          expect.stringContaining("WHERE display_reference <> ''"),
        ]),
      }),
    );
  });

  it("stores the remedy summary, closure blockers, next action, and repair guidance in the slice read model", () => {
    expect(supportRequestSchemaSql).toContain("remedy jsonb NULL");
    expect(supportRequestSchemaSql).toContain("case_presentation text NOT NULL DEFAULT 'decision-pending'");
    expect(supportRequestSchemaSql).toContain("closure_eligible boolean NOT NULL DEFAULT false");
    expect(supportRequestSchemaSql).toContain("closure_blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb");
    expect(supportRequestSchemaSql).toContain("next_remedy_action text NULL");
    expect(supportRequestSchemaSql).toContain("remedy_repair_guidance jsonb NOT NULL DEFAULT '[]'::jsonb");
  });
});
