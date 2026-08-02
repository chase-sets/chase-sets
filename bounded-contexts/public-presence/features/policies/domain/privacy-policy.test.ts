import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateCanonicalClaimConsistency } from "./canonical-claim-guard";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
  type PublicPolicyArtifact,
} from "./policy-artifact";
import { type PublicPolicyRegistryEntry } from "./policy-registry";
import { privacyPolicyArtifact, requiredPrivacyPolicySubjectIds } from "./privacy-policy";

const domainDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(domainDirectory, "../../../../..");

const requiredEvidenceBySubject: Readonly<Record<string, readonly string[]>> = {
  "privacy-notice-scope": ["features/policies/domain/policy-registry.ts:25-33"],
  "data-categories-and-sources": [
    "auth/features/registration/ui/register-page.tsx:60-66",
    "auth/support/social-login-support/providers.ts:146-207",
    "public-presence/features/waitlist/domain/common.ts:27-50",
  ],
  "purposes-of-use": ["auth/support/api-support/registration-gates.ts:4-25"],
  "recipients-and-disclosures": [
    "auth/support/social-login-support/providers.ts:146-207",
    "infrastructure/stripe-payments/index.ts:1464-1494",
  ],
  "stripe-managed-processing": ["docs/adr/0006-stripe-connect-custom-account-experience.md:58-64"],
  "cookies-and-analytics": [
    "auth/support/request-support/cookies.ts:1-3",
    "checkout/support/request-support/guest-checkout.ts:3-5",
    "collections/features/saved-lists/api/anonymous-cookie.ts:3",
    "discovery/support/request-support/anonymous-product-alert.ts:3",
    "marketplace/support/request-support/anonymous-listing-draft.ts:3-4",
    "identity/features/preferences/api/color-mode-cookie.ts:3",
    "discovery/features/search/ui/header-search.tsx:173-205",
    "marketplace/features/reviews/ui/review-submission-page.tsx:101-161",
    "packages/design-system/src/theme/theme-toggle.tsx:51-70",
    "public-presence/docs/landing-page-analytics.md:27-34",
  ],
  "gpc-and-sale-share": ["public-presence/docs/landing-page-analytics.md:5"],
  "privacy-rights-and-requests": ["platform-operations/features/support-requests/domain/common.ts:5-30"],
  retention: ["customer-feedback/features/privacy/domain/policy.ts:55-105"],
  children: ["features/policies/domain/terms-of-service.ts:345"],
  "state-supplements": [],
  "automated-decisionmaking-technology": ["settlement/features/wallets/domain/clearance-policy.ts:15-18"],
};

function privacyPolicyViolations(artifact: PublicPolicyArtifact): readonly string[] {
  const violations: string[] = [];
  const sections = new Map(artifact.sections.map((section) => [section.id, section]));

  if (artifact.sections.map((section) => section.id).join("|") !== requiredPrivacyPolicySubjectIds.join("|")) {
    violations.push("required subject taxonomy changed");
  }

  for (const subjectId of requiredPrivacyPolicySubjectIds) {
    const section = sections.get(subjectId);
    if (!section) continue;
    if (section.draftText.trim().length === 0) violations.push(`${subjectId}: blank draft`);
    if (section.reviewStatus !== "counsel-required") violations.push(`${subjectId}: counsel ownership changed`);
    if (section.reviewManifest.openQuestions.length === 0) violations.push(`${subjectId}: no counsel question`);
    for (const requiredRef of requiredEvidenceBySubject[subjectId] ?? []) {
      if (!section.reviewManifest.productTruthRefs.some((ref) => ref.includes(requiredRef))) {
        violations.push(`${subjectId}: missing discriminating product evidence ${requiredRef}`);
      }
    }
  }

  const gpc = sections.get("gpc-and-sale-share")?.draftText ?? "";
  if (!gpc.includes("[SALE-SHARE-AND-GPC-STATEMENT:")) violations.push("sale/share conclusion is not reserved");
  if (/Chase Sets does not (?:sell|share) personal information/i.test(gpc)) {
    violations.push("sale/share conclusion asserted as settled");
  }

  const stripe = sections.get("stripe-managed-processing")?.draftText ?? "";
  if (/\b(?:full|recipient) (?:connected account )?service agreement\b/i.test(stripe)) {
    violations.push("Stripe agreement type asserted");
  }

  const admt = sections.get("automated-decisionmaking-technology")?.draftText ?? "";
  if (!admt.includes("became effective on January 1, 2026")) violations.push("ADMT effective date changed");
  if (!admt.includes("begins on January 1, 2027 for businesses whose use")) {
    violations.push("ADMT compliance start or in-scope qualification changed");
  }
  if (!admt.includes("[ADMT-APPLICABILITY:")) violations.push("ADMT applicability is not reserved");
  if (/ADMT (?:rules|regulations|requirements) apply to Chase Sets/i.test(admt)) {
    violations.push("ADMT applicability asserted");
  }
  if (!admt.includes("does not currently use card-scanning or image-recognition technology")) {
    violations.push("unshipped #4929 scanning described as current");
  }

  return violations;
}

function productionTypeScriptFilesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "tests" || entry.name === "__tests__") return [];
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFilesUnder(entryPath);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
      return [];
    }
    return [entryPath];
  });
}

let shippedCookieNameCache: readonly string[] | undefined;

function shippedCookieNames(): readonly string[] {
  if (shippedCookieNameCache) return shippedCookieNameCache;
  const names = productionTypeScriptFilesUnder(resolve(repoRoot, "bounded-contexts")).flatMap((sourcePath) =>
    Array.from(
      readFileSync(sourcePath, "utf8").matchAll(
        /\bexport const [A-Z0-9_]*COOKIE_NAME\s*=\s*["'](chase_sets_[a-z0-9_]+)["']/g,
      ),
      (match) => match[1],
    ),
  );
  shippedCookieNameCache = Array.from(new Set(names)).sort();
  return shippedCookieNameCache;
}

let shippedSocialLoginProviderNameCache: readonly string[] | undefined;

function shippedSocialLoginProviderNames(): readonly string[] {
  if (shippedSocialLoginProviderNameCache) return shippedSocialLoginProviderNameCache;
  const registrySource = readFileSync(
    resolve(repoRoot, "bounded-contexts/auth/support/social-login-support/providers.ts"),
    "utf8",
  );
  shippedSocialLoginProviderNameCache = Array.from(
    new Set(Array.from(registrySource.matchAll(/\bproviderName:\s*["']([a-z0-9-]+)["']/g), (match) => match[1])),
  ).sort();
  return shippedSocialLoginProviderNameCache;
}

function sectionDraftText(artifact: PublicPolicyArtifact, sectionId: string): string {
  return artifact.sections.find((section) => section.id === sectionId)?.draftText ?? "";
}

function missingShippedCookieDisclosures(artifact: PublicPolicyArtifact): readonly string[] {
  const disclosure = sectionDraftText(artifact, "cookies-and-analytics");
  return shippedCookieNames().filter((cookieName) => !disclosure.includes(cookieName));
}

function missingSocialLoginProviderDisclosures(artifact: PublicPolicyArtifact): readonly string[] {
  const sources = sectionDraftText(artifact, "data-categories-and-sources").toLowerCase();
  const recipients = sectionDraftText(artifact, "recipients-and-disclosures").toLowerCase();
  return shippedSocialLoginProviderNames().flatMap((providerName) => [
    ...(sources.includes(providerName) ? [] : [`sources:${providerName}`]),
    ...(recipients.includes(providerName) ? [] : [`recipients:${providerName}`]),
  ]);
}

function withSection(
  sectionId: string,
  mutate: (section: PublicPolicyArtifact["sections"][number]) => PublicPolicyArtifact["sections"][number],
): PublicPolicyArtifact {
  return {
    ...privacyPolicyArtifact,
    sections: privacyPolicyArtifact.sections.map((section) => (section.id === sectionId ? mutate(section) : section)),
  };
}

function approvedPrivacyArtifact(): PublicPolicyArtifact {
  return {
    ...privacyPolicyArtifact,
    metadata: {
      ...privacyPolicyArtifact.metadata,
      publicationStatus: "published",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      counselApprovalReference: "LEGAL-PRIVACY-TEST-2026-08-15",
      rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
    },
    sections: privacyPolicyArtifact.sections.map((section) => ({
      ...section,
      reviewStatus: "counsel-approved" as const,
    })),
  };
}

describe("Privacy Policy artifact", () => {
  it("is a complete, evidenced twelve-subject counsel candidate", () => {
    expect(privacyPolicyArtifact.sections.map((section) => section.id)).toEqual(requiredPrivacyPolicySubjectIds);
    expect(privacyPolicyViolations(privacyPolicyArtifact)).toEqual([]);
    expect(validatePublicPolicyArtifactStructure(privacyPolicyArtifact)).toEqual([]);

    for (const section of privacyPolicyArtifact.sections) {
      expect(section.reviewManifest.scopeNote.trim().length).toBeGreaterThan(0);
      for (const reference of section.reviewManifest.productTruthRefs) {
        const match = /^(.*):(\d+)(?:-(\d+))?$/.exec(reference);
        const sourcePath = resolve(repoRoot, match?.[1] ?? reference);
        expect(existsSync(sourcePath), reference).toBe(true);
        if (match?.[2]) {
          const lines = readFileSync(sourcePath, "utf8").split(/\r?\n/);
          expect(Number(match[2]), reference).toBeGreaterThanOrEqual(1);
          expect(Number(match[3] ?? match[2]), reference).toBeLessThanOrEqual(lines.length);
        }
      }
    }

    const registry: readonly PublicPolicyRegistryEntry[] = [
      { artifact: privacyPolicyArtifact, requiredSubjectIds: requiredPrivacyPolicySubjectIds },
    ];
    expect(evaluateCanonicalClaimConsistency(registry, repoRoot)).toEqual([]);
  });

  it("keeps the implementation candidate non-published and non-activatable", () => {
    expect(privacyPolicyArtifact.metadata).toMatchObject({
      publicationStatus: "counsel-review-required",
      effectiveAt: null,
      counselApprovalReference: null,
      rolloutJurisdictionsOrProductLimits: [],
    });
    expect(evaluatePublicPolicyPublicationReadiness(privacyPolicyArtifact, requiredPrivacyPolicySubjectIds).ready).toBe(
      false,
    );
    expect(isConsentActivatable(privacyPolicyArtifact, requiredPrivacyPolicySubjectIds)).toBe(false);
  });

  it("derives every shipped chase_sets cookie constant across bounded contexts and requires it in the operative disclosure", () => {
    expect(shippedCookieNames().length).toBeGreaterThan(0);
    expect(missingShippedCookieDisclosures(privacyPolicyArtifact)).toEqual([]);
  });

  it("rejects a one-cookie omission mutant in the operative disclosure", () => {
    const omittedCookie = shippedCookieNames()[0];
    expect(omittedCookie).toBeDefined();
    const mutant = withSection("cookies-and-analytics", (section) => ({
      ...section,
      draftText: section.draftText.replace(omittedCookie!, ""),
    }));
    expect(missingShippedCookieDisclosures(mutant)).toEqual([omittedCookie]);
  });

  it("derives shipped social-login providers from the registry and requires each in sources and recipients", () => {
    expect(shippedSocialLoginProviderNames().length).toBeGreaterThan(0);
    expect(missingSocialLoginProviderDisclosures(privacyPolicyArtifact)).toEqual([]);
  });

  it("rejects a one-provider omission mutant in either required disclosure", () => {
    const omittedProvider = shippedSocialLoginProviderNames()[0];
    expect(omittedProvider).toBeDefined();
    const mutant = withSection("recipients-and-disclosures", (section) => ({
      ...section,
      draftText: section.draftText.replace(new RegExp(`\\b${omittedProvider}\\b`, "i"), "the identity provider"),
    }));
    expect(missingSocialLoginProviderDisclosures(mutant)).toEqual([`recipients:${omittedProvider}`]);
  });

  it("would become ready only after every subject and publication field is counsel-approved", () => {
    const approved = approvedPrivacyArtifact();
    expect(evaluatePublicPolicyPublicationReadiness(approved, requiredPrivacyPolicySubjectIds)).toEqual({
      ready: true,
      errors: [],
    });
    expect(isConsentActivatable(approved, requiredPrivacyPolicySubjectIds)).toBe(true);
  });

  it("mutant controls fail for missing scope, nondiscriminating evidence, and counsel-owned conclusions", () => {
    const missingSubject: PublicPolicyArtifact = {
      ...privacyPolicyArtifact,
      sections: privacyPolicyArtifact.sections.filter((section) => section.id !== "retention"),
    };
    expect(privacyPolicyViolations(missingSubject)).toContain("required subject taxonomy changed");

    const adjacentCitation = withSection("data-categories-and-sources", (section) => ({
      ...section,
      reviewManifest: {
        ...section.reviewManifest,
        productTruthRefs: section.reviewManifest.productTruthRefs.map((ref) =>
          ref.includes("register-page.tsx:60-66")
            ? "bounded-contexts/public-presence/features/waitlist/domain/domain.ts:111-114"
            : ref,
        ),
      },
    }));
    expect(privacyPolicyViolations(adjacentCitation)).toEqual(
      expect.arrayContaining([expect.stringContaining("missing discriminating product evidence")]),
    );

    const settledSaleShare = withSection("gpc-and-sale-share", (section) => ({
      ...section,
      draftText: "Chase Sets does not sell personal information.",
    }));
    expect(privacyPolicyViolations(settledSaleShare)).toEqual(
      expect.arrayContaining(["sale/share conclusion is not reserved", "sale/share conclusion asserted as settled"]),
    );

    const stripeAgreementType = withSection("stripe-managed-processing", (section) => ({
      ...section,
      draftText: `${section.draftText} Stripe uses the recipient service agreement.`,
    }));
    expect(privacyPolicyViolations(stripeAgreementType)).toContain("Stripe agreement type asserted");
  });

  it("mutant controls fail for ADMT applicability, timing, and unshipped scanning", () => {
    const assertApplicable = withSection("automated-decisionmaking-technology", (section) => ({
      ...section,
      draftText: section.draftText.replace(
        "[ADMT-APPLICABILITY:",
        "The ADMT regulations apply to Chase Sets. [ADMT-APPLICABILITY:",
      ),
    }));
    expect(privacyPolicyViolations(assertApplicable)).toContain("ADMT applicability asserted");

    const wrongDate = withSection("automated-decisionmaking-technology", (section) => ({
      ...section,
      draftText: section.draftText.replace("January 1, 2027", "January 1, 2026"),
    }));
    expect(privacyPolicyViolations(wrongDate)).toContain("ADMT compliance start or in-scope qualification changed");

    const scanningShipped = withSection("automated-decisionmaking-technology", (section) => ({
      ...section,
      draftText: section.draftText.replace("does not currently use", "currently uses"),
    }));
    expect(privacyPolicyViolations(scanningShipped)).toContain("unshipped #4929 scanning described as current");
  });
});
