import { describe, expect, it } from "vitest";
import { decodeConnectorPairingDetail, decodeGeneratedPairingCode } from "../domain/codecs";

describe("connector closed detail contract", () => {
  const valid = {
    state: "paired",
    pairingId: "pair_test",
    revision: 2,
    codeExpiresAt: "2026-09-14T12:10:00.000Z",
    lastSeenAt: null,
  };
  it("accepts complete state without manufacturing last-seen", () => {
    expect(decodeConnectorPairingDetail(valid)).toEqual(valid);
  });
  it.each([
    {},
    { ...valid, revision: "2" },
    { ...valid, revision: 0 },
    { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, state: "unknown" },
    { ...valid, codeExpiresAt: "2026-09-14" },
    { ...valid, lastSeenAt: "2026-09-14" },
    { ...valid, nested: { unexpected: true } },
    { ...valid, pairingId: null },
    { ...valid, lastSeenAt: undefined },
  ])("refuses malformed state instead of rendering paired: %j", (value) => {
    expect(() => decodeConnectorPairingDetail(value)).toThrow();
  });
});

describe("generated code closed contract", () => {
  const valid = { pairingId: "pair_test", revision: 1, code: "x".repeat(43), expiresAt: "2026-09-14T12:10:00Z" };
  it("accepts a bounded code and timezone instant", () => {
    expect(decodeGeneratedPairingCode(valid)).toEqual(valid);
  });
  it.each([
    {},
    { ...valid, pairingId: "" },
    { ...valid, pairingId: "x".repeat(129) },
    { ...valid, code: {} },
    { ...valid, revision: "1" },
    { ...valid, revision: 0 },
    { ...valid, expiresAt: "2026-09-14" },
    { ...valid, expiresAt: "2026-09-14T99:99:00Z" },
    { ...valid, nested: { secret: true } },
  ])("refuses %j", (value) => {
    expect(() => decodeGeneratedPairingCode(value)).toThrow();
  });
});
