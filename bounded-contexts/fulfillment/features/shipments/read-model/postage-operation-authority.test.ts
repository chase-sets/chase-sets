import { describe, expect, it } from "vitest";
import { postageOperationRecoveryStatus, type PostageOperationAuthority } from "./postage-operation-authority";

function invoking(overrides: Partial<PostageOperationAuthority> = {}): PostageOperationAuthority {
  return {
    status: "invoking",
    claim_token: "claim-current",
    claim_expires_at: "2026-08-24T12:01:00.000Z",
    ...overrides,
  } as PostageOperationAuthority;
}

describe("postage operation recovery status", () => {
  it("classifies only a live invoking owner as provider-pending", () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    expect(postageOperationRecoveryStatus(invoking(), now)).toBe("provider-pending");
    expect(postageOperationRecoveryStatus(invoking({ claim_token: null }), now)).toBe("ambiguous");
    expect(postageOperationRecoveryStatus(invoking({ claim_expires_at: "2026-08-24T11:59:59.999Z" }), now)).toBe(
      "ambiguous",
    );
  });
});
