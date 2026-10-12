import { describe, expect, it, vi } from "vitest";
import {
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "./projection";

function buildReportedContentProjectionHandlers(db: ReturnType<typeof createDb>) {
  return {
    ...buildMarketplaceReportedContentProjectionHandlers(db),
    ...buildPlatformOperationsReportedContentProjectionHandlers(db),
  };
}

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

      if (sql.includes("SET status = 'manually-unlisted'")) {
        const key = `listing:${params[0]}`;
        const existing = rows.get(key);
        if (existing && (existing.last_action_at === null || String(existing.last_action_at) <= String(params[1]))) {
          rows.set(key, {
            ...existing,
            status: "manually-unlisted",
            updated_at: [String(existing.updated_at), String(params[1])].sort().at(-1),
          });
        }
        return { rows: [], rowCount: 0 };
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
  const removalAt = "2026-07-07T00:02:00.000Z";
  const automaticRemoval = {
    reportId: "rpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    reportCount: 3,
    threshold: 3,
    autoUnlistedAt: removalAt,
  };
  const enforcement = {
    version: 1,
    listingEnforcementActionId: "lea_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    accountId: "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    source: "automatic-report-threshold",
    sourceActionId: automaticRemoval.reportId,
    occurredAt: removalAt,
  };
  async function seed(db: ReturnType<typeof createDb>) {
    const handlers = buildReportedContentProjectionHandlers(db);
    for (const [id, owner] of [
      ["lst_1", enforcement.accountId],
      ["lst_2", "acc_other"],
    ]) {
      await handlers["marketplace.report.submitted"]!(
        event("marketplace.report.submitted", {
          reportId: `report_${id}`,
          targetType: "listing",
          targetId: id,
          targetOwnerAccountId: owner,
          reporterKind: "visitor",
          reporterKey: "visitor:anon_1",
          reporterAccountId: null,
          reason: "counterfeit-concern",
          details: null,
          submittedAt: "2026-07-07T00:00:00.000Z",
        }),
      );
    }
    return handlers;
  }

  it("legacy-modern parity", async () => {
    // Immutable-base 43d1c261 automatic output, including the existing report enrichment only.
    for (const data of [automaticRemoval, { ...automaticRemoval, listingEnforcement: enforcement }]) {
      const db = createDb();
      const handlers = await seed(db);
      const before = { ...db.rows.get("listing:lst_1") };
      await handlers["marketplace.listing.auto-unlisted"]!(
        event("marketplace.listing.auto-unlisted", data, "marketplace.listing-lst_1"),
      );
      expect(db.rows.get("listing:lst_1")).toEqual({
        ...before,
        status: "auto-unlisted",
        auto_unlisted_at: removalAt,
        auto_unlist_report_id: automaticRemoval.reportId,
        auto_unlist_threshold: 3,
      });
    }
  });

  it.each(["audit-first", "removal-first"])("operator removal matches automatic visibility: %s", async (order) => {
    const db = createDb();
    const handlers = await seed(db);
    const before = { ...db.rows.get("listing:lst_1") };
    const other = { ...db.rows.get("listing:lst_2") };
    const remove = () =>
      handlers["marketplace.listing.operator-unlisted"]!(
        event(
          "marketplace.listing.operator-unlisted",
          {
            listingEnforcement: {
              ...enforcement,
              source: "operator-unlist",
              sourceActionId: "rca_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            },
          },
          "marketplace.listing-lst_1",
        ),
      );
    const audit = () =>
      handlers["platform-operations.reported-content.action-recorded"]!(
        event("platform-operations.reported-content.action-recorded", {
          targetType: "listing",
          targetId: "lst_1",
          action: "unlist",
          note: "Keep provenance",
          operatorUserId: "usr_ops",
          recordedAt: removalAt,
        }),
      );
    expect(before.status).toBe("needs-review");
    if (order === "audit-first") {
      await audit();
      await remove();
    } else {
      await remove();
      await audit();
    }
    expect(db.rows.get("listing:lst_1")).toEqual({
      ...before,
      status: "manually-unlisted",
      last_action: "unlist",
      last_action_at: removalAt,
      last_action_note: "Keep provenance",
      last_action_by_user_id: "usr_ops",
      updated_at: removalAt,
    });
    expect(db.rows.get("listing:lst_2")).toEqual(other);
  });

  it.each(["dismiss", "contact-seller"])("delayed operator removal preserves newer %s", async (action) => {
    const db = createDb();
    const handlers = await seed(db);
    await handlers["platform-operations.reported-content.action-recorded"]!(
      event("platform-operations.reported-content.action-recorded", {
        targetType: "listing",
        targetId: "lst_1",
        action,
        note: "Newer action",
        operatorUserId: "usr_new",
        recordedAt: "2026-07-07T00:03:00.000Z",
      }),
    );
    const before = { ...db.rows.get("listing:lst_1") };
    await handlers["marketplace.listing.operator-unlisted"]!(
      event(
        "marketplace.listing.operator-unlisted",
        {
          listingEnforcement: {
            ...enforcement,
            source: "operator-unlist",
            sourceActionId: "rca_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          },
        },
        "marketplace.listing-lst_1",
      ),
    );
    expect(db.rows.get("listing:lst_1")).toEqual(before);
    expect(db.query).toHaveBeenLastCalledWith(
      expect.stringContaining("AND (last_action_at IS NULL OR last_action_at <= $2::timestamptz)"),
      ["lst_1", removalAt],
    );
  });

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
