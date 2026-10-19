import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";
import { parseInventoryDraftReceiptRow, type InventoryDraftReceiptRow } from "./inventory-draft-receipt";

export const INVENTORY_DRAFT_RECEIPT_MIGRATION_ID = "20261019_marketplace_inventory_draft_receipts_v1";

export const inventoryDraftReceiptSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_inventory_draft_receipts (
  message_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  performed_by_user_id text NOT NULL,
  listing_id text NOT NULL UNIQUE,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[a-f0-9]{64}$'),
  receipt jsonb NOT NULL,
  accepted_at timestamptz NOT NULL
);
`;

export const inventoryDraftReceiptMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: INVENTORY_DRAFT_RECEIPT_MIGRATION_ID,
    description: "Install durable immutable Inventory draft receipts before enabling Inventory message delivery.",
    dataStep: async (db) => {
      await db.query(inventoryDraftReceiptSchemaSql);
      const shape = await db.query<{ valid: boolean }>(`SELECT
        c.relpersistence = 'p'
        AND (SELECT count(*) FROM pg_attribute AS a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) = 8
        AND NOT EXISTS (
          SELECT 1 FROM (VALUES ('message_id','text'), ('tenant_id','text'), ('account_id','text'),
            ('performed_by_user_id','text'), ('listing_id','text'), ('intent_hash','text'),
            ('receipt','jsonb'), ('accepted_at','timestamp with time zone')) AS expected(name, type)
          LEFT JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attname = expected.name
          WHERE a.attname IS NULL OR NOT a.attnotnull OR format_type(a.atttypid,a.atttypmod) <> expected.type
        )
        AND EXISTS (SELECT 1 FROM pg_constraint AS p WHERE p.conrelid = c.oid AND p.contype = 'p'
          AND p.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'message_id')])
        AND EXISTS (SELECT 1 FROM pg_constraint AS u WHERE u.conrelid = c.oid AND u.contype = 'u'
          AND u.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.oid AND attname = 'listing_id')]) AS valid
        FROM pg_class AS c WHERE c.oid = 'marketplace_inventory_draft_receipts'::regclass`);
      if (shape.rows.length !== 1 || !shape.rows[0]?.valid) throw new Error("Invalid Inventory draft receipt schema.");
      let after: string | null = null;
      for (;;) {
        const page: { rows: InventoryDraftReceiptRow[] } = await db.query<InventoryDraftReceiptRow>(
          `SELECT message_id, tenant_id, account_id, performed_by_user_id, listing_id, intent_hash, receipt, accepted_at
           FROM marketplace_inventory_draft_receipts WHERE ($1::text IS NULL OR message_id > $1)
           ORDER BY message_id LIMIT 500`,
          [after],
        );
        for (const row of page.rows)
          if (!parseInventoryDraftReceiptRow(row)) throw new Error("Invalid Inventory draft receipt history.");
        if (page.rows.length < 500) break;
        after = page.rows[page.rows.length - 1]!.message_id;
      }
    },
    statements: [
      `CREATE OR REPLACE FUNCTION marketplace_reject_inventory_draft_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $receipt$
BEGIN
  RAISE EXCEPTION 'Inventory draft receipts are immutable' USING ERRCODE = '23514';
END
$receipt$`,
      `DROP TRIGGER IF EXISTS marketplace_inventory_draft_receipts_immutable ON marketplace_inventory_draft_receipts`,
      `CREATE TRIGGER marketplace_inventory_draft_receipts_immutable
BEFORE UPDATE OR DELETE ON marketplace_inventory_draft_receipts
FOR EACH ROW EXECUTE FUNCTION marketplace_reject_inventory_draft_receipt_mutation()`,
    ],
  },
];
