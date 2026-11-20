// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PolicyConsoleOverview } from "../api/contracts";
import { PolicyConsoleDetailPage } from "./policy-console-detail-page";

const overview: PolicyConsoleOverview = {
  policyKey: "settlement.clearance-window",
  contextName: "settlement",
  schemaSummary: "{ baseClearanceDays, extendedClearanceDays, highValueThresholdAmount }",
  current: {
    source: "policy",
    documentId: "pol_1",
    status: "active",
    value: { baseClearanceDays: 2, extendedClearanceDays: 7, highValueThresholdAmount: "250.00" },
    effectiveFrom: "2026-05-01T00:00:00.000Z",
    effectiveUntil: null,
  },
  upcoming: [
    {
      documentId: "pol_2",
      status: "active",
      value: { baseClearanceDays: 1, extendedClearanceDays: 5, highValueThresholdAmount: "500.00" },
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
    },
  ],
};

const history = [
  {
    history_id: "1",
    event_type: "platform-policy.document.created",
    actor_user_id: "usr_admin",
    status: "active",
    effective_from: "2026-05-01T00:00:00.000Z",
    effective_until: null,
    recorded_at: "2026-05-01T00:00:00.000Z",
  },
];

// The operator reads the page in Chicago.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  process.env.TZ = zone;
});

describe("policy console detail page", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the current value, upcoming schedule, and history without the revise form when the actor cannot manage", () => {
    render(<PolicyConsoleDetailPage overview={overview} history={history} canManage={false} />);

    expect(screen.getByText("settlement.clearance-window")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Publication and consent activation runbook" }).getAttribute("href")).toBe(
      "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/legal-corpus-publication.md",
    );
    expect(screen.getByText(/scheduled for/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save revision/i })).toBeNull();
    expect(screen.getAllByText("platform-policy.document.created").length).toBeGreaterThan(0);
  });

  it("renders the revise form and a submit error when the actor can manage", () => {
    render(<PolicyConsoleDetailPage overview={overview} history={history} canManage submitError="Bounds violated." />);

    expect(screen.getByRole("button", { name: /save revision/i })).toBeTruthy();
    expect(screen.getByText("Bounds violated.")).toBeTruthy();
  });

  it("writes effective and recorded times in the operator's zone, not raw ISO text", () => {
    render(<PolicyConsoleDetailPage overview={overview} history={history} canManage={false} />);

    expect(screen.getByText("Scheduled for Jul 31, 2026, 7:00 PM CDT")).toBeTruthy();
    expect(screen.getAllByText("Apr 30, 2026, 7:00 PM CDT").length).toBeGreaterThan(0);
    expect(screen.queryByText("2026-05-01T00:00:00.000Z")).toBeNull();
  });

  it("takes each effective time as the instant the operator's browser read", () => {
    const { container } = render(<PolicyConsoleDetailPage overview={overview} history={history} canManage />);

    for (const name of ["effectiveFrom", "effectiveUntil"]) {
      expect(container.querySelector<HTMLInputElement>(`input[name="${name}Local"]`)?.type).toBe("datetime-local");
      expect(container.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.type).toBe("hidden");
    }
  });
});
