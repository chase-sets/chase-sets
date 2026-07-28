import { describe, expect, it } from "vitest";
import {
  buildPromotedReleaseRecord,
  readPromotedReleaseRecord,
  validatePromotedReleaseRecord,
} from "./promoted-release.mjs";

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

  it("accepts the exact triggering producer run and attempt", () => {
    expect(
      validatePromotedReleaseRecord(valid, {
        producerRunId: "123",
        producerRunAttempt: "2",
        environment: "production",
      }),
    ).toEqual([]);
  });

  it.each([
    [
      "wrong producer run",
      { producerRunId: "456" },
      { producerRunId: "123" },
      "producerRunId does not match the triggering Platform Deploy run.",
    ],
    [
      "wrong producer run attempt",
      { producerRunAttempt: "3" },
      { producerRunAttempt: "2" },
      "producerRunAttempt does not match the triggering Platform Deploy run attempt.",
    ],
  ])("rejects %s", (_name, expected, actual, error) => {
    expect(
      validatePromotedReleaseRecord({ ...valid, ...actual }, { ...expected, environment: "production" }),
    ).toContain(error);
  });

  it("reports an absent canonical handoff with the named disposition", async () => {
    await expect(
      readPromotedReleaseRecord(new URL("./fixtures/promoted-release-does-not-exist.json", import.meta.url)),
    ).rejects.toThrow("promoted-release-handoff-absent");
  });

  it.each([
    ["non-promoted activation", { promotionResult: "failed" }, "promotionResult must be promoted."],
    ["malformed digest", { imageDigest: "latest" }, "imageDigest must be an immutable sha256 digest."],
    ["absent digest", { imageDigest: "" }, "imageDigest must be an immutable sha256 digest."],
    [
      "non-allowlisted repository",
      { imageRepository: "ghcr.io/example/platform" },
      "imageRepository must be an allowlisted Chase Sets DigitalOcean repository.",
    ],
    ["non-production environment", { environment: "staging" }, "environment must be production."],
    ["malformed release commit", { releaseCommit: "main" }, "releaseCommit must be a 40-character Git commit SHA."],
    ["malformed tree hash", { treeHash: "tree" }, "treeHash must be a 40-character Git tree SHA."],
  ])("rejects %s", (_name, override, error) => {
    expect(validatePromotedReleaseRecord({ ...valid, ...override })).toContain(error);
  });

  it("rejects an environment that differs from the expected consumer environment", () => {
    expect(validatePromotedReleaseRecord(valid, { environment: "staging" })).toContain(
      "environment does not match expected staging.",
    );
  });
});
