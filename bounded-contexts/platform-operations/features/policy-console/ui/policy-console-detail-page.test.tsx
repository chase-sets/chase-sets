// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
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

describe("policy console detail page", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the current value, upcoming schedule, and history without the revise form when the actor cannot manage", () => {
    render(<PolicyConsoleDetailPage overview={overview} history={history} canManage={false} />);

    expect(screen.getByText("settlement.clearance-window")).toBeTruthy();
    expect(screen.getByText(/scheduled for/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save revision/i })).toBeNull();
    expect(screen.getAllByText("platform-policy.document.created").length).toBeGreaterThan(0);
  });

  it("renders the revise form and a submit error when the actor can manage", () => {
    render(<PolicyConsoleDetailPage overview={overview} history={history} canManage submitError="Bounds violated." />);

    expect(screen.getByRole("button", { name: /save revision/i })).toBeTruthy();
    expect(screen.getByText("Bounds violated.")).toBeTruthy();
  });
});
