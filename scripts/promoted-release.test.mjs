import { describe, expect, it } from "vitest";
import { buildPromotedReleaseRecord, validatePromotedReleaseRecord } from "./promoted-release.mjs";

const valid = {
  schemaVersion: "promoted-release/v1",
  producerRunId: "123",
  producerRunAttempt: "2",
  environment: "production",
  releaseCommit: "a".repeat(40),
  treeHash: "b".repeat(40),
  imageRepository: "registry.digitalocean.com/chase-sets/chase-sets-platform",
  imageDigest: `sha256:${"c".repeat(64)}`,
  promotionResult: "promoted",
  promotedAt: "2026-07-18T12:00:00.000Z",
};

describe("promoted release contract", () => {
  it("creates a versioned immutable producer record", () => {
    expect(
      buildPromotedReleaseRecord({ ...valid, imageRepository: `${valid.imageRepository}:${valid.releaseCommit}` }),
    ).toEqual({ record: valid, errors: [] });
  });

  it("pins validation to the triggering producer run", () => {
    expect(validatePromotedReleaseRecord(valid, { producerRunId: "123", environment: "production" })).toEqual([]);
    expect(validatePromotedReleaseRecord(valid, { producerRunId: "456", environment: "production" })).toContain(
      "producerRunId does not match the triggering Platform Deploy run.",
    );
  });

  it.each([
    ["failed activation", { promotionResult: "failed" }, "promotionResult must be promoted."],
    ["malformed digest", { imageDigest: "latest" }, "imageDigest must be an immutable sha256 digest."],
    [
      "wrong repository",
      { imageRepository: "ghcr.io/example/platform" },
      "imageRepository must be an allowlisted Chase Sets DigitalOcean repository.",
    ],
    ["wrong environment", { environment: "staging" }, "environment must be production."],
  ])("rejects %s", (_name, override, error) => {
    expect(validatePromotedReleaseRecord({ ...valid, ...override })).toContain(error);
  });
});
