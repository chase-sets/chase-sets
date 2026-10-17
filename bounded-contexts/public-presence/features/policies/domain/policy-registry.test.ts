import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { publicPolicyHrefsByKey, publicPolicyKeys } from "@chase-sets/public-docs/policy-corpus";
import {
  evaluatePublicPolicyPublicationReadiness,
  isConsentActivatable,
  validatePublicPolicyArtifactStructure,
} from "./policy-artifact";
import { publicPolicyRegistry, type PublicPolicyRegistryEntry } from "./policy-registry";
import { renderPublicPolicyPublicationContracts } from "../integrations/compile-policy-publications.mjs";

async function assertCorpusPublicationPin(
  registry: readonly PublicPolicyRegistryEntry[],
  compiled: Awaited<ReturnType<typeof renderPublicPolicyPublicationContracts>>,
) {
  const expected = await renderPublicPolicyPublicationContracts(registry);
  for (const { artifact, requiredSubjectIds } of registry) {
    if (artifact.metadata.publicationStatus === "published") {
      expect(evaluatePublicPolicyPublicationReadiness(artifact, requiredSubjectIds).errors).toEqual([]);
      expect(isConsentActivatable(artifact, requiredSubjectIds)).toBe(true);
    } else {
      expect(artifact.metadata.publicationStatus).toBe("counsel-review-required");
      expect(artifact.metadata.effectiveAt).toBeNull();
      expect(artifact.metadata.counselApprovalReference).toBeNull();
      expect(isConsentActivatable(artifact, requiredSubjectIds)).toBe(false);
      for (const section of artifact.sections) expect(section.reviewStatus).toBe("counsel-required");
    }
    const path = `${artifact.metadata.policyKey}-publication.ts`;
    expect(compiled.find((module) => module.relativePath === path)?.content).toBe(
      expected.find((module) => module.relativePath === path)?.content,
    );
  }
}

function syntheticPublishedEntry(): PublicPolicyRegistryEntry {
  return {
    requiredSubjectIds: ["synthetic-subject"],
    artifact: {
      title: "Synthetic publication control, not legal text",
      description: "Synthetic publication pin fixture only.",
      metadata: {
        policyKey: "terms-of-service",
        version: "v999",
        locale: "en",
        href: "/terms",
        launchRequired: true,
        publicationStatus: "published",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        counselApprovalReference: "SYNTHETIC-NONLEGAL-CONTROL-8016",
        rolloutJurisdictionsOrProductLimits: ["Synthetic test scope only"],
      },
      sections: [
        {
          id: "synthetic-subject",
          title: "Synthetic section",
          draftText: "Synthetic operative-copy control only.",
          reviewStatus: "counsel-approved",
          reviewManifest: {
            scopeNote: "Synthetic fixture",
            decisionRefs: [],
            productTruthRefs: [],
            openQuestions: [],
            assumptions: [],
          },
        },
      ],
    },
  };
}

