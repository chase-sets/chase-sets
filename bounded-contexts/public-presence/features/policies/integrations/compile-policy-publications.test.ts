import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPolicyRegistry, type PublicPolicyRegistryEntry } from "../domain/policy-registry";
import { renderPublicPolicyPublicationContracts } from "./compile-policy-publications.mjs";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(integrationsDirectory, "../../..");
const repoRoot = resolve(integrationsDirectory, "../../../../..");
const compilerScript = resolve(integrationsDirectory, "compile-policy-publications.mjs");

const siblingPublicationModules = [
  "terms-of-service-publication.ts",
  "seller-agreement-publication.ts",
  "payments-terms-publication.ts",
  "agent-connector-terms-publication.ts",
  "authenticity-service-terms-publication.ts",
  "founders-offer-terms-publication.ts",
] as const;

/** Runs the real compiler entrypoint in a fresh process, so the Privacy
 *  cited-source digest is re-resolved from the working tree rather than
 *  reusing this process's memoized value. */
function runCompilerCheck() {
  return spawnSync(process.execPath, ["--experimental-strip-types", compilerScript, "--check"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

function withEditedArtifact(policyKey: string): readonly PublicPolicyRegistryEntry[] {
  return withEditedArtifacts([policyKey]);
}

function withEditedArtifacts(policyKeys: readonly string[]): readonly PublicPolicyRegistryEntry[] {
  const editedKeys = new Set(policyKeys);
  return publicPolicyRegistry.map((entry) =>
    editedKeys.has(entry.artifact.metadata.policyKey)
      ? ({
          ...entry,
          artifact: {
            ...entry.artifact,
            description: `${entry.artifact.description} Content edit for the isolation control.`,
            sections: entry.artifact.sections.map((section) => ({
              ...section,
              draftText: `${section.draftText} Operative content edit for the isolation control.`,
              reviewManifest: {
                ...section.reviewManifest,
                scopeNote: `${section.reviewManifest.scopeNote} Edited for the isolation control.`,
              },
            })),
          },
        } as PublicPolicyRegistryEntry)
      : entry,
  );
}

function preAgentTermsDraftBaselineRegistry(): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) => {
    if (entry.artifact.metadata.policyKey === "agent-connector-terms") {
      return {
        ...entry,
        requiredSubjectIds: ["agent-connector-terms-scope"],
        artifact: {
          ...entry.artifact,
          title: "Agent connector terms",
          description:
            "This versioned artifact registers the Chase Sets agent connector terms in the public policy corpus. Its subject taxonomy and operative language are not yet drafted, and nothing in it takes effect before qualified counsel approves the final language, launch scope, and external approval reference.",
          sections: [
            {
              id: "agent-connector-terms-scope",
              title: "Agent connector terms scope",
              draftText: "",
              reviewStatus: "counsel-required" as const,
              reviewManifest: {
                scopeNote:
                  "Reserve the scope of the operative Chase Sets agent connector terms, covering authorized machine access to the marketplace through the published connector surface. Counsel-approved language is required before any of it takes effect.",
                decisionRefs: [],
                productTruthRefs: [],
                openQuestions: [
                  "Subject taxonomy and draft language are owned by issue #5690 (agent connector terms document slice).",
                ],
                assumptions: [],
              },
            },
          ],
        },
      } as unknown as PublicPolicyRegistryEntry;
    }

    if (entry.artifact.metadata.policyKey === "terms-of-service") {
      return {
        ...entry,
        artifact: {
          ...entry.artifact,
          sections: entry.artifact.sections.map((section) =>
            section.id === "electronic-agents-and-automated-access"
              ? {
                  ...section,
                  reviewManifest: {
                    ...section.reviewManifest,
                    productTruthRefs: section.reviewManifest.productTruthRefs.map((ref) =>
                      ref ===
                      "bounded-contexts/public-presence/features/developer-portal/domain/developer-manifest.ts:24,41-45"
                        ? "bounded-contexts/public-presence/features/developer-portal/domain/developer-manifest.ts:15,25-29"
                        : ref,
                    ),
                  },
                }
              : section,
          ),
        },
      } as PublicPolicyRegistryEntry;
    }

    return entry;
  });
}

