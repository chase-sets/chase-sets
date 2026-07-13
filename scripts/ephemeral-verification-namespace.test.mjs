import { describe, expect, it } from "vitest";
import { selectStaleVerificationNamespaces, verificationIdentity } from "./ephemeral-verification-namespace.mjs";

describe("ephemeral verification namespaces", () => {
  it("derives DNS-safe isolated names from a workflow run", () => {
    expect(verificationIdentity("123456", "2")).toEqual({
      slug: "verify-123456-2",
      namespace: "chase-sets-verify-123456-2",
      release: "csv-123456-2",
    });
  });

  it("selects only stale, strictly named, explicitly labeled verification namespaces", () => {
    const item = (name, created, purpose = "release-verification") => ({
      metadata: {
        name,
        creationTimestamp: created,
        labels: { "chasesets.com/purpose": purpose },
      },
    });
    expect(
      selectStaleVerificationNamespaces(
        [
          item("chase-sets-verify-100-1", "2026-07-12T00:00:00.000Z"),
          item("chase-sets-verify-101-1", "2026-07-12T09:00:00.000Z"),
          item("chase-sets-verify-102-1", "2026-07-12T00:00:00.000Z", "something-else"),
          item("staging", "2020-01-01T00:00:00.000Z"),
        ],
        { now: "2026-07-12T12:00:00.000Z", maxAgeHours: 6 },
      ),
    ).toEqual([{ namespace: "chase-sets-verify-100-1", release: "csv-100-1", slug: "verify-100-1" }]);
  });
});