describe("public policy registry", () => {
  it("registers exactly the seven-document launch corpus with unique keys and canonical hrefs", () => {
    const keys = publicPolicyRegistry.map((entry) => entry.artifact.metadata.policyKey);

    expect(publicPolicyRegistry).toHaveLength(publicPolicyKeys.length);
    expect(new Set(keys).size).toBe(publicPolicyRegistry.length);
    expect([...keys].sort()).toEqual([...publicPolicyKeys].sort());

    const hrefs = publicPolicyRegistry.map((entry) => entry.artifact.metadata.href);
    expect(new Set(hrefs).size).toBe(publicPolicyRegistry.length);
    for (const entry of publicPolicyRegistry) {
      expect(entry.artifact.metadata.href).toBe(publicPolicyHrefsByKey[entry.artifact.metadata.policyKey]);
    }
  });

  it("holds every registered artifact to the shared version, subject, and closed-schema invariants", () => {
    for (const entry of publicPolicyRegistry) {
      const { artifact, requiredSubjectIds } = entry;
      expect(artifact.metadata.version).toMatch(/^v[1-9][0-9]*$/);
      expect(artifact.metadata.locale).toBe("en");
      expect(artifact.sections.length).toBeGreaterThanOrEqual(1);
      expect(requiredSubjectIds.length).toBeGreaterThanOrEqual(1);

      const sectionIds = artifact.sections.map((section) => section.id);
      for (const subjectId of requiredSubjectIds) {
        expect(sectionIds).toContain(subjectId);
      }

      expect(validatePublicPolicyArtifactStructure(artifact)).toEqual([]);
    }
  });

  it("marks every document launch-required except the packet-only authenticity service terms", () => {
    const launchRequiredByKey = Object.fromEntries(
      publicPolicyRegistry.map((entry) => [entry.artifact.metadata.policyKey, entry.artifact.metadata.launchRequired]),
    );

    expect(launchRequiredByKey).toEqual({
      "terms-of-service": true,
      "privacy-policy": true,
      "seller-agreement": true,
      "payments-terms": true,
      "agent-connector-terms": true,
      "authenticity-service-terms": false,
      "founders-offer-terms": true,
    });
  });

  it("corpus-publication-pin holds each artifact and its actual compiled content independently", async () => {
    const rendered = await renderPublicPolicyPublicationContracts();
    const compiled = await Promise.all(
      rendered.map(async (module) => ({
        relativePath: module.relativePath,
        content: await readFile(
          resolve(process.cwd(), "../../contracts/public-docs/generated", module.relativePath),
          "utf8",
        ),
      })),
    );
    await assertCorpusPublicationPin(publicPolicyRegistry, compiled);
  });

  it("corpus-publication-pin accepts one synthetic publication without exempting pending siblings", async () => {
    const registry = [syntheticPublishedEntry(), ...publicPolicyRegistry.slice(1)];
    await assertCorpusPublicationPin(registry, await renderPublicPolicyPublicationContracts(registry));
    const pending = registry[1]!;
    const mutated = [
      registry[0]!,
      {
        ...pending,
        artifact: {
          ...pending.artifact,
          metadata: {
            ...pending.artifact.metadata,
            effectiveAt: "2026-09-01T00:00:00.000Z",
          },
        },
      },
      ...registry.slice(2),
    ];
    const compiled = await renderPublicPolicyPublicationContracts(mutated);
    await expect(assertCorpusPublicationPin(mutated, compiled)).rejects.toThrow("to be null");
    // Global-exemption mutant: presence of one publication skips all pending pins.
    const globalExemptionMutant = async () => {
      if (mutated.some((entry) => entry.artifact.metadata.publicationStatus === "published")) return;
      await assertCorpusPublicationPin(mutated, compiled);
    };
    await expect(expect(globalExemptionMutant()).rejects.toThrow()).rejects.toThrow("resolved");
  });

  it.each([
    "null approval",
    "placeholder approval",
    "empty rollout",
    "invalid time",
    "blank copy",
    "unreviewed extra",
    "fingerprint drift",
  ])("corpus-publication-pin rejects %s", async (fault) => {
    const entry = syntheticPublishedEntry();
    const artifact = entry.artifact;
    const broken: PublicPolicyRegistryEntry = {
      ...entry,
      artifact: {
        ...artifact,
        metadata: {
          ...artifact.metadata,
          ...(fault === "null approval" ? { counselApprovalReference: null } : {}),
          ...(fault === "placeholder approval" ? { counselApprovalReference: "placeholder-approval" } : {}),
          ...(fault === "empty rollout" ? { rolloutJurisdictionsOrProductLimits: [] } : {}),
          ...(fault === "invalid time" ? { effectiveAt: "not-an-instant" } : {}),
        },
        sections:
          fault === "blank copy"
            ? artifact.sections.map((section) => ({ ...section, draftText: "  " }))
            : fault === "unreviewed extra"
              ? [...artifact.sections, { ...artifact.sections[0]!, id: "extra", reviewStatus: "counsel-required" }]
              : artifact.sections,
      },
    };
    const compiled = (await renderPublicPolicyPublicationContracts([entry])).map((module) => ({
      ...module,
      content:
        fault === "fingerprint drift"
          ? module.content.replace(/sha256:[a-f0-9]{64}/, `sha256:${"0".repeat(64)}`)
          : module.content,
    }));
    await expect(assertCorpusPublicationPin([broken], compiled)).rejects.toThrow();
  });
});
