import { describe, expect, it } from "vitest";
import {
  assertRevocationActivationProof,
  revocationActivationProofDigest,
  type RevocationActivationProof,
} from "./revocation-floor";

describe("agent-grant-revocation-floor", () => {
  const now = "2026-10-12T00:01:00.000Z";
  const proof = {
    environment: "production",
    namespace: "synthetic",
    releaseCommit: "a".repeat(40),
    imageDigest: "sha256:" + "b".repeat(64),
    evidenceId: "synthetic-run",
    fenceId: "synthetic-fence",
    capturedAt: "2026-10-12T00:00:00.000Z",
    expectedReplicas: ["api-a", "api-b", "worker-a"],
    replicas: [
      {
        id: "api-a",
        uid: "synthetic-api-a",
        role: "platform-api",
        commit: "a".repeat(40),
        digest: "sha256:" + "b".repeat(64),
        supportVersion: 1,
      },
      {
        id: "api-b",
        uid: "synthetic-api-b",
        role: "platform-api",
        commit: "a".repeat(40),
        digest: "sha256:" + "b".repeat(64),
        supportVersion: 1,
      },
      {
        id: "worker-a",
        uid: "synthetic-worker-a",
        role: "platform-worker",
        commit: "a".repeat(40),
        digest: "sha256:" + "b".repeat(64),
        supportVersion: 1,
      },
    ],
  } satisfies RevocationActivationProof;
  it("admits the complete synthetic captured support floor, not a real host capture", () =>
    expect(() => assertRevocationActivationProof(proof, now)).not.toThrow());
  it("retains the proof digest after JSONB reorders every object's keys", () => {
    const reversed = JSON.parse(JSON.stringify(proof), (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).reverse())
        : value,
    );
    expect(revocationActivationProofDigest(reversed)).toBe(revocationActivationProofDigest(proof));
  });
  it.each([
    "old-worker",
    "missing-api",
    "duplicate",
    "stale",
    "invalid-digest",
    "commit-array",
    "digest-array",
    "instant-array",
  ])("refuses %s activation", (poison) => {
    const changed = structuredClone(proof);
    if (poison === "old-worker") changed.replicas[2].supportVersion = 0;
    if (poison === "missing-api") changed.replicas.splice(1, 1);
    if (poison === "duplicate") changed.replicas[1] = changed.replicas[0];
    if (poison === "stale") changed.capturedAt = "2026-10-11T00:00:00.000Z";
    if (poison === "invalid-digest") changed.replicas[2].digest = "unknown";
    if (poison === "commit-array") Object.assign(changed.replicas[2], { commit: [changed.replicas[2].commit] });
    if (poison === "digest-array") Object.assign(changed.replicas[2], { digest: [changed.replicas[2].digest] });
    if (poison === "instant-array") Object.assign(changed, { capturedAt: [changed.capturedAt] });
    expect(() => assertRevocationActivationProof(changed, now)).toThrow("revocation_support_floor");
  });
});
