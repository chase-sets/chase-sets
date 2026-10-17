import { expect, it } from "vitest";
import { module as collectionsModule } from "../../index";

it("anonymous-owner-expand-migration early-clear mutant", () => {
  expect(collectionsModule.schemaSql).toContain("anonymous_owner_fingerprint text NULL");
  expect(collectionsModule.schemaSql).toContain("owner_revision integer NOT NULL DEFAULT 0");
  expect(collectionsModule.schemaSql).toContain("anonymous_owner_id text NULL");
  expect(collectionsModule.schemaSql).toContain("collections_anonymous_owner_activation");
  expect(collectionsModule.schemaSql).toContain("anonymous-owner-fence");
  const migration = collectionsModule.schemaMigrations?.find(
    (entry) => entry.migrationId === "20261012_collections_anonymous_owner_fingerprint",
  );
  expect(migration).toBeDefined();
  expect(migration?.statements.join("\n")).toContain("ADD COLUMN IF NOT EXISTS anonymous_owner_fingerprint");
  expect(migration?.statements.join("\n")).not.toMatch(/DROP COLUMN|anonymous_owner_id\s*=/i);
});
