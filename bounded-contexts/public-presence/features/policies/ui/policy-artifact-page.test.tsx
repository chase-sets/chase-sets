import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { PolicyArtifactRouteAdapter, SellerAgreementRouteAdapter } from "./policy-artifact-route-adapter";

function renderSellerAgreementPage() {
  return render(
    <MemoryRouter>
      <SellerAgreementRouteAdapter />
    </MemoryRouter>,
  );
}

function publishedSellerAgreementArtifact(): PublicPolicyArtifact {
  return {
    ...sellerAgreementPolicyArtifact,
    metadata: {
      ...sellerAgreementPolicyArtifact.metadata,
      publicationStatus: "published",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      counselApprovalReference: "LEGAL-SELLER-TEST-2026-08-15",
      rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
    },
    sections: sellerAgreementPolicyArtifact.sections.map((section) => ({
      ...section,
      draftText: "Reviewed operative seller-agreement test copy.",
      reviewStatus: "counsel-approved" as const,
    })),
  };
}

describe("policy artifact page", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a counsel-pending corpus stub with machine metadata, banner, and placeholder scope", () => {
    const { container } = renderSellerAgreementPage();

    expect(screen.getByRole("heading", { level: 1, name: "Seller agreement" })).toBeTruthy();
    expect(screen.getByText("Counsel review required before this document takes effect")).toBeTruthy();
    expect(screen.getByText("Counsel-approved language required")).toBeTruthy();
    expect(screen.getByText(/Reserve the scope of the operative Chase Sets seller agreement/)).toBeTruthy();
    expect(screen.getByText("Effective date pending counsel approval")).toBeTruthy();

    const page = container.querySelector('[data-policy-key="seller-agreement"]');
    expect(page?.getAttribute("data-policy-version")).toBe("v1");
    expect(page?.getAttribute("data-policy-publication-status")).toBe("counsel-review-required");
    expect(page?.getAttribute("data-policy-effective-at")).toBe("");
  });

  it("never renders packet-only review-manifest fields on the public page", () => {
    const { container } = renderSellerAgreementPage();
    const text = container.textContent ?? "";

    for (const section of sellerAgreementPolicyArtifact.sections) {
      for (const openQuestion of section.reviewManifest.openQuestions) {
        expect(text).not.toContain(openQuestion);
      }
      for (const ref of section.reviewManifest.productTruthRefs) {
        expect(text).not.toContain(ref);
      }
      for (const assumption of section.reviewManifest.assumptions) {
        expect(text).not.toContain(assumption.assertion);
      }
    }
    expect(text).not.toContain("5687");
  });

  it("renders published posture through the real route adapter and shared page", () => {
    const artifact = publishedSellerAgreementArtifact();
    render(
      <MemoryRouter>
        <PolicyArtifactRouteAdapter artifact={artifact} eyebrow="Seller agreement" />
      </MemoryRouter>,
    );

    expect(screen.queryByText("Counsel review required before this document takes effect")).toBeNull();
    expect(screen.queryByText("Effective date pending counsel approval")).toBeNull();
    expect(screen.getByText("Effective date: 2026-09-01T00:00:00.000Z")).toBeTruthy();
    expect(screen.getByText("Reviewed operative seller-agreement test copy.")).toBeTruthy();
  });
});
