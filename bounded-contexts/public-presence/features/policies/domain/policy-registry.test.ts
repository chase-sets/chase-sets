import { describe, expect, it } from "vitest";
import { publicPolicyHrefsByKey, publicPolicyKeys } from "@chase-sets/public-docs/policy-corpus";
import { isConsentActivatable, validatePublicPolicyArtifactStructure } from "./policy-artifact";
import { publicPolicyRegistry } from "./policy-registry";

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

  it("keeps every counsel-pending artifact explicitly non-operative and non-activatable", () => {
    // Seller Agreement (#5687) and Terms of Service (#5686) are drafted ahead
    // of counsel review; all other artifacts remain empty stubs until their
    // own slice lands. Draft text alone never makes a document operative.
    const draftedPolicyKeys = new Set(["seller-agreement", "terms-of-service"]);
    for (const entry of publicPolicyRegistry) {
      expect(entry.artifact.metadata.publicationStatus).toBe("counsel-review-required");
      expect(entry.artifact.metadata.effectiveAt).toBeNull();
      expect(entry.artifact.metadata.counselApprovalReference).toBeNull();
      expect(isConsentActivatable(entry.artifact, entry.requiredSubjectIds)).toBe(false);
      const isDrafted = draftedPolicyKeys.has(entry.artifact.metadata.policyKey);
      for (const section of entry.artifact.sections) {
        expect(section.draftText.trim().length > 0).toBe(isDrafted);
        expect(section.reviewStatus).toBe("counsel-required");
      }
    }
  });
});
