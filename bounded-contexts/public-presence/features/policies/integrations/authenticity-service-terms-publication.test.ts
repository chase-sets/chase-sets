import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPolicyRegistry, type PublicPolicyRegistryEntry } from "../domain/policy-registry";
import { renderPublicPolicyPublicationContracts } from "./compile-policy-publications.mjs";

const integrationsDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(integrationsDirectory, "../../..");
const compilerScript = resolve(integrationsDirectory, "compile-policy-publications.mjs");

const OWNED_MODULE = "authenticity-service-terms-publication.ts";

// The six sibling publication modules plus the content-insensitive corpus
// index: AC #5 requires every one of these to stay byte-identical to a
// content-only edit scoped to authenticity-service-terms.
const SIBLINGS_AND_INDEX = [
  "terms-of-service-publication.ts",
  "privacy-policy-publication.ts",
  "seller-agreement-publication.ts",
  "payments-terms-publication.ts",
  "agent-connector-terms-publication.ts",
  "founders-offer-terms-publication.ts",
  "index.ts",
] as const;

function runCompilerCheck() {
  return spawnSync(process.execPath, ["--experimental-strip-types", compilerScript, "--check"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

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

function withOneSectionOmitted(policyKey: string): readonly PublicPolicyRegistryEntry[] {
  return publicPolicyRegistry.map((entry) =>
    entry.artifact.metadata.policyKey === policyKey
      ? ({
          ...entry,
          artifact: { ...entry.artifact, sections: entry.artifact.sections.slice(1) },
        } as PublicPolicyRegistryEntry)
      : entry,
  );
}

function fingerprintOf(modules: readonly { relativePath: string; content: string }[], relativePath: string) {
  return modules
    .find((module) => module.relativePath === relativePath)
    ?.content.match(/contentFingerprint: "(sha256:[a-f0-9]{64})"/)?.[1];
}

describe("authenticity-service-terms production compiler", () => {
  it("emits the owned generated module with the canonical shape and a non-activatable, counsel-pending record", async () => {
    const modules = await renderPublicPolicyPublicationContracts();
    const owned = modules.find((module) => module.relativePath === OWNED_MODULE);

    expect(owned?.content).toContain('policyKey: "authenticity-service-terms"');
    expect(owned?.content).toContain('href: "/authenticity-terms"');
    expect(owned?.content).toContain('publicationStatus: "counsel-review-required"');
    expect(owned?.content).toContain("effectiveAt: null");
    expect(owned?.content).toContain("counselApprovalReference: null");
    expect(owned?.content).toContain("rolloutJurisdictionsOrProductLimits: []");
    expect(owned?.content).toContain("launchRequired: false");
    expect(owned?.content).toMatch(/contentFingerprint: "sha256:[a-f0-9]{64}"/);
    expect(owned?.content).toContain("consentActivatable: false");
  });

  it("isolates an authenticity-service-terms content-only edit to its own module and fingerprint (candidate/baseline isolation)", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    const editedRegistry = withEditedArtifact("authenticity-service-terms");
    const editedEntry = editedRegistry.find(
      (entry) => entry.artifact.metadata.policyKey === "authenticity-service-terms",
    );
    const baselineEntry = publicPolicyRegistry.find(
      (entry) => entry.artifact.metadata.policyKey === "authenticity-service-terms",
    );
    // A true content-only control: no metadata or version moves with it.
    expect(editedEntry?.artifact.metadata).toEqual(baselineEntry?.artifact.metadata);

    const regenerated = await renderPublicPolicyPublicationContracts(editedRegistry);
    const changed = regenerated.filter(
      (module) => baseline.find((entry) => entry.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map((module) => module.relativePath)).toEqual([OWNED_MODULE]);

    expect(fingerprintOf(regenerated, OWNED_MODULE)).not.toBe(fingerprintOf(baseline, OWNED_MODULE));

    for (const sibling of SIBLINGS_AND_INDEX) {
      expect(regenerated.find((module) => module.relativePath === sibling)?.content, sibling).toBe(
        baseline.find((module) => module.relativePath === sibling)?.content,
      );
    }
  });

  it.each([
    "terms-of-service",
    "seller-agreement",
    "payments-terms",
    "agent-connector-terms",
    "founders-offer-terms",
    "privacy-policy",
  ])(
    "leaves the authenticity-service-terms module byte-identical when a sibling ('%s') is edited (sibling-mutation control)",
    async (siblingPolicyKey) => {
      const baseline = await renderPublicPolicyPublicationContracts();
      const regenerated = await renderPublicPolicyPublicationContracts(withEditedArtifact(siblingPolicyKey));

      expect(regenerated.find((module) => module.relativePath === OWNED_MODULE)?.content).toBe(
        baseline.find((module) => module.relativePath === OWNED_MODULE)?.content,
      );
    },
  );

  it("changes the owned fingerprint when a required subject is omitted from the compiled content (compiler-omission control)", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    const omittedRegistry = withOneSectionOmitted("authenticity-service-terms");

    const regenerated = await renderPublicPolicyPublicationContracts(omittedRegistry);

    expect(fingerprintOf(regenerated, OWNED_MODULE)).not.toBe(fingerprintOf(baseline, OWNED_MODULE));
    for (const sibling of SIBLINGS_AND_INDEX) {
      expect(regenerated.find((module) => module.relativePath === sibling)?.content, sibling).toBe(
        baseline.find((module) => module.relativePath === sibling)?.content,
      );
    }
  });

  it("rejects malformed authenticity-service-terms metadata through the compile path", async () => {
    const malformed = publicPolicyRegistry.map((entry) =>
      entry.artifact.metadata.policyKey === "authenticity-service-terms"
        ? ({
            ...entry,
            artifact: { ...entry.artifact, metadata: { ...entry.artifact.metadata, launchRequired: "yes" } },
          } as unknown as PublicPolicyRegistryEntry)
        : entry,
    );

    await expect(renderPublicPolicyPublicationContracts(malformed)).rejects.toThrow(/launchRequired must be a boolean/);
  });

  it("passes --check through the real compiler entrypoint with the current working-tree content", () => {
    const result = runCompilerCheck();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("8/8 generated modules current (7 documents + index)");
  });
});
