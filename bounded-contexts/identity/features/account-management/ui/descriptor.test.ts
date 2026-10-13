import { describe, expect, it } from "vitest";
import { descriptorDisposition, validateDescriptor } from "./descriptor";

describe("issue-7168-ac12-descriptor-day-after", () => {
  const descriptor = {
    version: 1,
    tenantId: "tnt_test",
    userId: "usr_test",
    accountId: "acc_test",
    route: "/account/team",
    action: "revoke",
    target: "mbr_test",
    attempt: "9230f01b-7871-420b-9c32-37139f80f749",
    hash: "a".repeat(64),
    createdAt: "2026-10-12T00:00:00Z",
    sentAt: "2026-10-12T00:00:01Z",
    observedAt: "2026-10-12T00:00:02Z",
  } as const;
  it("retains only inert same-actor ambiguity or reauthentication, never secret-bearing extras", () => {
    expect(validateDescriptor(descriptor)).toEqual(descriptor);
    for (const extra of ["secret", "body", "url", "token", "result", "retry"])
      expect(() => validateDescriptor({ ...descriptor, [extra]: "x" })).toThrow();
    expect(() => validateDescriptor({ ...descriptor, hash: undefined })).toThrow();
    for (const state of ["succeeded", "failed-safe", "conflict", "route-denied"] as const)
      expect(descriptorDisposition(descriptor, state, descriptor)).toBe("discard");
    for (const state of ["ambiguous", "reauth-required"] as const)
      expect(descriptorDisposition(descriptor, state, descriptor)).toBe("retain-inert");
    expect(descriptorDisposition(descriptor, "ambiguous", { ...descriptor, accountId: "acc_other" })).toBe("discard");
    expect(descriptorDisposition(descriptor, "ambiguous", { ...descriptor, tenantId: "tnt_other" })).toBe("discard");
    expect(descriptorDisposition(descriptor, "reauth-required", { ...descriptor, userId: "usr_other" })).toBe(
      "discard",
    );
    expect(descriptorDisposition(descriptor, "ambiguous", null)).toBe("discard");
    const dayAfter = { ...descriptor, observedAt: "2026-10-13T00:00:02Z" };
    expect(descriptorDisposition(validateDescriptor(dayAfter), "ambiguous", descriptor)).toBe("retain-inert");
    for (const patch of [
      { route: "https://foreign.test/account/team" },
      { action: "sixteenth" },
      { target: "key_wrong" },
      { createdAt: "2026-01-01" },
      { sentAt: "2026-02-30T00:00:00Z" },
      { observedAt: "2026-10-11T00:00:00Z" },
      { target: [] },
      { hash: "x".repeat(65) },
    ])
      expect(() => validateDescriptor({ ...descriptor, ...patch })).toThrow();
  });
});
