// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

describe("Listing Evidence Policy guided administration", () => {
  it("offers typed selectors and requirements without a raw policy JSON editor", () => {
    const { container } = render(
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
    render(
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
});
