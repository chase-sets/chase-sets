// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { PostagePolicyAdminViewModel } from "./contracts";
import { PostagePolicyListPage } from "./postage-policy-list-page";

const payload = {
  policyVersion: "operator-postage-v1",
  maxLetterUnits: 8,
  maxLetterWeightOunces: 3,
  maxLetterThicknessInches: 0.25,
  maxLetterDeclaredValueAmount: 100,
  letterEnvelopeWeightOunces: 0.2,
  parcelPackagingWeightOunces: 4,
  parcelRequiredShippingOptions: [],
  letterRequiredPhysicalFlags: [],
  parcelRequiredPhysicalFlags: [],
  signatureRequiredShippingOptions: [],
  signatureRequiredDeclaredValueAmount: null,
  signatureRequiredPhysicalFlags: [],
  insuranceRequiredDeclaredValueAmount: null,
} as const;

function policy(policyId: string, label: string, status: "active" | "draft" | "retired"): PostagePolicyAdminViewModel {
  return {
    policy_id: policyId,
    label,
    status,
    policy_version: payload.policyVersion,
    payload,
    effective_from: "2026-06-01T00:00:00.000Z",
    effective_until: null,
    activation_reason: status === "active" ? "Reviewed policy thresholds." : null,
    created_by_user_id: "usr_admin",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    activated_at: status === "active" ? "2026-06-02T00:00:00.000Z" : null,
    retired_at: status === "retired" ? "2026-06-03T00:00:00.000Z" : null,
    history: [
      {
        history_id: `${policyId}-created`,
        policy_id: policyId,
        event_type: "created",
        actor_user_id: "usr_admin",
        reason: null,
        status,
        policy_version: payload.policyVersion,
        payload,
        effective_from: "2026-06-01T00:00:00.000Z",
        effective_until: null,
        recorded_at: "2026-06-01T00:00:00.000Z",
      },
    ],
    activeComparison: status === "draft" ? [{ field: "maxLetterUnits", activeValue: "4", candidateValue: "8" }] : [],
  };
}

const activePolicy = policy("opp_active", "Current policy", "active");
const draftPolicy = policy("opp_draft", "Candidate policy", "draft");
const retiredPolicy = policy("opp_retired", "Archived policy", "retired");

function renderPage(selectedPolicy: PostagePolicyAdminViewModel | null = null) {
  const router = createMemoryRouter(
    [
      {
        path: "/commerce/postage-policies",
        element: (
          <PostagePolicyListPage items={[activePolicy, draftPolicy, retiredPolicy]} selectedPolicy={selectedPolicy} />
        ),
        action: async () => null,
      },
    ],
    {
      initialEntries: [
        selectedPolicy ? `/commerce/postage-policies?policy=${selectedPolicy.policy_id}` : "/commerce/postage-policies",
      ],
    },
  );
  return render(<RouterProvider router={router} />);
}

afterEach(cleanup);

describe("postage policy lifecycle home", () => {
  it("separates active policies, candidates awaiting activation, and the retired archive", () => {
    renderPage();

    const activeSection = screen.getByRole("heading", { name: "Active policies" }).closest("section");
    const candidateSection = screen.getByRole("heading", { name: "Drafts awaiting activation" }).closest("section");
    const retiredSection = screen.getByRole("heading", { name: "Retired archive" }).closest("section");

    expect(activeSection && within(activeSection).getAllByText("Current policy").length).toBeGreaterThan(0);
    expect(candidateSection && within(candidateSection).getAllByText("Candidate policy").length).toBeGreaterThan(0);
    expect(retiredSection && within(retiredSection).getAllByText("Archived policy").length).toBeGreaterThan(0);
  });

  it("renders selected policy state, shared comparison, plan preview, and history inside a detail drawer", () => {
    renderPage(draftPolicy);

    const drawer = screen.getByRole("dialog", { name: "Candidate policy" });
    expect(within(drawer).getAllByText("draft").length).toBeGreaterThan(0);
    expect(within(drawer).getByText("maxLetterUnits")).toBeTruthy();
    expect(within(drawer).getByText("Preview")).toBeTruthy();
    expect(within(drawer).getByText("History")).toBeTruthy();
    expect(within(drawer).getAllByText("created").length).toBeGreaterThan(0);
  });

  it("requires explicit confirmation before activation", async () => {
    const user = userEvent.setup();
    renderPage(draftPolicy);

    const drawer = screen.getByRole("dialog", { name: "Candidate policy" });
    await user.click(within(drawer).getByRole("button", { name: "Activate" }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Activate Candidate policy?" });
    expect(within(confirmation).getByText(/replace the currently active postage policy/i)).toBeTruthy();
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("requires explicit confirmation before retirement", async () => {
    const user = userEvent.setup();
    renderPage(activePolicy);

    const drawer = screen.getByRole("dialog", { name: "Current policy" });
    await user.click(within(drawer).getByRole("button", { name: "Retire" }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Retire Current policy?" });
    expect(
      within(confirmation).getByText(/removes this postage policy from future package-plan selection/i),
    ).toBeTruthy();
    expect(within(confirmation).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
