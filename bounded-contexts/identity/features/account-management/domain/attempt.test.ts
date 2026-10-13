import { describe, expect, it } from "vitest";
import { attemptStreamId, canonicalRequest, parseAttemptKey } from "./attempt";

const binding = {
  tenantId: "tnt_test",
  userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  accountId: "acc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};
const key = "9230f01b-7871-420b-9c32-37139f80f749";

describe("issue-7168-ac2-binding-and-hash", () => {
  it("isolates actors and keys without retaining the raw key", () => {
    const stream = attemptStreamId(binding, key);
    expect(stream).not.toContain(key);
    expect(stream).not.toBe(attemptStreamId({ ...binding, tenantId: "tnt_other" }, key));
    expect(stream).not.toBe(attemptStreamId({ ...binding, accountId: "acc_01ARZ3NDEKTSV4RRFFQ69G5FAW" }, key));
    expect(stream).not.toBe(attemptStreamId({ ...binding, userId: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAW" }, key));
  });
  it("normalizes caller semantics but rejects primitives, arrays, unknown fields and bounds", () => {
    const request = canonicalRequest("update-profile", binding.accountId, { name: " Test ", displayName: "Test" });
    expect(request.hash).toBe(
      canonicalRequest("update-profile", binding.accountId, { displayName: "Test", name: "Test" }).hash,
    );
    for (const body of [
      null,
      1,
      [],
      "x",
      { name: {} },
      { name: [] },
      { name: "x", secret: "x" },
      { name: "x".repeat(1001) },
    ]) {
      expect(() => canonicalRequest("update-profile", binding.accountId, body)).toThrow();
    }
    expect(() => canonicalRequest("sixteenth-action", null, {})).toThrow();
    expect(() => parseAttemptKey("not-a-key")).toThrow("interruption-safe-client-required");
  });
});
