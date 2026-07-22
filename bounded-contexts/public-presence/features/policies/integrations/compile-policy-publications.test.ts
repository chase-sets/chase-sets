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
            metadata: { ...entry.artifact.metadata, version: "v2" },
            sections: entry.artifact.sections.map((section) => ({
              ...section,
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
    expect(terms?.content).toContain("consentActivatable: false");

    const index = modules.find((module) => module.relativePath === "index.ts");
    expect(index?.content).toContain("publicPolicyPublicationRecords");
  });

  it("keeps sibling modules and the corpus index byte-identical when one document changes", async () => {
    const baseline = await renderPublicPolicyPublicationContracts();
    const regenerated = await renderPublicPolicyPublicationContracts(withEditedArtifact("seller-agreement"));

    const changed = regenerated.filter(
      (module) => baseline.find((entry) => entry.relativePath === module.relativePath)?.content !== module.content,
    );
    expect(changed.map((module) => module.relativePath)).toEqual(["seller-agreement-publication.ts"]);

    const index = regenerated.find((module) => module.relativePath === "index.ts");
    expect(index?.content).toBe(baseline.find((module) => module.relativePath === "index.ts")?.content);
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
