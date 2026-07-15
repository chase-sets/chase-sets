import { describe, expect, it } from "vitest";
import { renderTermsOfServicePublicationContract } from "./compile-terms-of-service-publication.mjs";

describe("Terms of Service publication contract compiler", () => {
  it("emits the Public Presence-owned metadata consumed by the consent gate", async () => {
    const contract = await renderTermsOfServicePublicationContract();

    expect(contract).toContain('policyKey: "terms-of-service"');
    expect(contract).toContain('version: "v1"');
    expect(contract).toContain('publicationStatus: "counsel-review-required"');
    expect(contract).toContain("effectiveAt: null");
  });
});
