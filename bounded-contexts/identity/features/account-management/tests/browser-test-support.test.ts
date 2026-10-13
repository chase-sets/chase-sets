import { describe, expect, it } from "vitest";
import { ownedBrowserIdentityDatabase } from "./browser-test-support";

describe("issue-7168-ac10-real-router Consent fixture", () => {
  it("derives only the owned loopback Identity database and refuses shared or malformed targets", () => {
    expect(ownedBrowserIdentityDatabase("postgres://localhost:5432/cs_synthetic_catalog").pathname).toBe(
      "/cs_synthetic_identity",
    );
    for (const value of [
      undefined,
      "postgres://example.test/cs_synthetic_catalog",
      "postgres://localhost/identity",
      "postgres://localhost/cs_synthetic_identity",
    ])
      expect(() => ownedBrowserIdentityDatabase(value)).toThrow();
  });
});
