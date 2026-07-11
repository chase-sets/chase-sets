import { describe, expect, it, vi } from "vitest";
import { buildReportedContentProjectionHandlers } from "./projection";

function createDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("SELECT reasons, reports")) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        return { rows: row ? [{ reasons: row.reasons, reports: row.reports }] : [] };
      }

      if (sql.includes("INSERT INTO platform_operations_reported_content_queue_pages")) {
        const key = `${params[0]}:${params[1]}`;
        const existing = rows.get(key);
        rows.set(key, {
          target_type: params[0],
          target_id: params[1],
          target_owner_account_id: params[2] ?? existing?.target_owner_account_id ?? null,
          status: existing?.status ?? "needs-review",
          report_count: params[3],
          reasons: JSON.parse(String(params[4])),
          reports: JSON.parse(String(params[5])),
          first_reported_at: existing?.first_reported_at ?? params[6],
          last_reported_at: params[6],
          updated_at: params[7],
          auto_unlisted_at: existing?.auto_unlisted_at ?? null,
          auto_unlist_report_id: existing?.auto_unlist_report_id ?? null,
          auto_unlist_threshold: existing?.auto_unlist_threshold ?? null,
          last_action: existing?.last_action ?? null,
          last_action_at: existing?.last_action_at ?? null,
          last_action_note: existing?.last_action_note ?? null,
          last_action_by_user_id: existing?.last_action_by_user_id ?? null,
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("last_action")) {
        const key = `${params[0]}:${params[1]}`;
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, {
            ...existing,
            status: params[2],
            last_action: params[3],
            last_action_at: params[4],
            last_action_note: params[5],
            last_action_by_user_id: params[6],
            updated_at: params[4],
          });
        }
        return { rows: [], rowCount: existing ? 1 : 0 };
      }

      if (sql.includes("UPDATE platform_operations_reported_content_queue_pages")) {
        const key = `listing:${params[0]}`;
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, {
            ...existing,
            status: "auto-unlisted",
            auto_unlisted_at: params[1],
            auto_unlist_report_id: params[2],
            auto_unlist_threshold: params[3],
            updated_at: params[4],
          });
        }
        return { rows: [], rowCount: existing ? 1 : 0 };
      }

      throw new Error(`Unexpected query: ${sql}`);
    }),
    rows,
  };

  return db;
}

function event(type: string, data: Record<string, unknown>, streamId = "marketplace.report-listing-lst_1") {
  return {
    type,
    data,
    streamId,
    globalPosition: "1",
    timing: { recordedAt: "2026-07-07T00:00:00.000Z" },
  } as never;
}

