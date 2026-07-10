import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const contexts = [
  "auth",
  "catalog",
  "checkout",
  "commercial-terms",
  "discovery",
  "fulfillment",
  "identity",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "platform-operations",
  "pricing",
  "public-presence",
  "settlement",
];

const durableTables = [
  "event_store_events",
  "event_store_streams",
  "event_projection_checkpoints",
  "event_subscription_checkpoints",
  "notification_outbox",
  "identity_agent_webhook_deliveries",
  "identity_session_tokens",
  "identity_magic_link_tokens",
  "identity_linked_platform_authorizations",
  "fulfillment_postage_label_operations",
  "fulfillment_postage_provider_events",
  "inventory_item_adjustment_idempotency",
  "ordering_offer_acceptance_inputs",
  "ordering_payment_capture_inputs",
  "ordering_payment_deadline_inputs",
  "payments_order_cancellation_refund_effects",
  "payments_support_refund_effects",
  "payments_provider_idempotency_keys",
  "payments_provider_operations",
  "payments_provider_webhook_events",
  "settlement_provider_idempotency_keys",
  "settlement_provider_operations",
  "settlement_money_movement_webhook_events",
];

const catalogExclusions = new Map([
  ["catalog_items", "Canonical Catalog authoring state without a declared projection reset contract"],
  [
    "catalog_item_display_identity_recompute_work",
    "Operational recompute work queue without a declared projection reset contract",
  ],
  ["catalog_admin_catalog_item_detail_pages", "FK-coupled to logged table catalog_items"],
  ["catalog_admin_catalog_item_list_pages", "FK-coupled to logged table catalog_items"],
  ["catalog_external_catalog_item_references", "FK-coupled to logged table catalog_items"],
  ["catalog_external_product_references", "FK-coupled to logged table catalog_items"],
  ["catalog_item_display_identities", "FK-coupled to logged table catalog_items"],
  ["catalog_resolved_product_contents", "FK-coupled to logged table catalog_items"],
  ["catalog_resolved_product_measures", "FK-coupled to logged table catalog_items"],
  ["catalog_product_content_types", "FK-coupled to logged table catalog_resolved_product_contents"],
  ["catalog_product_content_inclusion_policies", "FK-coupled to logged table catalog_resolved_product_contents"],
]);

function readMigration(contextName) {
  const path = resolve(
    "bounded-contexts",
    contextName,
    "support",
    "runtime-support",
    "unlogged-projection-migrations.ts",
  );
  const source = readFileSync(path, "utf8");
  const statementsBlock = source.match(/statements:\s*\[([\s\S]*?)\](?:,\s*)?\n\s*}/);

  if (!statementsBlock) {
    throw new Error(`Could not read migration statements for ${contextName}.`);
  }

  return {
    source,
    statements: [...statementsBlock[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)].map((match) =>
      JSON.parse(`"${match[1]}"`),
    ),
  };
}

function collectSchemaFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectSchemaFiles(path);
    }

    return entry.name.endsWith("schema.ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

function readForeignKeys() {
  const relationships = new Map();

  for (const contextName of contexts) {
    const contextDirectory = resolve("bounded-contexts", contextName);

    for (const schemaFile of collectSchemaFiles(contextDirectory)) {
      const source = readFileSync(schemaFile, "utf8");

      for (const tableMatch of source.matchAll(
        /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z][a-z0-9_]*)\s*\(([\s\S]*?)\);/g,
      )) {
        const sourceTable = tableMatch[1];
        const body = tableMatch[2];
        const explicitForeignKeyPattern =
          /CONSTRAINT\s+([a-z][a-z0-9_]*)\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([a-z][a-z0-9_]*)\s*\(([^)]+)\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/gi;

        for (const foreignKeyMatch of body.matchAll(explicitForeignKeyPattern)) {
          recordForeignKey(relationships, {
            contextName,
            sourceTable,
            constraintName: foreignKeyMatch[1],
            sourceColumns: readColumnList(foreignKeyMatch[2]),
            targetTable: foreignKeyMatch[3],
            targetColumns: readColumnList(foreignKeyMatch[4]),
            onDelete: foreignKeyMatch[5]?.replace(/\s+/g, " ").toUpperCase(),
          });
        }

        const inlineForeignKeyPattern =
          /^\s*([a-z][a-z0-9_]*)\s+[^,\n]*?\bREFERENCES\s+([a-z][a-z0-9_]*)\s*\(([^)]+)\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/gim;

        for (const foreignKeyMatch of body.matchAll(inlineForeignKeyPattern)) {
          const sourceColumns = [foreignKeyMatch[1]];
          recordForeignKey(relationships, {
            contextName,
            sourceTable,
            constraintName: `${sourceTable}_${sourceColumns.join("_")}_fkey`,
            sourceColumns,
            targetTable: foreignKeyMatch[2],
            targetColumns: readColumnList(foreignKeyMatch[3]),
            onDelete: foreignKeyMatch[4]?.replace(/\s+/g, " ").toUpperCase(),
          });
        }
      }
    }
  }

  return [...relationships.values()];
}

function readColumnList(value) {
  return value.split(",").map((column) => column.trim());
}

function recordForeignKey(relationships, relationship) {
  const key = `${relationship.sourceTable}.${relationship.constraintName}`;
  relationships.set(key, relationship);
}

