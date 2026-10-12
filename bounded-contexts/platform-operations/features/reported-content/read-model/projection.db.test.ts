import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { reportedContentSchemaSql } from "./schema";
import {
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "./projection";

function buildReportedContentProjectionHandlers(db: PgQueryable) {
  return {
    ...buildMarketplaceReportedContentProjectionHandlers(db),
    ...buildPlatformOperationsReportedContentProjectionHandlers(db),
  };
}

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for reported content DB tests in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;
const at = "2026-07-07T00:02:00.000Z";
const owner = "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const listingEnforcement = {
  version: 1,
  listingEnforcementActionId: "lea_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  accountId: owner,
  source: "operator-unlist",
  sourceActionId: "rca_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  occurredAt: at,
};
function event(type: string, data: Record<string, unknown>, streamId = "marketplace.listing-lst_1") {
  return buildTransportEvent(type, data, {
    id: "evt_removal",
    streamId,
    globalPosition: "1",
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_ops", forAccountId: owner },
    timing: { occurredAt: at, recordedAt: "2026-07-07T00:10:00.000Z" },
  });
}

describeDb("reported content removal SQL", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"platform-operations">>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["platform-operations"],
      "reported_content_removal",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools["platform-operations"].query(reportedContentSchemaSql);
    await pools["platform-operations"].query(
      `INSERT INTO platform_operations_reported_content_queue_pages
       (target_type, target_id, target_owner_account_id, status, report_count, reasons, reports,
        first_reported_at, last_reported_at, updated_at, auto_unlisted_at, auto_unlist_report_id, auto_unlist_threshold)
       VALUES ('listing', 'lst_1', $1, 'needs-review', 2, '[{"reason":"other","count":2}]', '[{"reportId":"rpt_existing"}]', $2, $2, $2, $2, 'rpt_previous', 3),
              ('listing', 'lst_2', 'acc_other', 'needs-review', 1, '[]', '[]', $2, $2, $2, NULL, NULL, NULL),
              ('review', 'lst_1', 'acc_review', 'needs-review', 1, '[]', '[]', $2, $2, $2, NULL, NULL, NULL)`,
      [owner, "2026-07-07T00:00:00.000Z"],
    );
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  const snapshot = async () =>
    (
      await pools["platform-operations"].query(
        "SELECT * FROM platform_operations_reported_content_queue_pages ORDER BY target_type, target_id",
      )
    ).rows;

  it("operator removal alone sets manual visibility and preserves newer update time and provenance", async () => {
    await pools["platform-operations"].query(
      `UPDATE platform_operations_reported_content_queue_pages
       SET updated_at = $1
       WHERE target_type = 'listing' AND target_id = 'lst_1'`,
      ["2026-07-07T00:05:00.000Z"],
    );
    const before = await snapshot();
    expect(before[0]).toMatchObject({
      status: "needs-review",
      updated_at: new Date("2026-07-07T00:05:00.000Z"),
      last_action: null,
      last_action_at: null,
      last_action_note: null,
      last_action_by_user_id: null,
      auto_unlisted_at: new Date("2026-07-07T00:00:00.000Z"),
      auto_unlist_report_id: "rpt_previous",
      auto_unlist_threshold: 3,
    });

    await buildMarketplaceReportedContentProjectionHandlers(pools["platform-operations"])[
      "marketplace.listing.operator-unlisted"
    ]!(event("marketplace.listing.operator-unlisted", { listingEnforcement }));

    expect(await snapshot()).toEqual([{ ...before[0], status: "manually-unlisted" }, before[1], before[2]]);
  });

  it.each(["audit-first", "removal-first"])(
    "operator removal matches automatic visibility: %s real SQL",
    async (order) => {
      const handlers = buildReportedContentProjectionHandlers(pools["platform-operations"]);
      const before = await snapshot();
      const remove = () =>
        handlers["marketplace.listing.operator-unlisted"]!(
          event("marketplace.listing.operator-unlisted", { listingEnforcement }),
        );
      const audit = () =>
        handlers["platform-operations.reported-content.action-recorded"]!(
          event("platform-operations.reported-content.action-recorded", {
            targetType: "listing",
            targetId: "lst_1",
            action: "unlist",
            recordedAt: at,
            operatorUserId: "usr_ops",
            note: "Original provenance",
          }),
        );
      if (order === "audit-first") {
        await audit();
        await remove();
      } else {
        await remove();
        await audit();
      }
      expect(await snapshot()).toEqual([
        {
          ...before[0],
          status: "manually-unlisted",
          last_action: "unlist",
          last_action_at: new Date(at),
          last_action_note: "Original provenance",
          last_action_by_user_id: "usr_ops",
          updated_at: new Date(at),
        },
        before[1],
        before[2],
      ]);
    },
  );

  it.each(["dismiss", "contact-seller"])(
    "delayed operator removal preserves newer %s at enforcement instant",
    async (action) => {
      const handlers = buildReportedContentProjectionHandlers(pools["platform-operations"]);
      await handlers["platform-operations.reported-content.action-recorded"]!(
        event("platform-operations.reported-content.action-recorded", {
          targetType: "listing",
          targetId: "lst_1",
          action,
          recordedAt: "2026-07-07T00:03:00.000Z",
          operatorUserId: "usr_new",
          note: "Newer provenance",
        }),
      );
      const before = await snapshot();
      await handlers["marketplace.listing.operator-unlisted"]!(
        event("marketplace.listing.operator-unlisted", { listingEnforcement }),
      );
      expect(await snapshot()).toEqual(before);
    },
  );

  it("absent listing removal never creates a report or changes another source row", async () => {
    const before = await snapshot();
    await buildReportedContentProjectionHandlers(pools["platform-operations"])[
      "marketplace.listing.operator-unlisted"
    ]!(event("marketplace.listing.operator-unlisted", { listingEnforcement }, "marketplace.listing-absent"));
    expect(await snapshot()).toEqual(before);
  });
});
