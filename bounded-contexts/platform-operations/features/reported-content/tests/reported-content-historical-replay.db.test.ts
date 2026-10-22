import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { reportedContentSchemaSql } from "../read-model/schema";
import {
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "../read-model/projection";
import {
  getReportedContentQueueItem,
  getReportedContentQueueMetrics,
  listReportedContentQueue,
} from "../read-model/queries";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for reported content historical replay in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

/** A canonical typed ULID whose last digits name the fixture. */
const id = (prefix: string, suffix: number | string) => `${prefix}_01HZ${String(suffix).padStart(22, "0")}`;
const l1 = id("lst", "A1");
const l2 = id("lst", "A2");
const l3 = id("lst", "A3");
const unqueued = id("lst", "A9");
const r1 = id("rev", "B1");
const seller = id("acc", "C1");
const buyer = id("acc", "C2");
const secondBuyer = id("acc", "C3");
const operator = id("usr", "D1");
const at = (minute: number, second = 0) =>
  `2026-07-08T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

function report(minute: number, targetType: "listing" | "review", targetId: string, reporter: string, reason: string) {
  const account = reporter.startsWith("acc_") ? reporter : null;
  return {
    type: "marketplace.report.submitted",
    streamId: `marketplace.report-${targetType}-${targetId}-${account ? `account:${account}` : reporter}`,
    recordedAt: at(minute),
    data: {
      reportId: id("rpt", minute),
      targetType,
      targetId,
      targetOwnerAccountId: seller,
      reporterKind: account ? "account" : "visitor",
      reporterKey: account ? `account:${account}` : reporter,
      reporterAccountId: account,
      reporterUserId: account ? id("usr", account.slice(-2)) : null,
      reason,
      details: account ? "Reported from the listing page." : null,
      sourceRoutePath: `/${targetType}s/${targetId}`,
      submittedAt: at(minute),
    },
  };
}

function action(minute: number, targetType: "listing" | "review", targetId: string, name: string, note: string | null) {
  return {
    type: "platform-operations.reported-content.action-recorded",
    streamId: `platform-operations.reported-content-${targetType}-${targetId}`,
    recordedAt: at(minute),
    data: {
      actionId: id("rca", minute),
      targetType,
      targetId,
      action: name,
      note,
      operatorUserId: operator,
      recordedAt: at(minute),
    },
  };
}

const enforcement = (source: string, sourceActionId: string, occurredAt: string) => ({
  version: 1,
  listingEnforcementActionId: id("lea", "E1"),
  accountId: seller,
  source,
  sourceActionId,
  occurredAt,
});

/** Every historical Listing and Review shape, in the global order the event store recorded them. */
const history = [
  report(0, "listing", l1, "visitor:anon_1", "counterfeit-concern"),
  report(1, "listing", l1, buyer, "stolen-photos"),
  report(2, "listing", l1, secondBuyer, "counterfeit-concern"),
  {
    type: "marketplace.listing.auto-unlisted",
    streamId: `marketplace.listing-${l1}`,
    recordedAt: at(2, 30),
    data: { reportId: id("rpt", 2), reportCount: 3, threshold: 3, autoUnlistedAt: at(2, 30) },
  },
  action(3, "listing", l1, "contact-seller", "Ask for purchase provenance."),
  report(4, "listing", l1, "visitor:anon_2", "misleading-condition"),
  action(5, "listing", l1, "dismiss", null),
  report(6, "listing", l2, buyer, "prohibited-item"),
  action(7, "listing", l2, "unlist", "Prohibited item."),
  {
    type: "marketplace.listing.operator-unlisted",
    streamId: `marketplace.listing-${l2}`,
    recordedAt: at(8),
    data: { listingEnforcement: enforcement("operator-unlist", id("rca", 7), at(8)) },
  },
  { ...report(6, "listing", l2, buyer, "prohibited-item"), recordedAt: at(9) },
  report(10, "review", r1, buyer, "other"),
  action(11, "review", r1, "withdraw-review", "Abusive language."),
  action(12, "review", r1, "redact-review-feedback", "PII in the text."),
  action(13, "review", r1, "escalate-account-suspension", "Repeated abuse."),
  report(14, "listing", l3, "visitor:anon_3", "counterfeit-concern"),
  {
    type: "marketplace.listing.auto-unlisted",
    streamId: `marketplace.listing-${l3}`,
    recordedAt: at(15),
    data: {
      reportId: id("rpt", 14),
      reportCount: 3,
      threshold: 3,
      autoUnlistedAt: at(15),
      listingEnforcement: enforcement("automatic-report-threshold", id("rpt", 14), at(15)),
    },
  },
  // The retired defect: an action accepted for a target no report had queued.
  action(16, "listing", unqueued, "dismiss", null),
];

/** Current-main `e47eb58d` projection output for `history`, captured row by row. */
const golden: unknown[] = [
  {
    target_type: "listing",
    target_id: "lst_01HZ00000000000000000000A1",
    target_owner_account_id: "acc_01HZ00000000000000000000C1",
    status: "dismissed",
    report_count: 4,
    reasons: [
      {
        count: 2,
        reason: "counterfeit-concern",
      },
      {
        count: 1,
        reason: "misleading-condition",
      },
      {
        count: 1,
        reason: "stolen-photos",
      },
    ],
    reports: [
      {
        reason: "counterfeit-concern",
        details: null,
        reportId: "rpt_01HZ0000000000000000000000",
        reporterKey: "visitor:anon_1",
        submittedAt: "2026-07-08T10:00:00.000Z",
        reporterKind: "visitor",
        reporterAccountId: null,
      },
      {
        reason: "stolen-photos",
        details: "Reported from the listing page.",
        reportId: "rpt_01HZ0000000000000000000001",
        reporterKey: "account:acc_01HZ00000000000000000000C2",
        submittedAt: "2026-07-08T10:01:00.000Z",
        reporterKind: "account",
        reporterAccountId: "acc_01HZ00000000000000000000C2",
      },
      {
        reason: "counterfeit-concern",
        details: "Reported from the listing page.",
        reportId: "rpt_01HZ0000000000000000000002",
        reporterKey: "account:acc_01HZ00000000000000000000C3",
        submittedAt: "2026-07-08T10:02:00.000Z",
        reporterKind: "account",
        reporterAccountId: "acc_01HZ00000000000000000000C3",
      },
      {
        reason: "misleading-condition",
        details: null,
        reportId: "rpt_01HZ0000000000000000000004",
        reporterKey: "visitor:anon_2",
        submittedAt: "2026-07-08T10:04:00.000Z",
        reporterKind: "visitor",
        reporterAccountId: null,
      },
    ],
    first_reported_at: "2026-07-08T10:00:00.000Z",
    last_reported_at: "2026-07-08T10:04:00.000Z",
    auto_unlisted_at: "2026-07-08T10:02:30.000Z",
    auto_unlist_report_id: "rpt_01HZ0000000000000000000002",
    auto_unlist_threshold: 3,
    last_action: "dismiss",
    last_action_at: "2026-07-08T10:05:00.000Z",
    last_action_note: null,
    last_action_by_user_id: "usr_01HZ00000000000000000000D1",
    updated_at: "2026-07-08T10:05:00.000Z",
  },
  {
    target_type: "listing",
    target_id: "lst_01HZ00000000000000000000A2",
    target_owner_account_id: "acc_01HZ00000000000000000000C1",
    status: "manually-unlisted",
    report_count: 1,
    reasons: [
      {
        count: 1,
        reason: "prohibited-item",
      },
    ],
    reports: [
      {
        reason: "prohibited-item",
        details: "Reported from the listing page.",
        reportId: "rpt_01HZ0000000000000000000006",
        reporterKey: "account:acc_01HZ00000000000000000000C2",
        submittedAt: "2026-07-08T10:06:00.000Z",
        reporterKind: "account",
        reporterAccountId: "acc_01HZ00000000000000000000C2",
      },
    ],
    first_reported_at: "2026-07-08T10:06:00.000Z",
    last_reported_at: "2026-07-08T10:06:00.000Z",
    auto_unlisted_at: null,
    auto_unlist_report_id: null,
    auto_unlist_threshold: null,
    last_action: "unlist",
    last_action_at: "2026-07-08T10:07:00.000Z",
    last_action_note: "Prohibited item.",
    last_action_by_user_id: "usr_01HZ00000000000000000000D1",
    updated_at: "2026-07-08T10:09:00.000Z",
  },
  {
    target_type: "listing",
    target_id: "lst_01HZ00000000000000000000A3",
    target_owner_account_id: "acc_01HZ00000000000000000000C1",
    status: "auto-unlisted",
    report_count: 1,
    reasons: [
      {
        count: 1,
        reason: "counterfeit-concern",
      },
    ],
    reports: [
      {
        reason: "counterfeit-concern",
        details: null,
        reportId: "rpt_01HZ0000000000000000000014",
        reporterKey: "visitor:anon_3",
        submittedAt: "2026-07-08T10:14:00.000Z",
        reporterKind: "visitor",
        reporterAccountId: null,
      },
    ],
    first_reported_at: "2026-07-08T10:14:00.000Z",
    last_reported_at: "2026-07-08T10:14:00.000Z",
    auto_unlisted_at: "2026-07-08T10:15:00.000Z",
    auto_unlist_report_id: "rpt_01HZ0000000000000000000014",
    auto_unlist_threshold: 3,
    last_action: null,
    last_action_at: null,
    last_action_note: null,
    last_action_by_user_id: null,
    updated_at: "2026-07-08T10:15:00.000Z",
  },
  {
    target_type: "review",
    target_id: "rev_01HZ00000000000000000000B1",
    target_owner_account_id: "acc_01HZ00000000000000000000C1",
    status: "suspension-escalated",
    report_count: 1,
    reasons: [
      {
        count: 1,
        reason: "other",
      },
    ],
    reports: [
      {
        reason: "other",
        details: "Reported from the listing page.",
        reportId: "rpt_01HZ0000000000000000000010",
        reporterKey: "account:acc_01HZ00000000000000000000C2",
        submittedAt: "2026-07-08T10:10:00.000Z",
        reporterKind: "account",
        reporterAccountId: "acc_01HZ00000000000000000000C2",
      },
    ],
    first_reported_at: "2026-07-08T10:10:00.000Z",
    last_reported_at: "2026-07-08T10:10:00.000Z",
    auto_unlisted_at: null,
    auto_unlist_report_id: null,
    auto_unlist_threshold: null,
    last_action: "escalate-account-suspension",
    last_action_at: "2026-07-08T10:13:00.000Z",
    last_action_note: "Repeated abuse.",
    last_action_by_user_id: "usr_01HZ00000000000000000000D1",
    updated_at: "2026-07-08T10:13:00.000Z",
  },
];

describeDb("reported-content-historical-replay", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"platform-operations">>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl!,
      ["platform-operations"],
      "reported_content_history",
    );
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools["platform-operations"].query(reportedContentSchemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  async function replay() {
    const db = pools["platform-operations"];
    const handlers = {
      ...buildMarketplaceReportedContentProjectionHandlers(db),
      ...buildPlatformOperationsReportedContentProjectionHandlers(db),
    };
    for (const [index, entry] of history.entries()) {
      await handlers[entry.type]!(
        buildTransportEvent(entry.type, entry.data, {
          id: `evt_history_${index}`,
          streamId: entry.streamId,
          globalPosition: String(index + 1),
          tenantId: "tnt_test",
          audit: { performedByUserId: operator, forAccountId: seller },
          timing: { occurredAt: entry.recordedAt, recordedAt: entry.recordedAt },
        }),
      );
    }
  }

  const queuedRows = async () =>
    JSON.parse(
      JSON.stringify(
        (
          await pools["platform-operations"].query(
            `SELECT * FROM platform_operations_reported_content_queue_pages
             WHERE report_count > 0
             ORDER BY target_type, target_id`,
          )
        ).rows,
      ),
    );

  it("every historical Listing and Review shape projects byte-identically to current main", async () => {
    await replay();
    expect(await queuedRows()).toEqual(golden);
  });

  it("the retired unqueued action stays invisible to every operator read", async () => {
    await replay();
    const db = pools["platform-operations"];
    const list = await listReportedContentQueue(db, { limit: 250 });
    expect(list.items.map((item) => `${item.target_type}:${item.target_id}`).sort()).toEqual(
      golden.map(
        (row) => `${(row as { target_type: string }).target_type}:${(row as { target_id: string }).target_id}`,
      ),
    );
    expect(list.total).toBe(golden.length);
    expect(await getReportedContentQueueItem(db, "listing", unqueued)).toBeNull();
    expect((await getReportedContentQueueMetrics(db)).total_count).toBe(golden.length);
  });

  it("replaying the history again changes nothing", async () => {
    await replay();
    const once = await queuedRows();
    await replay();
    expect(await queuedRows()).toEqual(once);
  });
});