function addForeignKeyStatement(relationship) {
  const onDelete = relationship.onDelete ? ` ON DELETE ${relationship.onDelete}` : "";
  return `ALTER TABLE ${relationship.sourceTable} ADD CONSTRAINT ${relationship.constraintName} FOREIGN KEY (${relationship.sourceColumns.join(
    ", ",
  )}) REFERENCES ${relationship.targetTable} (${relationship.targetColumns.join(", ")})${onDelete} NOT VALID;`;
}

function isSupportedAlterStatement(statement) {
  return (
    /^ALTER TABLE [a-z][a-z0-9_]* SET UNLOGGED;$/.test(statement) ||
    /^ALTER TABLE [a-z][a-z0-9_]* DROP CONSTRAINT IF EXISTS [a-z][a-z0-9_]*;$/.test(statement) ||
    /^ALTER TABLE [a-z][a-z0-9_]* ADD CONSTRAINT [a-z][a-z0-9_]* FOREIGN KEY \([a-z0-9_, ]+\) REFERENCES [a-z][a-z0-9_]* \([a-z0-9_, ]+\)(?: ON DELETE (?:CASCADE|SET NULL|RESTRICT|NO ACTION))? NOT VALID;$/.test(
      statement,
    ) ||
    /^ALTER TABLE [a-z][a-z0-9_]* VALIDATE CONSTRAINT [a-z][a-z0-9_]*;$/.test(statement)
  );
}

describe("unlogged projection migration ledgers", () => {
  it.each(contexts)("registers the %s migration with bounded locking", (contextName) => {
    const migration = readMigration(contextName);
    const contextModule = readFileSync(resolve("bounded-contexts", contextName, "index.ts"), "utf8");
    const statements = migration.statements;
    const lockStatementIndex = statements.indexOf("SET lock_timeout = '5s';");
    const firstAlterIndex = statements.findIndex((statement) => statement.startsWith("ALTER TABLE "));

    expect(lockStatementIndex).toBeGreaterThanOrEqual(0);
    expect(firstAlterIndex).toBeGreaterThan(lockStatementIndex);
    expect(contextModule).toContain("UnloggedProjectionSchemaMigrations");
    expect(statements.filter((statement) => statement.startsWith("ALTER TABLE ")).length).toBeGreaterThan(0);
    expect(
      statements.filter((statement) => statement.startsWith("ALTER TABLE ")).every(isSupportedAlterStatement),
    ).toBe(true);
  });

  it("keeps every foreign-key relationship persistence-consistent during and after conversion", () => {
    const migrations = new Map(contexts.map((contextName) => [contextName, readMigration(contextName).statements]));
    const inconsistentRelationships = [];

    for (const relationship of readForeignKeys()) {
      const statements = migrations.get(relationship.contextName);
      const sourceConversionIndex = statements.indexOf(`ALTER TABLE ${relationship.sourceTable} SET UNLOGGED;`);
      const targetConversionIndex = statements.indexOf(`ALTER TABLE ${relationship.targetTable} SET UNLOGGED;`);
      const sourceIsUnlogged = sourceConversionIndex >= 0;
      const targetIsUnlogged = targetConversionIndex >= 0;

      if (sourceIsUnlogged !== targetIsUnlogged) {
        inconsistentRelationships.push(`${relationship.sourceTable} -> ${relationship.targetTable}`);
        continue;
      }

      if (!sourceIsUnlogged) {
        continue;
      }

      const dropStatement = `ALTER TABLE ${relationship.sourceTable} DROP CONSTRAINT IF EXISTS ${relationship.constraintName};`;
      const addStatement = addForeignKeyStatement(relationship);
      const validateStatement = `ALTER TABLE ${relationship.sourceTable} VALIDATE CONSTRAINT ${relationship.constraintName};`;
      const dropIndex = statements.indexOf(dropStatement);
      const addIndex = statements.indexOf(addStatement);
      const validateIndex = statements.indexOf(validateStatement);

      expect(
        dropIndex,
        `Missing FK drop for ${relationship.sourceTable} -> ${relationship.targetTable}`,
      ).toBeGreaterThanOrEqual(0);
      expect(dropIndex).toBeLessThan(sourceConversionIndex);
      expect(dropIndex).toBeLessThan(targetConversionIndex);
      expect(
        addIndex,
        `Missing NOT VALID FK restore for ${relationship.sourceTable} -> ${relationship.targetTable}`,
      ).toBeGreaterThan(Math.max(sourceConversionIndex, targetConversionIndex));
      expect(
        validateIndex,
        `Missing FK validation for ${relationship.sourceTable} -> ${relationship.targetTable}`,
      ).toBeGreaterThan(addIndex);
    }

    expect(inconsistentRelationships).toEqual([]);
  });

  it("records Catalog logged-table exclusions and never converts them", () => {
    const migration = readMigration("catalog");
    const recordedExclusions = new Map(
      [...migration.source.matchAll(/tableName:\s*"([^"]+)",\s*reason:\s*"([^"]+)"/g)].map((match) => [
        match[1],
        match[2],
      ]),
    );

    expect(recordedExclusions).toEqual(catalogExclusions);

    for (const tableName of catalogExclusions.keys()) {
      expect(migration.statements).not.toContain(`ALTER TABLE ${tableName} SET UNLOGGED;`);
    }
  });

  it("keeps source-of-truth, checkpoint, outbox, token, webhook, reaction, and idempotency tables logged", () => {
    const migrations = contexts.map((contextName) => readMigration(contextName).source).join("\n");

    for (const tableName of durableTables) {
      expect(migrations).not.toContain(`ALTER TABLE ${tableName} SET UNLOGGED`);
    }
  });
});