describe("reported content projection", () => {
  it("groups reports by target and marks the queue item auto-unlisted", async () => {
    const db = createDb();
    const handlers = buildReportedContentProjectionHandlers(db);

    await handlers["marketplace.report.submitted"]!(
      event("marketplace.report.submitted", {
        reportId: "rpt_1",
        targetType: "listing",
        targetId: "lst_1",
        targetOwnerAccountId: "acc_seller",
        reporterKind: "visitor",
        reporterKey: "visitor:anon_1",
        reporterAccountId: null,
        reason: "counterfeit-concern",
        details: null,
        submittedAt: "2026-07-07T00:00:00.000Z",
      }),
    );
    await handlers["marketplace.report.submitted"]!(
      event("marketplace.report.submitted", {
        reportId: "rpt_2",
        targetType: "listing",
        targetId: "lst_1",
        targetOwnerAccountId: "acc_seller",
        reporterKind: "account",
        reporterKey: "account:acc_buyer",
        reporterAccountId: "acc_buyer",
        reason: "stolen-photos",
        details: "Wrong photo.",
        submittedAt: "2026-07-07T00:01:00.000Z",
      }),
    );
    await handlers["marketplace.listing.auto-unlisted"]!(
      event(
        "marketplace.listing.auto-unlisted",
        {
          reportId: "rpt_2",
          reportCount: 3,
          threshold: 3,
          autoUnlistedAt: "2026-07-07T00:02:00.000Z",
        },
        "marketplace.listing-lst_1",
      ),
    );

    expect(db.rows.get("listing:lst_1")).toMatchObject({
      status: "auto-unlisted",
      report_count: 2,
      auto_unlist_report_id: "rpt_2",
      auto_unlist_threshold: 3,
    });
    expect(db.rows.get("listing:lst_1")?.reports).toHaveLength(2);
    expect(db.rows.get("listing:lst_1")?.reasons).toEqual([
      { reason: "counterfeit-concern", count: 1 },
      { reason: "stolen-photos", count: 1 },
    ]);

    await handlers["platform-operations.reported-content.action-recorded"]!(
      event(
        "platform-operations.reported-content.action-recorded",
        {
          targetType: "listing",
          targetId: "lst_1",
          action: "contact-seller",
          note: "Ask for purchase provenance.",
          operatorUserId: "usr_ops",
          recordedAt: "2026-07-05T13:00:00.000Z",
        },
        "platform-operations.reported-content-listing-lst_1",
      ),
    );

    expect(db.rows.get("listing:lst_1")).toMatchObject({
      status: "seller-contact-requested",
      last_action: "contact-seller",
      last_action_note: "Ask for purchase provenance.",
      last_action_by_user_id: "usr_ops",
    });
  });

  it("maps review-scoped moderation actions to review-specific queue statuses (m108, #4269)", async () => {
    const db = createDb();
    const handlers = buildReportedContentProjectionHandlers(db);

    await handlers["marketplace.report.submitted"]!(
      event(
        "marketplace.report.submitted",
        {
          reportId: "rpt_1",
          targetType: "review",
          targetId: "rev_1",
          targetOwnerAccountId: "acc_seller",
          reporterKind: "account",
          reporterKey: "account:acc_buyer",
          reporterAccountId: "acc_buyer",
          reason: "other",
          details: "Abusive language in the feedback.",
          submittedAt: "2026-07-07T00:00:00.000Z",
        },
        "marketplace.report-review-rev_1-account:acc_buyer",
      ),
    );

    await handlers["platform-operations.reported-content.action-recorded"]!(
      event(
        "platform-operations.reported-content.action-recorded",
        {
          targetType: "review",
          targetId: "rev_1",
          action: "withdraw-review",
          note: "Abusive language.",
          operatorUserId: "usr_ops",
          recordedAt: "2026-07-07T01:00:00.000Z",
        },
        "platform-operations.reported-content-review-rev_1",
      ),
    );

    expect(db.rows.get("review:rev_1")).toMatchObject({
      status: "review-withdrawn",
      last_action: "withdraw-review",
      last_action_note: "Abusive language.",
    });

    await handlers["platform-operations.reported-content.action-recorded"]!(
      event(
        "platform-operations.reported-content.action-recorded",
        {
          targetType: "review",
          targetId: "rev_1",
          action: "redact-review-feedback",
          note: "PII in the text.",
          operatorUserId: "usr_ops",
          recordedAt: "2026-07-07T02:00:00.000Z",
        },
        "platform-operations.reported-content-review-rev_1",
      ),
    );

    expect(db.rows.get("review:rev_1")).toMatchObject({ status: "review-feedback-redacted" });

    await handlers["platform-operations.reported-content.action-recorded"]!(
      event(
        "platform-operations.reported-content.action-recorded",
        {
          targetType: "review",
          targetId: "rev_1",
          action: "withdraw-review-reply",
          note: "Reply contained PII.",
          operatorUserId: "usr_ops",
          recordedAt: "2026-07-07T03:00:00.000Z",
        },
        "platform-operations.reported-content-review-rev_1",
      ),
    );

    expect(db.rows.get("review:rev_1")).toMatchObject({ status: "review-reply-withdrawn" });
  });
});