function withPublishedSellerArtifact(
  draftText: string,
  options: Readonly<{ includeUnreviewedExtra?: boolean }> = {},
): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === "seller-agreement"
      ? ({
          ...entry,
          artifact: {
            ...entry.artifact,
            metadata: {
              ...entry.artifact.metadata,
              publicationStatus: "published",
              effectiveAt: "2026-09-01T00:00:00.000Z",
              counselApprovalReference: "LEGAL-SELLER-TEST-2026-08-15",
              rolloutJurisdictionsOrProductLimits: ["Test-only reviewed launch scope."],
            },
            sections: [
              ...entry.artifact.sections.map((section) => ({
                ...section,
                draftText,
                reviewStatus: "counsel-approved" as const,
              })),
              ...(options.includeUnreviewedExtra
                ? [
                    {
                      id: "unreviewed-extra",
                      title: "Unreviewed extra",
                      draftText: "Test-only extra operative copy.",
                      reviewStatus: "counsel-required" as const,
                      reviewManifest: {
                        scopeNote: "Test-only extra review scope.",
                        decisionRefs: [],
                        productTruthRefs: [],
                        openQuestions: [],
                        assumptions: [],
                      },
                    },
                  ]
                : []),
            ],
          },
        } as PublicPolicyRegistryEntry)
      : entry,
  );
}

