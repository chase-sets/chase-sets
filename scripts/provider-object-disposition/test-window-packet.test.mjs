import { expect, test } from "vitest";
import { parseCapturePacket, validateCapturePacket } from "./test-window-packet.mjs";
import { SCENARIO_FIXTURES } from "./validate-provider-object-disposition.mjs";

export const packet = () => ({
  version: "provider-lifecycle-capture/v1",
  classification: "unknown",
  reviewedHead: "a".repeat(40),
  executedHead: "a".repeat(40),
  journalHead: "b".repeat(40),
  deployedHead: "c".repeat(40),
  apiVersion: "2026-01-28.clover",
  configDigest: "d".repeat(64),
  providerMode: "test",
  plannedHttpAttempts: 32,
  actualHttpAttempts: 0,
  plannedObjects: 6,
  actualLogicalCreations: 0,
  retentionGuarantee: null,
  observations: [],
  disposition: structuredClone(SCENARIO_FIXTURES.cleanupFailureOverBudget),
  replayQualified: false,
});
test("canonical flat packet and closed refusal validate without inventing H4 fields", () => {
  expect(validateCapturePacket(packet())).toBe(true);
  expect(
    validateCapturePacket({
      version: "provider-lifecycle-capture/v1",
      classification: "refused",
      code: "authority-unavailable",
      replayQualified: false,
    }),
  ).toBe(true);
});
test("recursive unknown, private, bounded-number and authority negatives fail closed", () => {
  for (const mutate of [
    (p) => {
      p.private = "SYNTHETIC_PRIVATE_MARKER";
    },
    (p) => {
      p.disposition.private = "SYNTHETIC_PRIVATE_MARKER";
    },
    (p) => {
      p.actualHttpAttempts = 647;
    },
    (p) => {
      p.actualLogicalCreations = 7;
    },
    (p) => {
      p.executedHead = "e".repeat(40);
    },
    (p) => {
      p.retentionGuarantee = { source: "https://docs.stripe.com/api/idempotent_requests", seconds: 86401 };
    },
    (p) => {
      p.classification = "observed";
    },
  ]) {
    const value = packet();
    mutate(value);
    expect(validateCapturePacket(value)).toBe(false);
    expect(() => parseCapturePacket(JSON.stringify(value))).toThrow("packet-invalid");
  }
});
test("empty, truncated, multiline, duplicate keys and overflow refuse without reflecting private bytes", () => {
  for (const text of ["", "{", "{}\n{}", '{"private":"SYNTHETIC_PRIVATE_MARKER","private":1}', " ".repeat(1048577)])
    expect(() => parseCapturePacket(text)).toThrow(/^packet-invalid$/);
});
test("observation dates require UTC, exact elapsed time and unique mapper identities", () => {
  const observation = {
    mapper: "customer",
    classification: "unknown",
    originalSentAt: "2026-10-07T00:00:00Z",
    replaySentAt: "2026-10-07T00:00:01Z",
    expiresAt: null,
    elapsedSeconds: 1,
    equal: false,
    usability: "unknown",
    repeatedSameSlot: null,
    twoTabs: null,
    intervalSupported: false,
  };
  const value = packet();
  value.observations = [observation];
  expect(validateCapturePacket(value)).toBe(true);
  for (const originalSentAt of ["2026-10-07", "2026-10-07T00:00:00+00:00", "2026-10-07T00:00:02Z", null])
    expect(validateCapturePacket({ ...value, observations: [{ ...observation, originalSentAt }] })).toBe(false);
  expect(validateCapturePacket({ ...value, observations: [observation, observation] })).toBe(false);
});
