import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";
import {
  findPublicPolicyPostureViolations,
  readPublicPolicyPostureSources,
  validatePublicPolicyPosture,
} from "./public-policy-posture.mjs";

const termsRoutePath = "bounded-contexts/public-presence/routes/marketplace/terms.tsx";
const termsPagePath = "bounded-contexts/public-presence/features/policies/ui/terms-of-service-page.tsx";
const canonicalPagePath = "bounded-contexts/public-presence/features/policies/ui/policy-artifact-page.tsx";

describe("public policy publication posture guard", () => {
  it("auto-enrolls the artifact-backed production surface and keeps pending posture in one canonical builder", async () => {
    const result = await validatePublicPolicyPosture({ repoRoot });

    expect(result.violations).toEqual([]);
    expect(result.canonicalMapperFiles).toEqual([canonicalPagePath]);
    expect(result.guardedFiles).toEqual(expect.arrayContaining([termsRoutePath, termsPagePath, canonicalPagePath]));
    expect(
      result.guardedFiles.filter((file) => file.startsWith("bounded-contexts/public-presence/routes/marketplace/")),
    ).toEqual(
      expect.arrayContaining([
        "bounded-contexts/public-presence/routes/marketplace/terms.tsx",
        "bounded-contexts/public-presence/routes/marketplace/seller-agreement.tsx",
        "bounded-contexts/public-presence/routes/marketplace/payments-terms.tsx",
        "bounded-contexts/public-presence/routes/marketplace/agent-terms.tsx",
        "bounded-contexts/public-presence/routes/marketplace/authenticity-terms.tsx",
      ]),
    );
  });

  it("rejects the historical hard-coded pending key when simulated in the real Terms page", async () => {
    const sources = await readPublicPolicyPostureSources({ repoRoot });
    const staleSources = sources.map((record) =>
      record.relativePath === termsPagePath
        ? {
            ...record,
            source: `${record.source}\nconst historicalTermsEffectiveCopy = t("publicPresence.info.terms.metadata.effectivePending");\n`,
          }
        : record,
    );

    const result = findPublicPolicyPostureViolations(staleSources);

    expect(result.canonicalMapperFiles).toEqual([canonicalPagePath]);
    expect(result.violations).toEqual([expect.stringContaining(`${termsPagePath}:`)]);
    expect(result.violations[0]).toContain("publicPresence.info.terms.metadata.effectivePending");
  });

  it("auto-enrolls a newly shaped adapter without a filename allowlist", () => {
    const result = findPublicPolicyPostureViolations([
      {
        relativePath: canonicalPagePath,
        source:
          'export function PolicyArtifactPage() {} export function resolvePolicyArtifactPublicationPosture() { if (publicationStatus !== "published") {} if (effectiveAt === null) {} copy.effectivePendingText; copy.formatEffectiveText; } export function buildPolicyArtifactPageCopy() {}',
      },
      {
        relativePath: "bounded-contexts/public-presence/routes/marketplace/future-policy.tsx",
        source:
          'import { PolicyArtifactRouteAdapter } from "../../features/policies/ui/policy-artifact-route-adapter"; const stale = "Effective date pending counsel approval";',
      },
    ]);

    expect(result.guardedFiles).toContain("bounded-contexts/public-presence/routes/marketplace/future-policy.tsx");
    expect(result.violations).toEqual([expect.stringContaining("future-policy.tsx:1: pending effective-date literal")]);
  });
});
