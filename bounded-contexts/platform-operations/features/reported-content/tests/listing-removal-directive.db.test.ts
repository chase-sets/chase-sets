import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeModuleSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import { reportedContentSchemaSql } from "../read-model/schema";
import { createReportedContentRuntime } from "../api/runtime";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for listing directive DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
};
const directiveType = "platform-operations.reported-content.listing-removal-directed";

describeDb("listing removal directive atomic append", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"platform-operations">>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(baseUrl!, ["platform-operations"], "listing_directive");
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools["platform-operations"].query(composeModuleSchemaSql({ schemaSql: reportedContentSchemaSql }));
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function runtime() {
    const pool = pools["platform-operations"];
    return createReportedContentRuntime({ db: pool, eventStore: createPostgresEventStore({ pool }) });
  }
  // A target is actionable only once a report has queued it.
  async function queue(listingId: string) {
    await pools["platform-operations"].query(
      `INSERT INTO platform_operations_reported_content_queue_pages
       (target_type, target_id, status, report_count, first_reported_at, last_reported_at, updated_at)
       VALUES ('listing', $1, 'needs-review', 1, now(), now(), now())
       ON CONFLICT DO NOTHING`,
      [listingId],
    );
  }
  function params() {
    return {
      targetType: "listing",
      targetId: createId("lst"),
      action: "unlist" as const,
      note: null,
      operatorUserId: null,
    };
  }
  async function rows(listingId: string) {
    return (
      await pools["platform-operations"].query<{ event_type: string; payload: unknown }>(
        "SELECT event_type, payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
        [`platform-operations.reported-content-listing-${listingId}`],
      )
    ).rows;
  }

  it("payload contract persists audit then the exact four-field directive together", async () => {
    const input = params();
    await queue(input.targetId);
    const result = await runtime().recordModerationAction(input, context);
    expect(await rows(input.targetId)).toEqual([
      { event_type: "platform-operations.reported-content.action-recorded", payload: { ...input, ...result } },
      {
        event_type: directiveType,
        payload: {
          actionId: result.actionId,
          listingId: input.targetId,
          operatorUserId: null,
          directedAt: result.recordedAt,
        },
      },
    ]);
  });

  it("failed-append atomicity rolls back an already inserted audit when the directive insert fails", async () => {
    const pool = pools["platform-operations"];
    await pool.query(`CREATE FUNCTION reject_listing_directive() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = '${directiveType}' THEN RAISE EXCEPTION 'synthetic directive insert failure'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER reject_listing_directive BEFORE INSERT ON event_store_events
      FOR EACH ROW EXECUTE FUNCTION reject_listing_directive()`);
    const input = params();
    await queue(input.targetId);
    await expect(runtime().recordModerationAction(input, context)).rejects.toThrow();
    expect(await rows(input.targetId)).toEqual([]);
    const streams = await pool.query("SELECT * FROM event_store_streams WHERE stream_id = $1", [
      `platform-operations.reported-content-listing-${input.targetId}`,
    ]);
    expect(streams.rows).toEqual([]);
    await pool.query(
      "DROP TRIGGER reject_listing_directive ON event_store_events; DROP FUNCTION reject_listing_directive()",
    );
    await runtime().recordModerationAction(input, context);
    expect(await rows(input.targetId)).toHaveLength(2);
  });

  it("invalid inputs emit neither fact", async () => {
    for (const change of [
      { targetId: "lst_invalid" },
      { operatorUserId: "usr_invalid" },
      { targetType: "unknown" },
      { action: "withdraw-review" as const },
    ]) {
      const input = { ...params(), ...change };
      await queue(input.targetId);
      await expect(runtime().recordModerationAction(input, context)).rejects.toThrow();
      expect(await rows(input.targetId)).toEqual([]);
    }
    expect((await pools["platform-operations"].query("SELECT event_id FROM event_store_events")).rows).toEqual([]);
  });
});
