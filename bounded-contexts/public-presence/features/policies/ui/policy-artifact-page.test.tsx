import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { agentConnectorTermsPolicyArtifact } from "../domain/agent-connector-terms";
import { authenticityServiceTermsPolicyArtifact } from "../domain/authenticity-service-terms";
import { paymentsTermsPolicyArtifact } from "../domain/payments-terms";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import { termsOfServicePolicyArtifact, type TermsOfServicePolicyArtifact } from "../domain/terms-of-service";
import {
  AgentTermsRouteAdapter,
  AuthenticityTermsRouteAdapter,
  PaymentsTermsRouteAdapter,
  SellerAgreementRouteAdapter,
} from "./policy-artifact-route-adapter";
import { resolvePolicyArtifactPublicationPosture } from "./policy-artifact-page";
import { TermsOfServiceRouteAdapter } from "./terms-of-service-route-adapter";

const publishedEffectiveAt = "2026-09-01T00:00:00.000Z";

const policyRouteAdapters = [
  {
    path: "/terms",
    artifact: termsOfServicePolicyArtifact,
    pendingTitle: "Counsel review required before these terms take effect",
    render: (artifact?: PublicPolicyArtifact) => (
      <TermsOfServiceRouteAdapter artifact={artifact as TermsOfServicePolicyArtifact | undefined} />
    ),
  },
  {
    path: "/seller-agreement",
    artifact: sellerAgreementPolicyArtifact,
    pendingTitle: "Counsel review required before this document takes effect",
    render: (artifact?: PublicPolicyArtifact) => <SellerAgreementRouteAdapter artifact={artifact} />,
  },
  {
    path: "/payments-terms",
    artifact: paymentsTermsPolicyArtifact,
    pendingTitle: "Counsel review required before this document takes effect",
    render: (artifact?: PublicPolicyArtifact) => <PaymentsTermsRouteAdapter artifact={artifact} />,
  },
  {
    path: "/agent-terms",
    artifact: agentConnectorTermsPolicyArtifact,
    pendingTitle: "Counsel review required before this document takes effect",
    render: (artifact?: PublicPolicyArtifact) => <AgentTermsRouteAdapter artifact={artifact} />,
  },
  {
    path: "/authenticity-terms",
    artifact: authenticityServiceTermsPolicyArtifact,
    pendingTitle: "Counsel review required before this document takes effect",
    render: (artifact?: PublicPolicyArtifact) => <AuthenticityTermsRouteAdapter artifact={artifact} />,
  },
] as const;

function renderRouteAdapter(
  renderAdapter: (artifact?: PublicPolicyArtifact) => React.ReactNode,
  artifact?: PublicPolicyArtifact,
) {
  return render(<MemoryRouter>{renderAdapter(artifact)}</MemoryRouter>);
}

function publishedArtifact(artifact: PublicPolicyArtifact): PublicPolicyArtifact {
  return {
    ...artifact,
    metadata: {
      ...artifact.metadata,
      publicationStatus: "published",
      effectiveAt: publishedEffectiveAt,
      counselApprovalReference: `LEGAL-${artifact.metadata.policyKey.toUpperCase()}-TEST-2026-08-15`,
      rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
    },
    sections: artifact.sections.map((section) => ({
      ...section,
      draftText: `Reviewed operative ${artifact.metadata.policyKey} test copy.`,
      reviewStatus: "counsel-approved" as const,
    })),
  };
}

describe("policy artifact page", () => {
  afterEach(() => {
    cleanup();
  });

  for (const route of policyRouteAdapters) {
    it(`preserves counsel-pending posture through the real ${route.path} adapter`, () => {
      const { container } = renderRouteAdapter(route.render);

      expect(screen.getByRole("heading", { level: 1, name: route.artifact.title })).toBeTruthy();
      expect(screen.getByText(route.pendingTitle)).toBeTruthy();
      expect(screen.getByText("Effective date pending counsel approval")).toBeTruthy();

      const page = container.querySelector(`[data-policy-key="${route.artifact.metadata.policyKey}"]`);
      expect(page?.getAttribute("data-policy-version")).toBe("v1");
      expect(page?.getAttribute("data-policy-publication-status")).toBe("counsel-review-required");
      expect(page?.getAttribute("data-policy-effective-at")).toBe("");
    });

    it(`renders published posture through the real ${route.path} adapter`, () => {
      const artifact = publishedArtifact(route.artifact);
      const { container } = renderRouteAdapter(route.render, artifact);

      expect(screen.queryByText(route.pendingTitle)).toBeNull();
      expect(screen.queryByText("Effective date pending counsel approval")).toBeNull();
      expect(screen.getByText(`Effective date: ${publishedEffectiveAt}`)).toBeTruthy();
      expect(screen.getAllByText(`Reviewed operative ${route.artifact.metadata.policyKey} test copy.`).length).toBe(
        route.artifact.sections.length,
      );

      const page = container.querySelector(`[data-policy-key="${route.artifact.metadata.policyKey}"]`);
      expect(page?.getAttribute("data-policy-publication-status")).toBe("published");
      expect(page?.getAttribute("data-policy-effective-at")).toBe(publishedEffectiveAt);
    });
  }

  it("fails closed when published posture has no effective timestamp", () => {
    expect(() =>
      resolvePolicyArtifactPublicationPosture({
        ...sellerAgreementPolicyArtifact,
        metadata: {
          ...sellerAgreementPolicyArtifact.metadata,
          publicationStatus: "published",
          effectiveAt: null,
        },
      }),
    ).toThrow("requires an effectiveAt timestamp");
  });

  it("never renders packet-only review-manifest fields on the public page", () => {
    const { container } = renderRouteAdapter(policyRouteAdapters[1].render);
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
});
