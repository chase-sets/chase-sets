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

  it("selects every strictly named verification namespace at least 24 hours old", () => {
    const item = (name, created, purpose) => ({
      metadata: {
        name,
        creationTimestamp: created,
        labels: purpose ? { "chasesets.com/purpose": purpose } : undefined,
      },
    });
    expect(
      selectStaleVerificationNamespaces(
        [
          item("chase-sets-verify-100-1", "2026-07-11T12:00:00.000Z"),
          item("chase-sets-verify-101-1", "2026-07-11T12:00:00.001Z"),
          item("chase-sets-verify-manual-proof", "2026-07-11T00:00:00.000Z", "something-else"),
        ],
        { now: "2026-07-12T12:00:00.000Z" },
      ),
    ).toEqual([
      { namespace: "chase-sets-verify-100-1", release: "csv-100-1", slug: "verify-100-1" },
      {
        namespace: "chase-sets-verify-manual-proof",
        release: "csv-manual-proof",
        slug: "verify-manual-proof",
      },
    ]);
  });

  it("never selects a namespace outside the strict chase-sets-verify run prefix", () => {
    const created = "2020-01-01T00:00:00.000Z";
    const items = [
      "chase-sets-platform",
      "chase-sets-pr-100",
      "chase-sets-verify-",
      "other-chase-sets-verify-100-1",
      "staging",
    ].map((name) => ({ metadata: { name, creationTimestamp: created } }));

    expect(selectStaleVerificationNamespaces(items, { now: "2026-07-12T12:00:00.000Z" })).toEqual([]);
  });
});
