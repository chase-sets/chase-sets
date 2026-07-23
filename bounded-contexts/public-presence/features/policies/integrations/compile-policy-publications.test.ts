import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPolicyRegistry, type PublicPolicyRegistryEntry } from "../domain/policy-registry";
import { renderPublicPolicyPublicationContracts } from "./compile-policy-publications.mjs";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(integrationsDirectory, "../../..");
const compilerScript = resolve(integrationsDirectory, "compile-policy-publications.mjs");

function withEditedArtifact(policyKey: string): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === policyKey
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
    const result = spawnSync(process.execPath, ["--experimental-strip-types", compilerScript, "--check"], {
      cwd: packageRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("8/8 generated modules current (7 documents + index)");
  });
});
