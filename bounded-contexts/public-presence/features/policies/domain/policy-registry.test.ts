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

function noticeEmailErrors(registry: readonly PublicPolicyRegistryEntry[]): readonly string[] {
  const errors: string[] = [];
  for (const { artifact } of registry) {
    const key = artifact.metadata.policyKey;
    if (JSON.stringify(artifact).includes("[NOTICE-EMAIL]")) errors.push(key + ": notice-email placeholder");
    for (const section of artifact.sections) {
      const sentences = section.draftText.split(/(?<=[.!?])\s+|\n+/);
      if (
        sentences.some(
          (sentence) => /notice|privacy request|opt-out/i.test(sentence) && sentence.includes("support@chasesets.com"),
        )
      ) {
        errors.push(key + ": support address in notice sentence");
      }
      const manifest = section.reviewManifest;
      const statements = [
        manifest.scopeNote,
        ...manifest.openQuestions,
        ...manifest.assumptions.map(({ assertion }) => assertion),
      ];
      if (
        statements.some(
          (statement) =>
            /notice.{0,20}email|legal@chasesets.com/i.test(statement) &&
            /pending|missing|counsel-owned|did not supply/i.test(statement),
        )
      ) {
        errors.push(key + ": email still unresolved");
      }
    }
  }
  return errors;
}

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
  it("uses the dedicated legal-notice email across every registered artifact", () => {
    expect(noticeEmailErrors(publicPolicyRegistry)).toEqual([]);
    for (const key of ["terms-of-service", "seller-agreement", "privacy-policy"]) {
      const artifact = publicPolicyRegistry.find(({ artifact }) => artifact.metadata.policyKey === key)!.artifact;
      expect(artifact.sections.some(({ draftText }) => draftText.includes("US, or to legal@chasesets.com."))).toBe(
        true,
      );
    }
  });

  it.each(publicPolicyRegistry.map(({ artifact }) => artifact.metadata.policyKey))(
    "negative control: restoring the notice-email placeholder in %s fails",
    (key) => {
      const mutated = publicPolicyRegistry.map((entry) =>
        entry.artifact.metadata.policyKey === key
          ? {
              ...entry,
              artifact: {
                ...entry.artifact,
                sections: entry.artifact.sections.map((section, index) =>
                  index === 0
                    ? {
                        ...section,
                        draftText: section.draftText.includes("legal@chasesets.com")
                          ? section.draftText.replace("legal@chasesets.com", "[NOTICE-EMAIL]")
                          : section.draftText + " Send legal notices to [NOTICE-EMAIL].",
                      }
                    : section,
                ),
              },
            }
          : entry,
      );
      expect(noticeEmailErrors(mutated)).toContain(key + ": notice-email placeholder");
    },
  );

  it.each(["terms-of-service", "seller-agreement", "privacy-policy"])(
    "negative controls: %s rejects support routing and a pending email manifest",
    (key) => {
      const mutate = (pending: boolean) =>
        publicPolicyRegistry.map((entry) =>
          entry.artifact.metadata.policyKey === key
            ? {
                ...entry,
                artifact: {
                  ...entry.artifact,
                  sections: entry.artifact.sections.map((section) =>
                    section.draftText.includes("US, or to legal@chasesets.com.")
                      ? {
                          ...section,
                          draftText: pending
                            ? section.draftText
                            : section.draftText.replace("legal@chasesets.com", "support@chasesets.com"),
                          reviewManifest: pending
                            ? {
                                ...section.reviewManifest,
                                openQuestions: [
                                  ...section.reviewManifest.openQuestions,
                                  "The legal-notice email remains pending.",
                                ],
                              }
                            : section.reviewManifest,
                        }
                      : section,
                  ),
                },
              }
            : entry,
        );
      expect(noticeEmailErrors(mutate(false))).toContain(key + ": support address in notice sentence");
      expect(noticeEmailErrors(mutate(true))).toContain(key + ": email still unresolved");
    },
  );

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
