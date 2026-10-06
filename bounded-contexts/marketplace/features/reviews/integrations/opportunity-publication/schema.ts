import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const reviewOpportunityPublicationSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_review_opportunity_work (
  order_id text PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  published_generation bigint NOT NULL DEFAULT 0,
  published_stream_version integer NOT NULL DEFAULT 0,
  last_fact jsonb NULL,
  backfill_generation text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS marketplace_review_opportunity_work_pending_idx
  ON marketplace_review_opportunity_work (order_id)
  WHERE generation > published_generation;
CREATE TABLE IF NOT EXISTS marketplace_review_opportunity_backfill (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source_generation text NOT NULL,
  after_order_id text NOT NULL DEFAULT '',
  completed boolean NOT NULL DEFAULT false
);
CREATE OR REPLACE FUNCTION marketplace_mark_review_opportunity_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE changed_order_id text;
BEGIN
  changed_order_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END;
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  INSERT INTO marketplace_review_opportunity_work (order_id) VALUES (changed_order_id)
  ON CONFLICT (order_id) DO UPDATE
    SET generation = marketplace_review_opportunity_work.generation + 1, updated_at = now();
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
`;

// These are the canonical snapshot writers, including direct delivery synchronization
// and replay. Database-local invalidation commits with the write, never after it.
export const reviewOpportunityPublicationTriggersSql = [
  "marketplace_review_order_sources",
  "marketplace_review_eligibility_pages",
  "marketplace_review_pages",
  "marketplace_review_hold_pages",
  "marketplace_review_scoring_pages",
]
  .map(
    (table) => `
DROP TRIGGER IF EXISTS review_opportunity_changed ON ${table};
CREATE TRIGGER review_opportunity_changed AFTER INSERT OR UPDATE OR DELETE ON ${table}
FOR EACH ROW EXECUTE FUNCTION marketplace_mark_review_opportunity_changed();
`,
  )
  .join("\n");

export const reviewOpportunityPublicationMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20261006_marketplace_review_opportunity_publication",
    description: "Retain generation-fenced review opportunity delivery and resumable historical backfill.",
    statements: [reviewOpportunityPublicationSchemaSql, reviewOpportunityPublicationTriggersSql],
  },
];
