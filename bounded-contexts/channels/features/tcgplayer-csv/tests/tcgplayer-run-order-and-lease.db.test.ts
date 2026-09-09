import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { tcgplayerCsvSchemaSql } from "../read-model/schema";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for Channels DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
let pools: Readonly<Record<"channels", PgTransactionalPool>>;

describeDb("tcgplayer-run-order-and-lease", () => {
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["channels"], "tcgplayer_run_order");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.channels.query(tcgplayerCsvSchemaSql);
  });

  afterAll(async () => closeMultiContextTestPools(pools));

  it("boots twice and admits only one non-terminal run per connection", async () => {
    await pools.channels.query(tcgplayerCsvSchemaSql);
    await seedSnapshot();
    await insertRun("run-1", "reservation-1", "manual");
    await expect(insertRun("run-2", "reservation-2", "connector")).rejects.toMatchObject({ code: "23505" });
    await pools.channels.query(
      "UPDATE channel_sync_runs SET state='abandoned',revision=revision+1 WHERE run_id='run-1'",
    );
    await expect(insertRun("run-2", "reservation-2", "connector")).resolves.toBeUndefined();
  });

  it("retains immutable listing identity and fences stale run writes", async () => {
    await seedSnapshot();
    await insertRun("run-1", "reservation-1", "manual");
    await insertMember("run-1", "reservation-1", "listing-immutable", 91);
    const first = await pools.channels.query<{ listing_id: string; desired_state_sequence: string }>(
      "SELECT listing_id,desired_state_sequence::text FROM channel_sync_run_rows WHERE run_id='run-1'",
    );
    expect(first.rows[0]).toEqual({ listing_id: "listing-immutable", desired_state_sequence: "91" });

    const winner = await pools.channels.query(
      "UPDATE channel_sync_runs SET state='claimed',revision=revision+1 WHERE run_id='run-1' AND revision=0 AND state='composed'",
    );
    const stale = await pools.channels.query(
      "UPDATE channel_sync_runs SET state='abandoned',revision=revision+1 WHERE run_id='run-1' AND revision=0 AND state='composed'",
    );
    expect(winner.rowCount).toBe(1);
    expect(stale.rowCount).toBe(0);
  });

  it("rejects manual runs without the captured lease policy snapshot and connector runs with one", async () => {
    await seedSnapshot();
    await expect(insertRun("run-manual", "reservation-manual", "manual", null)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insertRun("run-connector", "reservation-connector", "connector", { synthetic: true }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

async function seedSnapshot(): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_inventory_snapshots
     (snapshot_id,snapshot_generation,connection_id,provider_key,surface,parsed_row_count,completeness,ingested_at,captured_at,captured_at_source)
     VALUES ('snapshot-1',1,'connection-1','tcgplayer','staged',1,'unverified','2026-09-09T00:00:00Z','2026-09-09T00:00:00Z','operator-declared')`,
  );
}

async function insertRun(
  runId: string,
  reservationId: string,
  claimantKind: "manual" | "connector",
  snapshot: unknown = claimantKind === "manual" ? { synthetic: true } : null,
): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_sync_runs
     (run_id,revision,sequence,connection_id,provider_key,reservation_id,claimant_kind,claimant_id,lease_expires_at,
      manual_claim_lease_policy_snapshot,state,basis_snapshot_id,basis_snapshot_generation,csv_header,member_count,member_digest,created_at,updated_at)
     VALUES ($1,0,(SELECT coalesce(max(sequence),0)+1 FROM channel_sync_runs),'connection-1','tcgplayer',$2,$3,'claimant-1',
      '2026-09-09T00:30:00Z',$4::jsonb,'composed','snapshot-1',1,'[]'::jsonb,1,$5,'2026-09-09T00:00:00Z','2026-09-09T00:00:00Z')`,
    [runId, reservationId, claimantKind, snapshot === null ? null : JSON.stringify(snapshot), "a".repeat(64)],
  );
}

async function insertMember(
  runId: string,
  reservationId: string,
  listingId: string,
  desiredStateSequence: number,
): Promise<void> {
  await pools.channels.query(
    `INSERT INTO channel_sync_run_rows
     (run_id,operation_id,ordinal,reservation_id,attempt_id,claim_generation,channel_listing_id,listing_id,
      desired_state_sequence,listing_revision,payload_digest,member_kind,external_key,condition_text,basis_snapshot_id,
      basis_snapshot_generation,basis_total_quantity,basis_price_amount_minor,target_quantity,target_price_amount_minor,
      csv_row_json,refusal_reason,mapping_dimension,mapping_source_key,provider_action)
     VALUES ($1,'operation-1',0,$2,'attempt-1',1,'channel-listing-1',$3,$4,7,$5,'already-satisfied',
      'product:90000001',NULL,'snapshot-1',1,2,26,2,26,NULL,NULL,NULL,NULL,'not-attempted-already-satisfied')`,
    [runId, reservationId, listingId, desiredStateSequence, "b".repeat(64)],
  );
}
