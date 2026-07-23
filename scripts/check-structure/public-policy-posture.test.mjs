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

const syntheticCanonicalSource = `
export function resolvePolicyArtifactPublicationPosture() {}
function buildPolicyArtifactPageCopy() {
  return [
    "publicPresence.info.terms.metadata.effectivePending",
    "publicPresence.info.policies.metadata.effectivePending",
    "publicPresence.info.terms.counselPending.title",
    "publicPresence.info.terms.counselPending.description",
    "publicPresence.info.policies.counselPending.title",
    "publicPresence.info.policies.counselPending.description",
  ];
}
export function PolicyArtifactPage() {}
`;

describe("public policy publication posture guard", () => {
  it("scans the complete owned production roots and keeps the finite pending-copy set in one canonical builder", async () => {
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

  it("rejects pending copy planted elsewhere in the canonical module", () => {
    const result = findPublicPolicyPostureViolations([
      {
        relativePath: canonicalPagePath,
        source: `${syntheticCanonicalSource}\nconst bypass = "publicPresence.info.terms.metadata.effectivePending";`,
      },
    ]);

    expect(result.canonicalMapperFiles).toEqual([canonicalPagePath]);
    expect(result.violations).toEqual([
      expect.stringContaining("pending publication copy 'publicPresence.info.terms.metadata.effectivePending'"),
    ]);
  });

  it("rejects a route that injects pre-decided posture through the page API", () => {
    const futureRoutePath = "bounded-contexts/public-presence/routes/marketplace/future-policy.tsx";
    const result = findPublicPolicyPostureViolations([
      { relativePath: canonicalPagePath, source: syntheticCanonicalSource },
      {
        relativePath: futureRoutePath,
        source:
          'export function FuturePolicy() { return <PolicyArtifactPage artifact={artifact} copy={{ effectivePendingText: "pending" }} />; }',
      },
    ]);

    expect(result.violations).toEqual([
      expect.stringContaining(`${futureRoutePath}:1: PolicyArtifactPage posture-deciding prop 'copy' is forbidden`),
    ]);
  });

  it("rejects arbitrary-path pending literals without relying on route filename vocabulary", () => {
    const futureRoutePath = "bounded-contexts/public-presence/routes/marketplace/anything.tsx";
    const result = findPublicPolicyPostureViolations([
      { relativePath: canonicalPagePath, source: syntheticCanonicalSource },
      {
        relativePath: futureRoutePath,
        source: 'export const stale = "Effective date pending counsel approval";',
      },
    ]);

    expect(result.guardedFiles).toContain(futureRoutePath);
    expect(result.violations).toEqual([
      expect.stringContaining(
        `${futureRoutePath}:1: pending publication copy 'Effective date pending counsel approval'`,
      ),
    ]);
  });
});
