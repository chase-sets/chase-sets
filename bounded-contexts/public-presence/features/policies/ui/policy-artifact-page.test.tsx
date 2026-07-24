import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { agentConnectorTermsPolicyArtifact } from "../domain/agent-connector-terms";
import { authenticityServiceTermsPolicyArtifact } from "../domain/authenticity-service-terms";
import { resolveUnresolvedPublicDisclosureText } from "../domain/canonical-claims";
import { paymentsTermsPolicyArtifact } from "../domain/payments-terms";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import { termsOfServicePolicyArtifact, type TermsOfServicePolicyArtifact } from "../domain/terms-of-service";
import {
  AgentTermsRouteAdapter,
  AuthenticityTermsRouteAdapter,
  buildPolicyArtifactMeta,
  PaymentsTermsRouteAdapter,
  SellerAgreementRouteAdapter,
} from "./policy-artifact-route-adapter";
import { PolicyArtifactPage, resolvePolicyArtifactPublicationPosture } from "./policy-artifact-page";
import { TermsOfServiceRouteAdapter } from "./terms-of-service-route-adapter";

const publishedEffectiveAt = "2026-09-01T00:00:00.000Z";
const invalidEffectiveAts = ["not-a-date", "2026-09-01", "2026-09-01T00:00:00", "2026-02-31T00:00:00.000Z"] as const;

type PolicyArtifactPageProps = Parameters<typeof PolicyArtifactPage>[0];
const pageCopyIsNotInjectable: "copy" extends keyof PolicyArtifactPageProps ? false : true = true;

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

  it("does not expose a page-copy prop that lets route adapters pre-decide publication posture", () => {
    expect(pageCopyIsNotInjectable).toBe(true);
  });

  it("renders the Wallet's unresolved interest/deposit claim disclosures on the real /terms adapter, not a settled assertion", () => {
    const { container } = renderRouteAdapter((artifact) => (
      <TermsOfServiceRouteAdapter artifact={artifact as TermsOfServicePolicyArtifact | undefined} />
    ));
    const text = container.textContent ?? "";

    expect(text).toContain(resolveUnresolvedPublicDisclosureText("wallet-no-interest"));
    expect(text).toContain(resolveUnresolvedPublicDisclosureText("wallet-deposit-and-fdic-posture"));
    expect(text.toLowerCase()).not.toContain("do not earn interest");
    expect(text.toLowerCase()).not.toContain("insured by the fdic");
  });

  for (const route of policyRouteAdapters) {
    it(`fails closed on invalid effective timestamps through the real ${route.path} adapter and metadata builder`, () => {
      for (const effectiveAt of invalidEffectiveAts) {
        const artifact = {
          ...publishedArtifact(route.artifact),
          metadata: {
            ...publishedArtifact(route.artifact).metadata,
            effectiveAt,
          },
        } as PublicPolicyArtifact;
        const posture = resolvePolicyArtifactPublicationPosture(artifact);
        expect(posture).toEqual({ kind: "counsel-pending" });

        const { container } = renderRouteAdapter(route.render, artifact);
        expect(screen.getByText(route.pendingTitle)).toBeTruthy();
        const page = container.querySelector(`[data-policy-key="${route.artifact.metadata.policyKey}"]`);
        expect(page?.getAttribute("data-policy-publication-status")).toBe("counsel-review-required");
        expect(page?.getAttribute("data-policy-effective-at")).toBe("");

        const metadata = buildPolicyArtifactMeta(artifact, { title: "Test policy", description: "Test policy." });
        expect(metadata).toEqual(
          expect.arrayContaining([
            { name: "chase-sets:policy-publication-status", content: "counsel-review-required" },
          ]),
        );
        expect(metadata).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "chase-sets:policy-effective-at" })]),
        );
        cleanup();
      }
    });
  }

  for (const route of policyRouteAdapters) {
    it(`never renders packet-only review-manifest fields through the real ${route.path} adapter`, () => {
      const { container } = renderRouteAdapter(route.render);
      const text = container.textContent ?? "";

      for (const section of route.artifact.sections) {
        expect(text).not.toContain(section.reviewManifest.scopeNote);
        for (const openQuestion of section.reviewManifest.openQuestions) {
          expect(text).not.toContain(openQuestion);
        }
        for (const ref of section.reviewManifest.productTruthRefs) {
          expect(text).not.toContain(ref);
        }
        for (const assumption of section.reviewManifest.assumptions) {
          expect(text).not.toContain(assumption.assertion);
          expect(text).not.toContain(assumption.evidenceRef);
        }
        for (const decisionRef of section.reviewManifest.decisionRefs) {
          expect(text).not.toContain(String(decisionRef));
        }
      }
    });
  }
});
