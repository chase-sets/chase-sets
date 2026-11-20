import { cleanup, render, screen } from "@testing-library/react";
import { matchRoutes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWebHostRouteRecords } from "@chase-sets/platform-runtime/web";
import { contextManifest } from "../../../index";
import type { ReportedContentQueueDetail, ReportedContentQueueItem } from "../api/contracts";
import { ReportedContentAdminDetailPage, ReportedContentAdminListPage } from "./admin-pages";
import { reportedContentQueuePath, reportedContentTargetPath } from "./admin-paths";

const adminRoutes = resolveWebHostRouteRecords(
  [
    {
      contextName: "platform-operations",
      packageName: "@chase-sets/platform-operations",
      manifest: contextManifest as Parameters<typeof resolveWebHostRouteRecords>[0][number]["manifest"],
    },
  ],
  "admin-web",
);

function servedBy(href: string) {
  const routes = adminRoutes.map((route) => ({ id: route.routeId, path: `/${route.routePath}` }));
  const matched = matchRoutes(routes, new URL(href, "https://admin.example").pathname);
  const route = adminRoutes.find((candidate) => candidate.routeId === matched?.at(-1)?.route.id);
  return route ? { routeId: route.routeId, section: route.section } : null;
}

const item: ReportedContentQueueItem = {
  severity: "standard",
  policy_revision: null,
  policy_code: null,
  response_started_at: null,
  acknowledged_at: null,
  acknowledge_due_at: null,
  disposition_due_at: null,
  accountable_role: "trust-and-safety",
  response_open: true,
  overdue: false,
  target_type: "listing",
  target_id: "lst/1",
  target_owner_account_id: null,
  status: "needs-review",
  report_count: 1,
  reasons: [{ reason: "counterfeit", count: 1 }],
  first_reported_at: "2026-11-19T10:00:00.000Z",
  last_reported_at: "2026-11-19T10:00:00.000Z",
  auto_unlisted_at: null,
  auto_unlist_report_id: null,
  auto_unlist_threshold: null,
  last_action: null,
  last_action_at: null,
  last_action_note: null,
  last_action_by_user_id: null,
  updated_at: "2026-11-19T10:00:00.000Z",
};

afterEach(() => cleanup());

describe("Reported Content admin paths", () => {
  it("names the queue and a target at the routes admin-web serves in its Support section", () => {
    expect(servedBy(reportedContentQueuePath)).toEqual({ routeId: expect.any(String), section: "support" });
    const target = servedBy(reportedContentTargetPath("listing", "lst/1"));
    expect(target).toEqual({ routeId: expect.any(String), section: "support" });
    expect(target?.routeId).not.toBe(servedBy(reportedContentQueuePath)?.routeId);
  });

  it("opens each queue row at its target's page", () => {
    render(
      <ReportedContentAdminListPage
        queue={{ items: [item], count: 1, total: 1 } as never}
        metrics={{ total_count: 1, needs_review_count: 1, auto_unlisted_count: 0 }}
        filters={{ status: "", targetType: "" }}
      />,
    );
    const opens = screen.getAllByRole("link", { name: "Open" });
    expect(opens.length).toBeGreaterThan(0);
    for (const open of opens) expect(open.getAttribute("href")).toBe("/support/reported-content/listing/lst%2F1");
  });

  it("goes back from a target to the queue", () => {
    const detail: ReportedContentQueueDetail = { ...item, reports: [], distinct_reporter_count: 1 };
    render(<ReportedContentAdminDetailPage item={detail} />);
    expect(screen.getByRole("link", { name: "Back" }).getAttribute("href")).toBe("/support/reported-content");
  });
});