describe("public policy corpus compiler", () => {
  it("emits one generated metadata module per registry document plus the stable corpus index", async () => {
    const modules = await renderPublicPolicyPublicationContracts();

    expect(modules.map((module) => module.relativePath)).toEqual([
      "terms-of-service-publication.ts",
      "privacy-policy-publication.ts",
      "seller-agreement-publication.ts",
      "payments-terms-publication.ts",
      "agent-connector-terms-publication.ts",
      "authenticity-service-terms-publication.ts",
      "founders-offer-terms-publication.ts",
      "index.ts",
    ]);

    const terms = modules.find((module) => module.relativePath === "terms-of-service-publication.ts");
    expect(terms?.content).toContain('policyKey: "terms-of-service"');
    expect(terms?.content).toContain("as const satisfies PublicTermsOfServicePublicationMetadata");
    expect(terms?.content).toMatch(/contentFingerprint: "sha256:[a-f0-9]{64}"/);
    expect(terms?.content).toContain("consentActivatable: false");

    const index = modules.find((module) => module.relativePath === "index.ts");
    expect(index?.content).toContain("publicPolicyPublicationRecords");
  });

  it("changes only the owned document module for a content-only edit with no metadata bump", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    const editedRegistry = withEditedArtifact("seller-agreement");
    const editedSeller = editedRegistry.find((entry) => entry.artifact.metadata.policyKey === "seller-agreement");
    const baselineSeller = publicPolicyRegistry.find(
      (entry) => entry.artifact.metadata.policyKey === "seller-agreement",
    );
    expect(editedSeller?.artifact.metadata).toEqual(baselineSeller?.artifact.metadata);

    const regenerated = await renderPublicPolicyPublicationContracts(editedRegistry);

    const changed = regenerated.filter(
      (module) => baseline.find((entry) => entry.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map((module) => module.relativePath)).toEqual(["seller-agreement-publication.ts"]);

    const index = regenerated.find((module) => module.relativePath === "index.ts");
    expect(index?.content).toBe(baseline.find((module) => module.relativePath === "index.ts")?.content);
  });

  it("isolates three simultaneous content-only edits to three fingerprint-only publication records", async () => {
    const editedPolicyKeys = ["terms-of-service", "privacy-policy", "authenticity-service-terms"] as const;
    const expectedChangedModules = [
      "terms-of-service-publication.ts",
      "privacy-policy-publication.ts",
      "authenticity-service-terms-publication.ts",
    ] as const;
    const baseline = await renderPublicPolicyPublicationContracts();
    const editedRegistry = withEditedArtifacts(editedPolicyKeys);

    for (const policyKey of editedPolicyKeys) {
      expect(
        editedRegistry.find((entry) => entry.artifact.metadata.policyKey === policyKey)?.artifact.metadata,
      ).toEqual(
        publicPolicyRegistry.find((entry) => entry.artifact.metadata.policyKey === policyKey)?.artifact.metadata,
      );
    }

    const regenerated = await renderPublicPolicyPublicationContracts(editedRegistry);
    const changed = regenerated.filter(
      (module) => baseline.find((entry) => entry.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map((module) => module.relativePath)).toEqual(expectedChangedModules);

    const withoutFingerprint = (content: string | undefined) =>
      content?.replace(/contentFingerprint: "sha256:[a-f0-9]{64}"/, 'contentFingerprint: "<CONTENT-FINGERPRINT>"');
    for (const relativePath of expectedChangedModules) {
      const before = baseline.find((module) => module.relativePath === relativePath)?.content;
      const after = regenerated.find((module) => module.relativePath === relativePath)?.content;
      expect(after?.match(/contentFingerprint: "sha256:[a-f0-9]{64}"/)?.[0], relativePath).not.toBe(
        before?.match(/contentFingerprint: "sha256:[a-f0-9]{64}"/)?.[0],
      );
      expect(withoutFingerprint(after), relativePath).toBe(withoutFingerprint(before));
      expect(after, relativePath).toContain("consentActivatable: false");
    }

    for (const relativePath of [
      "seller-agreement-publication.ts",
      "payments-terms-publication.ts",
      "agent-connector-terms-publication.ts",
      "founders-offer-terms-publication.ts",
      "index.ts",
    ] as const) {
      expect(regenerated.find((module) => module.relativePath === relativePath)?.content, relativePath).toBe(
        baseline.find((module) => module.relativePath === relativePath)?.content,
      );
    }
  });

  it.each(["", "  \n\t"])(
    "compiles consentActivatable false when required operative copy is only %j",
    async (draftText) => {
      const modules = await renderPublicPolicyPublicationContracts(withPublishedSellerArtifact(draftText));
      const seller = modules.find((module) => module.relativePath === "seller-agreement-publication.ts");

      expect(seller?.content).toContain('publicationStatus: "published"');
      expect(seller?.content).toContain("consentActivatable: false");
    },
  );

  it("compiles consentActivatable true for the same published artifact with reviewed operative copy", async () => {
    const modules = await renderPublicPolicyPublicationContracts(
      withPublishedSellerArtifact("Reviewed operative test copy."),
    );
    const seller = modules.find((module) => module.relativePath === "seller-agreement-publication.ts");

    expect(seller?.content).toContain('publicationStatus: "published"');
    expect(seller?.content).toContain("consentActivatable: true");
  });

  it("compiles consentActivatable false for a published artifact with an unreviewed extra section", async () => {
    const modules = await renderPublicPolicyPublicationContracts(
      withPublishedSellerArtifact("Reviewed operative test copy.", { includeUnreviewedExtra: true }),
    );
    const seller = modules.find((module) => module.relativePath === "seller-agreement-publication.ts");

    expect(seller?.content).toContain('publicationStatus: "published"');
    expect(seller?.content).toContain("consentActivatable: false");
  });

  it("rejects nested unknown review-manifest fields through the compile path", async () => {
    const smuggled = publicPolicyRegistry.map((entry) =>
      entry.artifact.metadata.policyKey === "privacy-policy"
        ? ({
            ...entry,
            artifact: {
              ...entry.artifact,
              sections: entry.artifact.sections.map((section) => ({
                ...section,
                reviewManifest: { ...section.reviewManifest, internalNote: "smuggled" },
              })),
            },
          } as unknown as PublicPolicyRegistryEntry)
        : entry,
    );

    await expect(renderPublicPolicyPublicationContracts(smuggled)).rejects.toThrow(
      /unexpected field 'sections\['privacy-notice-scope'\]\.reviewManifest\.internalNote'/,
    );
  });

  it("rejects malformed metadata values through the compile path", async () => {
    const malformed = publicPolicyRegistry.map((entry) =>
      entry.artifact.metadata.policyKey === "payments-terms"
        ? ({
            ...entry,
            artifact: { ...entry.artifact, metadata: { ...entry.artifact.metadata, version: "v0" } },
          } as unknown as PublicPolicyRegistryEntry)
        : entry,
    );

    await expect(renderPublicPolicyPublicationContracts(malformed)).rejects.toThrow(/version must match/);
  });

  it("passes --check through the real compiler entrypoint and reports discovered generated modules", () => {
    const result = runCompilerCheck();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("8/8 generated modules current (7 documents + index)");
  });

  it("isolates a Privacy content-only edit to Privacy's module and fingerprint", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    const editedRegistry = withEditedArtifact("privacy-policy");
    const editedPrivacy = editedRegistry.find((entry) => entry.artifact.metadata.policyKey === "privacy-policy");
    const baselinePrivacy = publicPolicyRegistry.find(
      (entry) => entry.artifact.metadata.policyKey === "privacy-policy",
    );
    // A true content-only control: no metadata or version moves with it.
    expect(editedPrivacy?.artifact.metadata).toEqual(baselinePrivacy?.artifact.metadata);

    const regenerated = await renderPublicPolicyPublicationContracts(editedRegistry);
    const changed = regenerated.filter(
      (module) => baseline.find((entry) => entry.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map((module) => module.relativePath)).toEqual(["privacy-policy-publication.ts"]);

    const fingerprintOf = (modules: readonly { relativePath: string; content: string }[]) =>
      modules
        .find((module) => module.relativePath === "privacy-policy-publication.ts")
        ?.content.match(/contentFingerprint: "(sha256:[a-f0-9]{64})"/)?.[1];
    expect(fingerprintOf(regenerated)).not.toBe(fingerprintOf(baseline));

    for (const sibling of [...siblingPublicationModules, "index.ts"]) {
      expect(regenerated.find((module) => module.relativePath === sibling)?.content, sibling).toBe(
        baseline.find((module) => module.relativePath === sibling)?.content,
      );
    }
  });

  it("isolates a Terms of Service content-only edit to the Terms module, leaving the other six and the index byte-identical", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    const editedRegistry = withEditedArtifact("terms-of-service");
    const editedTerms = editedRegistry.find((entry) => entry.artifact.metadata.policyKey === "terms-of-service");
    const baselineTerms = publicPolicyRegistry.find(
      (entry) => entry.artifact.metadata.policyKey === "terms-of-service",
    );
    // A true content-only control: no metadata, version, or publication
    // posture moves with a section edit.
    expect(editedTerms?.artifact.metadata).toEqual(baselineTerms?.artifact.metadata);

    const regenerated = await renderPublicPolicyPublicationContracts(editedRegistry);
    const changed = regenerated.filter(
      (module) => baseline.find((entry) => entry.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map((module) => module.relativePath)).toEqual(["terms-of-service-publication.ts"]);

    const termsSiblings = [
      "privacy-policy-publication.ts",
      "seller-agreement-publication.ts",
      "payments-terms-publication.ts",
      "agent-connector-terms-publication.ts",
      "authenticity-service-terms-publication.ts",
      "founders-offer-terms-publication.ts",
      "index.ts",
    ] as const;
    for (const sibling of termsSiblings) {
      expect(regenerated.find((module) => module.relativePath === sibling)?.content, sibling).toBe(
        baseline.find((module) => module.relativePath === sibling)?.content,
      );
    }

    // A content edit moves the fingerprint and nothing else: the artifact
    // stays counsel-pending, non-effective, and non-activatable.
    const terms = regenerated.find((module) => module.relativePath === "terms-of-service-publication.ts");
    expect(terms?.content).toContain('publicationStatus: "counsel-review-required"');
    expect(terms?.content).toContain("effectiveAt: null");
    expect(terms?.content).toContain("counselApprovalReference: null");
    expect(terms?.content).toContain("consentActivatable: false");
  });

  it("isolates the completed Agent draft and Terms citation re-pin to exactly their two generated records", async () => {
    const baseline = await renderPublicPolicyPublicationContracts(preAgentTermsDraftBaselineRegistry());
    const modules = await renderPublicPolicyPublicationContracts();
    const changed = modules.filter(
      (module) =>
        baseline.find((candidate) => candidate.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map(({ relativePath }) => relativePath)).toEqual([
      "terms-of-service-publication.ts",
      "agent-connector-terms-publication.ts",
    ]);

    const fingerprint = (content: string | undefined) =>
      content?.match(/contentFingerprint: "(sha256:[a-f0-9]{64})"/)?.[1];
    expect(
      fingerprint(
        baseline.find(({ relativePath }) => relativePath === "agent-connector-terms-publication.ts")?.content,
      ),
    ).toBe("sha256:c527cca70b8e0f5055e8fc480f2deefc61629a422af3249dd452a192b06c5c98");
    expect(
      fingerprint(baseline.find(({ relativePath }) => relativePath === "terms-of-service-publication.ts")?.content),
    ).toBe("sha256:3f2930714f2f58cf68df0948999bb7d61e73b96e2b79af6719fcb15997ecea04");

    for (const module of changed) {
      const before = baseline.find((candidate) => candidate.relativePath === module.relativePath)?.content;
      expect(fingerprint(module.content), module.relativePath).not.toBe(fingerprint(before));
      expect(module.content, module.relativePath).toContain('publicationStatus: "counsel-review-required"');
      expect(module.content, module.relativePath).toContain("effectiveAt: null");
      expect(module.content, module.relativePath).toContain("counselApprovalReference: null");
      expect(module.content, module.relativePath).toContain("consentActivatable: false");
    }

    for (const module of modules) {
      const onDisk = readFileSync(resolve(repoRoot, "contracts/public-docs/generated", module.relativePath), "utf8");
      expect(module.content, `${module.relativePath} on disk`).toBe(onDisk);
      if (!changed.some(({ relativePath }) => relativePath === module.relativePath)) {
        expect(module.content, `${module.relativePath} baseline isolation`).toBe(
          baseline.find((candidate) => candidate.relativePath === module.relativePath)?.content,
        );
      }
    }
  });

  it("negative control: reverting each fingerprint-owning citation repair stales exactly its derived module", async () => {
    const mutants = [
      {
        id: "C1",
        policyKey: "privacy-policy",
        sectionId: "children",
        carrier: "productTruthRef",
        before: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:370",
        after: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:345",
        module: "privacy-policy-publication.ts",
      },
      {
        id: "C2",
        policyKey: "privacy-policy",
        sectionId: "children",
        carrier: "assumptionEvidenceRef",
        before:
          "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:370; bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66",
        after:
          "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:345; bounded-contexts/auth/features/registration/ui/register-page.tsx:60-66",
        module: "privacy-policy-publication.ts",
      },
      {
        id: "C3",
        policyKey: "authenticity-service-terms",
        sectionId: "condition-notes-and-disputes",
        carrier: "productTruthRef",
        before: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:576-602",
        after: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:544-569",
        module: "authenticity-service-terms-publication.ts",
      },
      {
        id: "C4",
        policyKey: "authenticity-service-terms",
        sectionId: "liability-limits",
        carrier: "productTruthRef",
        before: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:552",
        after: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:520",
        module: "authenticity-service-terms-publication.ts",
      },
      {
        id: "C5",
        policyKey: "authenticity-service-terms",
        sectionId: "liability-limits",
        carrier: "assumptionEvidenceRef",
        before: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:552",
        after: "bounded-contexts/public-presence/features/policies/domain/terms-of-service.ts:520",
        module: "authenticity-service-terms-publication.ts",
      },
      {
        id: "C8",
        policyKey: "terms-of-service",
        sectionId: "effective-date-notice-and-acceptance",
        carrier: "productTruthRef",
        before: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:12-13",
        after: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:15-48",
        module: "terms-of-service-publication.ts",
      },
      {
        id: "C9",
        policyKey: "terms-of-service",
        sectionId: "changes-notice-and-acceptance",
        carrier: "productTruthRef",
        before: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:26-28",
        after: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:15-48",
        module: "terms-of-service-publication.ts",
      },
      {
        id: "C10",
        policyKey: "terms-of-service",
        sectionId: "changes-notice-and-acceptance",
        carrier: "assumptionEvidenceRef",
        before: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:19-30",
        after: "bounded-contexts/identity/features/consents/read-model/terms-acceptance.ts:15-48",
        module: "terms-of-service-publication.ts",
      },
    ] as const;

    expect(runCompilerCheck().status).toBe(0);
    for (const mutant of mutants) {
      let replacementCount = 0;
      const revertedRegistry = publicPolicyRegistry.map((entry) =>
        entry.artifact.metadata.policyKey === mutant.policyKey
          ? ({
              ...entry,
              artifact: {
                ...entry.artifact,
                sections: entry.artifact.sections.map((section) =>
                  section.id === mutant.sectionId
                    ? {
                        ...section,
                        reviewManifest: {
                          ...section.reviewManifest,
                          productTruthRefs: section.reviewManifest.productTruthRefs.map((ref) => {
                            if (mutant.carrier !== "productTruthRef" || ref !== mutant.before) return ref;
                            replacementCount += 1;
                            return mutant.after;
                          }),
                          assumptions: section.reviewManifest.assumptions.map((assumption) => {
                            if (
                              mutant.carrier !== "assumptionEvidenceRef" ||
                              assumption.evidenceRef !== mutant.before
                            ) {
                              return assumption;
                            }
                            replacementCount += 1;
                            return { ...assumption, evidenceRef: mutant.after };
                          }),
                        },
                      }
                    : section,
                ),
              },
            } as PublicPolicyRegistryEntry)
          : entry,
      );
      expect(replacementCount, mutant.id).toBe(1);

      const regenerated = await renderPublicPolicyPublicationContracts(revertedRegistry);
      const staleModules = regenerated
        .filter((module) => {
          const committed = readFileSync(
            resolve(repoRoot, "contracts/public-docs/generated", module.relativePath),
            "utf8",
          );
          return module.content !== committed;
        })
        .map((module) => module.relativePath);
      expect(staleModules, mutant.id).toEqual([mutant.module]);
    }
    expect(runCompilerCheck().status).toBe(0);
  }, 120_000);

  it("stales only Privacy for a cited-source-only change, leaving every sibling and the index byte-identical", () => {
    // The cited byte range of one first-party cookie name binding. The edit is
    // whitespace-only inside the cited line: the AST, the derived subject, the
    // line count, and every sibling document are unchanged, so any staleness
    // can only come from Privacy's cited-source evidence digest.
    const citedModule = resolve(
      repoRoot,
      "bounded-contexts/marketplace/support/request-support/anonymous-listing-draft.ts",
    );
    const original = readFileSync(citedModule, "utf8");
    const marker =
      'export const MARKETPLACE_ANONYMOUS_LISTING_DRAFT_COOKIE_NAME = "chase_sets_anonymous_listing_drafts";';
    expect(original).toContain(marker);

    expect(runCompilerCheck().status).toBe(0);
    try {
      writeFileSync(citedModule, original.replace(marker, `${marker.slice(0, -1)}  ;`), "utf8");
      const stale = runCompilerCheck();
      expect(stale.status).not.toBe(0);
      const staleModules = `${stale.stdout}${stale.stderr}`
        .split(/\r?\n/)
        .filter((line) => line.includes("stale generated module:"))
        .map((line) => line.slice(line.lastIndexOf("stale generated module:")).trim());
      expect(staleModules).toHaveLength(1);
      expect(staleModules[0]).toContain("privacy-policy-publication.ts");
      for (const sibling of [...siblingPublicationModules, "index.ts"]) {
        expect(staleModules[0], sibling).not.toContain(sibling);
      }
    } finally {
      writeFileSync(citedModule, original, "utf8");
    }
    expect(runCompilerCheck().status).toBe(0);
  }, 120_000);
});
