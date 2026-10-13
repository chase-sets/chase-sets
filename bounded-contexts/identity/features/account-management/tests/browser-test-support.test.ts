import { describe, expect, it } from "vitest";
import { ownedBrowserIdentityDatabase } from "./browser-test-support";

describe("issue-7168-ac10-real-router Consent fixture", () => {
  it("accepts only the matching owned loopback Identity database and refuses shared or malformed targets", () => {
    const catalog = "postgres://catalog_role@localhost:5432/cs_synthetic_catalog";
    expect(
      ownedBrowserIdentityDatabase("postgres://identity_role@localhost:5432/cs_synthetic_identity", catalog).pathname,
    ).toBe("/cs_synthetic_identity");
    for (const value of [
      undefined,
      "postgres://example.test/cs_synthetic_identity",
      "postgres://localhost/identity",
      "postgres://localhost/cs_other_identity",
      "postgres://localhost:5433/cs_synthetic_identity",
      "http://localhost:5432/cs_synthetic_identity",
      "invalid",
    ])
      expect(() => ownedBrowserIdentityDatabase(value, catalog)).toThrow();
  });
});
