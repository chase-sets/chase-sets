import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router";
import { agentConnectorTermsPolicyArtifact } from "../domain/agent-connector-terms";
import { authenticityServiceTermsPolicyArtifact } from "../domain/authenticity-service-terms";
import { resolveUnresolvedPublicDisclosureText } from "../domain/canonical-claims";
import { paymentsTermsPolicyArtifact } from "../domain/payments-terms";
import type { PublicPolicyArtifact } from "../domain/policy-artifact";
import { privacyPolicyArtifact } from "../domain/privacy-policy";
import { sellerAgreementPolicyArtifact } from "../domain/seller-agreement";
import { termsOfServicePolicyArtifact, type TermsOfServicePolicyArtifact } from "../domain/terms-of-service";
import {
  AgentTermsRouteAdapter,
  AuthenticityTermsRouteAdapter,
  buildPolicyArtifactMeta,
  buildPrivacyPolicyMeta,
  PaymentsTermsRouteAdapter,
  PrivacyPolicyRouteAdapter,
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
    path: "/privacy",
    artifact: privacyPolicyArtifact,
    pendingTitle: "Counsel review required before this document takes effect",
    render: (artifact?: PublicPolicyArtifact) => <PrivacyPolicyRouteAdapter artifact={artifact} />,
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

  it("renders every Privacy subject and its visible metadata from the canonical resolver on /privacy", () => {
    const { container } = renderRouteAdapter((artifact) => <PrivacyPolicyRouteAdapter artifact={artifact} />);
    const text = container.textContent ?? "";

    for (const section of privacyPolicyArtifact.sections) {
      expect(screen.getByRole("heading", { level: 2, name: section.title })).toBeTruthy();
      expect(text, section.id).toContain(section.draftText);
    }

    const page = container.querySelector('[data-policy-key="privacy-policy"]');
    expect(page?.getAttribute("data-policy-publication-status")).toBe("counsel-review-required");
    expect(page?.getAttribute("data-policy-effective-at")).toBe("");
    expect(buildPrivacyPolicyMeta()).toEqual(
      expect.arrayContaining([
        { name: "chase-sets:policy-key", content: "privacy-policy" },
        { name: "chase-sets:policy-publication-status", content: "counsel-review-required" },
      ]),
    );
    // /privacy stays indexable while pending: the notice must be findable, and
    // the page's own posture already says it is not effective.
    expect(buildPrivacyPolicyMeta()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "robots" })]));
  });

  it("direct-state bypass control: a published Privacy status without a valid effective time still renders pending", () => {
    const bypass: PublicPolicyArtifact = {
      ...privacyPolicyArtifact,
      metadata: {
        ...privacyPolicyArtifact.metadata,
        publicationStatus: "published",
        counselApprovalReference: "LEGAL-PRIVACY-TEST-2026-08-15",
        rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
      },
      sections: privacyPolicyArtifact.sections.map((section) => ({
        ...section,
        reviewStatus: "counsel-approved" as const,
      })),
    };
    expect(resolvePolicyArtifactPublicationPosture(bypass)).toEqual({ kind: "counsel-pending" });

    const { container } = renderRouteAdapter((artifact) => <PrivacyPolicyRouteAdapter artifact={artifact} />, bypass);
    expect(screen.getByText("Counsel review required before this document takes effect")).toBeTruthy();
    const page = container.querySelector('[data-policy-key="privacy-policy"]');
    expect(page?.getAttribute("data-policy-publication-status")).toBe("counsel-review-required");
    expect(page?.getAttribute("data-policy-effective-at")).toBe("");
    expect(buildPrivacyPolicyMeta(bypass)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "chase-sets:policy-effective-at" })]),
    );
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

  it("renders the authorized-agent responsibility and access-suspension disclosures on the real /terms adapter", () => {
    const { container } = renderRouteAdapter((artifact) => (
      <TermsOfServiceRouteAdapter artifact={artifact as TermsOfServicePolicyArtifact | undefined} />
    ));
    const text = container.textContent ?? "";

    const responsibilityDisclosure = resolveUnresolvedPublicDisclosureText(
      "authorized-agent-principal-responsibility-and-liability-boundary",
    );
    const suspensionDisclosure = resolveUnresolvedPublicDisclosureText(
      "agent-access-suspension-and-revocation-boundary",
    );

    expect(text).toContain(responsibilityDisclosure);
    expect(text).toContain(suspensionDisclosure);
    // The responsibility boundary is enrolled in two sections and renders
    // through both, from the one registry entry.
    expect(text.split(responsibilityDisclosure).length - 1).toBe(2);
    expect(text.split(suspensionDisclosure).length - 1).toBe(1);
  });

  it("renders neither retired agent-responsibility clause as public draft text on the real /terms adapter", () => {
    const { container } = renderRouteAdapter((artifact) => (
      <TermsOfServiceRouteAdapter artifact={artifact as TermsOfServicePolicyArtifact | undefined} />
    ));
    const text = (container.textContent ?? "").toLowerCase();

    expect(text).not.toContain("you remain responsible for actions your authorized agent takes");
    expect(text).not.toContain("and for all activity conducted through your account");
    for (const literal of [
      "you are fully responsible for",
      "you are solely responsible for",
      "is liable for all",
      "assumes all liability",
      "accepts full liability",
      "may suspend or revoke at any time",
      "at chase sets' sole discretion",
      "without notice or liability",
      "immediately terminate agent access",
      "reserves the right to revoke",
    ]) {
      expect(text, literal).not.toContain(literal);
    }
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
