// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  createMemoryRouter,
  RouterProvider,
  useActionData,
  type ActionFunction,
  type LoaderFunction,
} from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LISTING_EVIDENCE_LAUNCH_POLICY_VALUE } from "../domain/policy";
import type {
  ListingEvidencePolicyOverview,
  ListingEvidencePolicySelectorCatalog,
  ListingEvidencePolicyValidation,
} from "../api/runtime";
import { ListingEvidencePolicyPage } from "./listing-evidence-policy-page";

const overview: ListingEvidencePolicyOverview = {
  policyKey: "marketplace.listing-evidence",
  current: {
    policyId: "pol_active",
    version: 1,
    hash: "sha256:active",
    lifecycle: "active",
    effectiveFrom: "2026-07-13T00:00:00.000Z",
    effectiveUntil: null,
    value: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  },
  documents: [
    {
      policyId: "pol_active",
      version: 1,
      lifecycle: "active",
      status: "active",
      hash: "sha256:active",
      effectiveFrom: "2026-07-13T00:00:00.000Z",
      effectiveUntil: null,
      updatedAt: "2026-07-13T00:00:00.000Z",
    },
  ],
};

const overviewWithDrafts: ListingEvidencePolicyOverview = {
  ...overview,
  documents: [
    ...overview.documents,
    { ...overview.documents[0]!, policyId: "pol_draft", version: 2, lifecycle: "draft", status: "inactive" },
    { ...overview.documents[0]!, policyId: "pol_validated", version: 3, lifecycle: "validated", status: "inactive" },
  ],
};

const selectorCatalog: ListingEvidencePolicySelectorCatalog = {
  catalogItems: [{ id: "cat_1", label: "Charizard" }],
  products: [{ id: "prd_1", label: "Raw card" }],
  blueprints: [{ id: "bp_1", label: "Trading card" }],
  categories: [{ id: "category_1", label: "Pokémon" }],
  dimensions: [{ id: "condition", label: "Condition" }],
  options: [{ id: "mint", label: "Mint", parentId: "condition" }],
  gradedTraits: [{ id: "graded-item", label: "Graded item present" }],
  sellerRiskLevels: [{ id: "high", label: "High risk" }],
};

const validation: ListingEvidencePolicyValidation & { documentId: string; version: number } = {
  documentId: "pol_draft",
  version: 2,
  valid: true,
  diagnostics: [],
  policyHash: "sha256:draft",
  semanticDiff: { addedRuleIds: ["graded-item-views"], changedRuleIds: [], removedRuleIds: [] },
  impactPreview: {
    impactedListingCount: 14,
    sample: [{ listingId: "lst_1", beforeMatchedRuleIds: [], afterMatchedRuleIds: ["graded-item-views"] }],
    previewHash: "sha256:impact",
  },
};

afterEach(cleanup);

// The operator reads the page in Chicago.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/Chicago";
});
afterAll(() => {
  process.env.TZ = zone;
});

