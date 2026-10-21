import { describe, expect, it, vi } from "vitest";
import {
  buildIdentityReportedContentProjectionHandlers,
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "./projection";

function buildReportedContentProjectionHandlers(db: ReturnType<typeof createDb>) {
  return {
    ...buildMarketplaceReportedContentProjectionHandlers(db),
    ...buildIdentityReportedContentProjectionHandlers(db),
    ...buildPlatformOperationsReportedContentProjectionHandlers(db),
  };
}

const latest = (...values: unknown[]) =>
  values
    .filter((value) => value !== null && value !== undefined)
    .map(String)
    .sort()
    .at(-1);

// An in-memory stand-in for the queue table that applies the projection's SQL guards;
// projection.db.test.ts and the lifecycle replay prove the same rules on PostgreSQL.
function createDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO") && sql.includes("last_action_note")) {
        const key = `${params[0]}:${params[1]}`;
        const existing = rows.get(key);
        const recordedAt = String(params[4]);
        if (!existing) {
          rows.set(key, {
            target_type: params[0],
            target_id: params[1],
            target_owner_account_id: null,
            status: params[2],
            report_count: 0,
            reasons: [],
            reports: [],
            first_reported_at: recordedAt,
            last_reported_at: recordedAt,
            auto_unlisted_at: null,
            auto_unlist_report_id: null,
            auto_unlist_threshold: null,
            last_action: params[3],
            last_action_at: recordedAt,
            last_action_note: params[5],
            last_action_by_user_id: params[6],
            updated_at: recordedAt,
          });
        } else if (existing.last_action_at === null || String(existing.last_action_at) <= recordedAt) {
          rows.set(key, {
            ...existing,
            status:
              existing.auto_unlisted_at === null || String(existing.auto_unlisted_at) <= recordedAt
                ? params[2]
                : existing.status,
            last_action: params[3],
            last_action_at: recordedAt,
            last_action_note: params[5],
            last_action_by_user_id: params[6],
            updated_at: latest(existing.updated_at, recordedAt),
          });
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO platform_operations_reported_content_queue_pages")) {
        const key = `${params[0]}:${params[1]}`;
        const existing = rows.get(key);
        const incomingReasons = JSON.parse(String(params[3]));
        const incomingReports = JSON.parse(String(params[4]));
        const existingReports = Array.isArray(existing?.reports) ? existing.reports : [];
        const existingReasons = Array.isArray(existing?.reasons) ? existing.reasons : [];
        const incomingReport = incomingReports[0];
        const isNewReport = !existingReports.some((entry) => entry?.reportId === incomingReport?.reportId);
        const reportless = existing?.report_count === 0;
        const reports = isNewReport
          ? [...existingReports, incomingReport].sort((left, right) =>
              left.submittedAt.localeCompare(right.submittedAt),
            )
          : existingReports;
        const reasonCounts = new Map<string, number>();
        for (const entry of existingReasons) reasonCounts.set(entry.reason, entry.count);
        if (isNewReport)
          reasonCounts.set(incomingReasons[0].reason, (reasonCounts.get(incomingReasons[0].reason) ?? 0) + 1);
        const reasons = [...reasonCounts.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
        rows.set(key, {
          target_type: params[0],
          target_id: params[1],
          target_owner_account_id: params[2] ?? existing?.target_owner_account_id ?? null,
          status: existing?.status ?? "needs-review",
          report_count: (existing?.report_count ?? 0) + (isNewReport ? 1 : 0),
          reasons,
          reports,
          first_reported_at: !existing || reportless ? params[5] : existing.first_reported_at,
          last_reported_at: !existing || reportless ? params[5] : latest(existing.last_reported_at, params[5]),
          updated_at: latest(existing?.updated_at, params[6]),
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
            updated_at: latest(existing.updated_at, params[1]),
          });
        }
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("auto_unlist_threshold = $4")) {
        const key = `listing:${params[0]}`;
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, {
            ...existing,
            status:
              existing.last_action_at === null || String(existing.last_action_at) <= String(params[1])
                ? "auto-unlisted"
                : existing.status,
            auto_unlisted_at: params[1],
            auto_unlist_report_id: params[2],
            auto_unlist_threshold: params[3],
            updated_at: latest(existing.updated_at, params[4]),
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

let actionSequence = 0;
function actionRecorded(data: Record<string, unknown>, streamId?: string) {
  actionSequence += 1;
  return event(
    "platform-operations.reported-content.action-recorded",
    { actionId: `rca_01ARZ3NDEKTSV4RRFFQ69G5F${String(actionSequence).padStart(2, "0")}`, ...data },
    streamId,
  );
}

function reportSubmitted(data: Record<string, unknown>, streamId?: string) {
  return event(
    "marketplace.report.submitted",
    { reporterUserId: null, sourceRoutePath: "/listings/lst_1", ...data },
    streamId,
  );
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
        reportSubmitted({
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

  it("operator removal alone sets manual visibility and preserves newer update time and provenance", async () => {
    const db = createDb();
    const handlers = await seed(db);
    db.rows.set("listing:lst_1", {
      ...db.rows.get("listing:lst_1"),
      updated_at: "2026-07-07T00:05:00.000Z",
      auto_unlisted_at: "2026-07-07T00:00:00.000Z",
      auto_unlist_report_id: "rpt_previous",
      auto_unlist_threshold: 3,
    });
    db.rows.set("review:lst_1", {
      ...db.rows.get("listing:lst_2"),
      target_type: "review",
      target_id: "lst_1",
      target_owner_account_id: "acc_review",
    });
    const before = [...db.rows.values()];
    expect(before[0]).toMatchObject({
      status: "needs-review",
      last_action: null,
      last_action_at: null,
      last_action_note: null,
      last_action_by_user_id: null,
    });

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

    expect([...db.rows.values()]).toEqual([{ ...before[0], status: "manually-unlisted" }, before[1], before[2]]);
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
        actionRecorded({
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
      actionRecorded({
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
      reportSubmitted({
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
      reportSubmitted({
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
      actionRecorded(
        {
          targetType: "listing",
          targetId: "lst_1",
          action: "contact-seller",
          note: "Ask for purchase provenance.",
          operatorUserId: "usr_ops",
          recordedAt: "2026-07-07T13:00:00.000Z",
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

  it("an action recorded before an automatic unlisting keeps its audit but not the status", async () => {
    const db = createDb();
    const handlers = await seed(db);
    await handlers["marketplace.listing.auto-unlisted"]!(
      event("marketplace.listing.auto-unlisted", automaticRemoval, "marketplace.listing-lst_1"),
    );
    await handlers["platform-operations.reported-content.action-recorded"]!(
      actionRecorded({
        targetType: "listing",
        targetId: "lst_1",
        action: "dismiss",
        note: null,
        operatorUserId: "usr_ops",
        recordedAt: "2026-07-07T00:01:00.000Z",
      }),
    );
    expect(db.rows.get("listing:lst_1")).toMatchObject({
      status: "auto-unlisted",
      last_action: "dismiss",
      last_action_at: "2026-07-07T00:01:00.000Z",
    });
  });

  it("maps review-scoped moderation actions to review-specific queue statuses (m108, #4269)", async () => {
    const db = createDb();
    const handlers = buildReportedContentProjectionHandlers(db);

    await handlers["marketplace.report.submitted"]!(
      reportSubmitted(
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

    for (const [action, note, recordedAt, status] of [
      ["withdraw-review", "Abusive language.", "2026-07-07T01:00:00.000Z", "review-withdrawn"],
      ["redact-review-feedback", "PII in the text.", "2026-07-07T02:00:00.000Z", "review-feedback-redacted"],
      ["withdraw-review-reply", "Reply contained PII.", "2026-07-07T03:00:00.000Z", "review-reply-withdrawn"],
    ]) {
      await handlers["platform-operations.reported-content.action-recorded"]!(
        actionRecorded(
          { targetType: "review", targetId: "rev_1", action, note, operatorUserId: "usr_ops", recordedAt },
          "platform-operations.reported-content-review-rev_1",
        ),
      );
      expect(db.rows.get("review:rev_1")).toMatchObject({ status, last_action: action, last_action_note: note });
    }
  });

  it("queues an Account Profile Report owned by the reported Account and maps its actions", async () => {
    const db = createDb();
    const handlers = buildReportedContentProjectionHandlers(db);
    const target = "acc_01BX5ZZKBKACTAV9WEVGEMMVRZ";
    await handlers["identity.account-profile.report-submitted"]!(
      event(
        "identity.account-profile.report-submitted",
        {
          version: 1,
          reportId: "rpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          targetType: "account-profile",
          targetId: target,
          reporterAccountId: "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          reason: "harassment-or-abuse",
          details: null,
          submittedAt: "2026-07-07T00:00:00.000Z",
        },
        `identity.account-profile-report-${target}`,
      ),
    );
    expect(db.rows.get(`account-profile:${target}`)).toMatchObject({
      status: "needs-review",
      target_owner_account_id: target,
      report_count: 1,
      reasons: [{ reason: "harassment-or-abuse", count: 1 }],
    });
    for (const [action, status, recordedAt] of [
      ["contact-account", "account-contact-requested", "2026-07-07T01:30:00.000Z"],
      ["redact-profile-display-name", "profile-display-name-redacted", "2026-07-07T02:30:00.000Z"],
    ]) {
      await handlers["platform-operations.reported-content.action-recorded"]!(
        actionRecorded({
          targetType: "account-profile",
          targetId: target,
          action,
          note: "Display name impersonates a seller.",
          operatorUserId: "usr_ops",
          recordedAt,
        }),
      );
      expect(db.rows.get(`account-profile:${target}`)).toMatchObject({ status, last_action: action });
    }
  });

  it.each([
    ["marketplace.report.submitted", { reportId: "rpt_1", targetType: "listing" }],
    ["identity.account-profile.report-submitted", { version: 2 }],
    ["platform-operations.reported-content.action-recorded", { targetType: "listing", action: "reopen" }],
    ["marketplace.listing.auto-unlisted", null],
  ])("a malformed %s poisons before any read or write", async (type, data) => {
    const db = createDb();
    const handlers = buildReportedContentProjectionHandlers(db);
    await expect(handlers[type]!(event(type, data as never, "marketplace.listing-lst_1"))).rejects.toThrow();
    expect(db.query).not.toHaveBeenCalled();
  });
});
