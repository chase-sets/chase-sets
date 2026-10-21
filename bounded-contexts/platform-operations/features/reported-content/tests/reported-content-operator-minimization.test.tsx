// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { Hono } from "hono";
import type { AuthenticatedApiEnv, ResolvedActor } from "@chase-sets/auth-context";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportedContentQueueDetail, ReportedContentQueueItem } from "../api/contracts";
import { createReportedContentRoutes } from "../api/http";
import { createReportedContentRuntime } from "../api/runtime";
import { ReportedContentAdminDetailPage, ReportedContentAdminListPage } from "../ui/admin-pages";

const reporterAccountMarker = "acc_PLANTED_REPORTER_ACCOUNT_10301";
const reporterKeyMarker = "visitor:PLANTED_REPORTER_KEY_10301";
const target = "acc_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const actor = Object.freeze({
  sessionId: "ses_minimization",
  tenantId: "tnt_minimization",
  userId: "usr_minimization",
  accountId: "acc_minimization",
  membershipId: "mbr_minimization",
  roleKey: "platform-admin",
  permissions: Object.freeze(["reported-content.view"]),
}) satisfies ResolvedActor;
const context = Object.freeze({
  tenantId: "tnt_minimization",
  audit: Object.freeze({ performedByUserId: actor.userId, forAccountId: actor.accountId }),
}) as EventStoreContext;

const item = {
  target_type: "account-profile",
  target_id: target,
  target_owner_account_id: target,
  status: "profile-display-name-redacted",
  report_count: 3,
  reasons: [{ reason: "impersonation-or-deception", count: 3 }],
  first_reported_at: "2026-10-21T02:00:00.000Z",
  last_reported_at: "2026-10-21T02:20:00.000Z",
  auto_unlisted_at: null,
  auto_unlist_report_id: null,
  auto_unlist_threshold: null,
  last_action: "redact-profile-display-name",
  last_action_at: "2026-10-21T02:30:00.000Z",
  last_action_note: "Display name impersonates a seller.",
  last_action_by_user_id: "usr_operator",
  updated_at: "2026-10-21T02:30:00.000Z",
} satisfies ReportedContentQueueItem;
// What the projection stores: reporter identifiers that must never leave the read model.
const storedReports = [
  ["rpt_1", "account:acc_first", "acc_first"],
  ["rpt_2", reporterKeyMarker, null],
  ["rpt_3", "account:acc_first", reporterAccountMarker],
].map(([reportId, reporterKey, reporterAccountId], index) => ({
  reportId,
  reporterKind: reporterAccountId ? "account" : "visitor",
  reporterKey,
  reporterAccountId,
  reporterUserId: "usr_PLANTED_REPORTER_USER_10301",
  reason: "impersonation-or-deception",
  details: index === 0 ? "Uses another seller's name." : null,
  submittedAt: `2026-10-21T02:${index}0:00.000Z`,
}));

function createApp() {
  const db = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("COUNT(*) AS count")) return { rows: [{ count: "1" }] };
      if (sql.includes("LIMIT")) return { rows: [item] };
      return { rows: [{ ...item, reports: storedReports }] };
    }),
  };
  const services = createReportedContentRuntime({
    db: db as unknown as PgQueryable,
    eventStore: { appendToStream: vi.fn() } as unknown as EventStore,
  });
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("context", context);
    await next();
  });
  app.route("/", createReportedContentRoutes(services));
  return { app, db };
}

function expectNoReporterIdentifiers(text: string) {
  for (const marker of ["PLANTED_REPORTER_ACCOUNT", "PLANTED_REPORTER_KEY", "PLANTED_REPORTER_USER", "acc_first"]) {
    expect(text).not.toContain(marker);
  }
  expect(text).not.toMatch(/reporterKey|reporterAccountId|reporterUserId/);
}

describe("reported-content-operator-minimization", () => {
  afterEach(() => {
    cleanup();
  });

  it("list output carries no reports and never selects them", async () => {
    const { app, db } = createApp();
    const response = await app.request("/");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(text).items).toEqual([item]);
    expect(JSON.parse(text).items[0]).not.toHaveProperty("reports");
    expectNoReporterIdentifiers(text);
    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toMatch(/\breports\b/);
    }
  });

  it("detail reports carry only the minimum reporter evidence and a distinct reporter count", async () => {
    const { app } = createApp();
    const response = await app.request(`/account-profile/${target}`);
    const text = await response.text();
    expect(response.status).toBe(200);
    const detail = JSON.parse(text) as ReportedContentQueueDetail;
    expect(detail.distinct_reporter_count).toBe(2);
    expect(detail.reports.map((report) => Object.keys(report).sort())).toEqual(
      storedReports.map(() => ["details", "reason", "reportId", "reporterKind", "submittedAt"]),
    );
    expectNoReporterIdentifiers(text);
  });

  it("admin pages render Account Profile targets and actions without reporter identifiers", () => {
    const leakyDetail = {
      ...item,
      distinct_reporter_count: 2,
      // A payload that still carried identifiers must not surface them.
      reports: storedReports,
    } as unknown as ReportedContentQueueDetail;
    const { container } = render(<ReportedContentAdminDetailPage item={leakyDetail} marketplaceOrigin={null} />);

    expect(screen.getAllByText(`Account profile ${target}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Profile display name redacted").length).toBeGreaterThan(0);
    expect(screen.getByText("Distinct reporters")).toBeTruthy();
    const form = container.querySelector("form[method='post']") as HTMLFormElement;
    expect(
      within(form)
        .getAllByRole("button")
        .map((button) => (button as HTMLButtonElement).value),
    ).toEqual(["dismiss", "contact-account", "redact-profile-display-name", "escalate-account-suspension"]);
    expect(screen.getAllByText(/Signed-in account at|Visitor at/)).toHaveLength(3);
    expect(screen.getByText(/redact display name/)).toBeTruthy();
    expect(screen.queryByText("Open marketplace target")).toBeNull();
    expectNoReporterIdentifiers(container.innerHTML);

    cleanup();
    const list = render(
      <ReportedContentAdminListPage
        queue={{ items: [item], total: 1, count: 1 }}
        metrics={{ total_count: 1, needs_review_count: 0, auto_unlisted_count: 0 }}
        filters={{ status: "all", targetType: "account-profile" }}
      />,
    );
    expect(screen.getAllByText("Account profile").length).toBeGreaterThan(0);
    expect(screen.getByText(`Account profile ${target}`)).toBeTruthy();
    expectNoReporterIdentifiers(list.container.innerHTML);
  });
});