function renderPage(page: ReactElement, action?: ActionFunction, loader?: LoaderFunction) {
  const path = "/platform/listing-evidence-policy";
  const router = createMemoryRouter([{ path, element: page, action, loader }], { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

function renderPendingPage(error: string | null = null, loader?: LoaderFunction) {
  let answer!: (result: { error: string | null }) => void;
  const response = new Promise<{ error: string | null }>((resolve) => {
    answer = resolve;
  });
  const action = vi.fn(() => response);

  function Page() {
    const actionData = useActionData<{ error: string | null }>();
    return (
      <ListingEvidencePolicyPage
        overview={overviewWithDrafts}
        selectorCatalog={selectorCatalog}
        permissions={[
          "listing-evidence-policy.view",
          "listing-evidence-policy.draft",
          "listing-evidence-policy.validate",
          "listing-evidence-policy.activate",
        ]}
        validation={validation}
        error={actionData?.error}
      />
    );
  }

  renderPage(<Page />, action, loader);
  return { action, answer: () => act(async () => answer({ error })) };
}

function submitButton(intent: string, policyId?: string) {
  const buttons = screen.getAllByRole<HTMLButtonElement>("button");
  const button = buttons.find((button) => {
    if (button.type !== "submit" || !button.form) return false;
    return (
      button.form.querySelector<HTMLInputElement>('input[name="intent"]')?.value === intent &&
      button.form.querySelector<HTMLInputElement>('input[name="policyId"]')?.value === policyId
    );
  });
  expect(button, `submit button for ${intent}${policyId ? ` (${policyId})` : ""}`).toBeDefined();
  return button!;
}

function controlStates(button: HTMLButtonElement) {
  return Array.from(button.form!.querySelectorAll("button, input:not([type=hidden]), select, textarea"), (control) => ({
    name: control.getAttribute("name") ?? control.getAttribute("aria-label") ?? control.textContent,
    disabled: control.matches(":disabled"),
  }));
}

function expectControlsDisabled(button: HTMLButtonElement) {
  for (const { name, disabled } of controlStates(button)) {
    expect(disabled, name ?? undefined).toBe(true);
  }
}

async function clickSubmit(button: HTMLButtonElement) {
  await act(async () => button.click());
}

function acknowledgeActivationImpact() {
  fireEvent.change(screen.getByLabelText("Effective from"), { target: { value: "2026-12-01T12:00" } });
  fireEvent.click(screen.getByLabelText("I reviewed this Policy Impact Preview."));
}

describe("Listing Evidence Policy guided administration", () => {
  it("offers typed selectors and requirements without a raw policy JSON editor", () => {
    const { container } = renderPage(
      <ListingEvidencePolicyPage
        overview={overview}
        selectorCatalog={selectorCatalog}
        permissions={["listing-evidence-policy.view", "listing-evidence-policy.draft"]}
      />,
    );

    expect(screen.getByLabelText("Selector")).toBeTruthy();
    expect(screen.getByLabelText("Minimum photo count")).toBeTruthy();
    expect(screen.getByLabelText("Named evidence slots")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" })).toBeTruthy();
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("shows exact impact and an explicit confirmation gate only to activators", () => {
    renderPage(
      <ListingEvidencePolicyPage
        overview={overview}
        selectorCatalog={selectorCatalog}
        validation={validation}
        permissions={["listing-evidence-policy.view", "listing-evidence-policy.activate"]}
      />,
    );

    expect(screen.getByText("14 listings would receive changed requirements.")).toBeTruthy();
    expect(screen.getByLabelText("I reviewed this Policy Impact Preview.")).toBeTruthy();
    expect(screen.getByLabelText("Effective from")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activate policy version" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create draft" })).toBeNull();
  });

  it("shows the effective time in the operator's zone and takes new ones as instants", () => {
    const { container } = renderPage(
      <ListingEvidencePolicyPage
        overview={overview}
        selectorCatalog={selectorCatalog}
        validation={validation}
        permissions={["listing-evidence-policy.view", "listing-evidence-policy.activate"]}
      />,
    );

    expect(screen.getByText("Jul 12, 2026, 7:00 PM CDT")).toBeTruthy();
    expect(screen.queryByText("2026-07-13T00:00:00.000Z")).toBeNull();
    for (const name of ["effectiveFrom", "effectiveUntil"]) {
      expect(container.querySelector<HTMLInputElement>(`input[name="${name}Local"]`)?.type).toBe("datetime-local");
      expect(container.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.type).toBe("hidden");
    }
  });

  it("offers Validate again for a validated draft, so its Activate can be reached after a reload", () => {
    const { container } = renderPage(
      <ListingEvidencePolicyPage
        overview={overviewWithDrafts}
        selectorCatalog={selectorCatalog}
        permissions={["listing-evidence-policy.view", "listing-evidence-policy.validate"]}
      />,
    );

    const validated = Array.from(container.querySelectorAll('input[name="intent"][value="validate"]')).map(
      (intent) => intent.closest("form")?.querySelector<HTMLInputElement>('input[name="policyId"]')?.value,
    );
    expect(validated).toEqual(["pol_draft", "pol_validated"]);
    expect(screen.getAllByRole("button", { name: "Validate" })).toHaveLength(2);
  });

  it("shows an invalid draft's diagnostics without offering activation", () => {
    renderPage(
      <ListingEvidencePolicyPage
        overview={overview}
        selectorCatalog={selectorCatalog}
        validation={{
          ...validation,
          valid: false,
          diagnostics: [{ path: "rules[0].minimumPhotoCount", code: "minimum", message: "Must be at least 1." }],
        }}
        permissions={["listing-evidence-policy.view", "listing-evidence-policy.activate"]}
      />,
    );

    expect(screen.getByText("rules[0].minimumPhotoCount: Must be at least 1.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Activate policy version" })).toBeNull();
  });

  it.each([
    { intent: "create-draft", policyId: undefined },
    { intent: "validate", policyId: "pol_draft" },
    { intent: "activate", policyId: "pol_draft" },
    { intent: "reject", policyId: "pol_draft" },
    { intent: "rollback", policyId: "pol_active" },
  ])(
    "disables $intent controls, blocks a repeat activation, and re-enables after success",
    async ({ intent, policyId }) => {
      const { action, answer } = renderPendingPage();
      if (intent === "activate") acknowledgeActivationImpact();

      const button = submitButton(intent, policyId);
      const ready = controlStates(button);
      await clickSubmit(button);
      expect(action).toHaveBeenCalledTimes(1);
      const pendingButton = submitButton(intent, policyId);
      expectControlsDisabled(pendingButton);
      await clickSubmit(pendingButton);
      expect(action).toHaveBeenCalledTimes(1);

      await answer();
      expect(controlStates(submitButton(intent, policyId))).toEqual(ready);
    },
  );

  it.each([
    { intent: "create-draft", policyId: undefined },
    { intent: "validate", policyId: "pol_draft" },
    { intent: "activate", policyId: "pol_draft" },
  ])("re-enables $intent controls after an action error", async ({ intent, policyId }) => {
    const error = "Could not update the policy.";
    const { answer } = renderPendingPage(error);
    if (intent === "activate") acknowledgeActivationImpact();
    const button = submitButton(intent, policyId);
    const ready = controlStates(button);
    await clickSubmit(button);
    expectControlsDisabled(submitButton(intent, policyId));

    await answer();
    expect(screen.getByRole("alert").textContent).toBe(error);
    expect(controlStates(submitButton(intent, policyId))).toEqual(ready);
  });

  it("keeps create-draft controls disabled and takes no second submission while the page reloads after the action", async () => {
    let reload: Promise<null> | null = null;
    let finishReload!: () => void;
    const { action, answer } = renderPendingPage(null, () => reload);
    await screen.findByRole("button", { name: "Create draft" });
    reload = new Promise((resolve) => {
      finishReload = () => resolve(null);
    });
    const ready = controlStates(submitButton("create-draft"));

    await clickSubmit(submitButton("create-draft"));
    await answer();
    expectControlsDisabled(submitButton("create-draft"));
    await clickSubmit(submitButton("create-draft"));
    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => finishReload());
    expect(controlStates(submitButton("create-draft"))).toEqual(ready);
  });

  it("leaves forms with a different intent or policy ID enabled while validating a draft", async () => {
    const { answer } = renderPendingPage();
    const button = submitButton("validate", "pol_draft");
    const otherForms = () => [
      submitButton("validate", "pol_validated"),
      submitButton("reject", "pol_draft"),
      submitButton("create-draft"),
    ];
    const ready = controlStates(button);
    const otherReady = otherForms().map(controlStates);

    await clickSubmit(button);
    expectControlsDisabled(submitButton("validate", "pol_draft"));
    expect(otherForms().map(controlStates)).toEqual(otherReady);

    await answer();
    expect(controlStates(submitButton("validate", "pol_draft"))).toEqual(ready);
    expect(otherForms().map(controlStates)).toEqual(otherReady);
  });
});
