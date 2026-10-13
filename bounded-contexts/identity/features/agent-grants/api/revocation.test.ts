import { describe, expect, it } from "vitest";
import { bindingDigest, parseRevocationHistory, type RevocationBinding } from "./revocation";

describe("agent-grant-revocation-concurrency-history", () => {
  it("binds every authority field rather than writing by attempt key only", () => {
    const binding: RevocationBinding = {
      attemptId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
      tenantId: "tenant_a",
      accountId: "account_a",
      grantId: "grant_a",
      userId: "user_a",
      sessionId: "session_a",
      provenance: "session",
      reason: "account_consent_revoked",
      intent: "revoke",
      contractVersion: 1,
    };
    for (const field of ["tenantId", "accountId", "grantId", "userId", "sessionId"] as const)
      expect(bindingDigest({ ...binding, [field]: "changed" })).not.toBe(bindingDigest(binding));
    expect(bindingDigest({ ...binding, provenance: "token" })).not.toBe(bindingDigest(binding));
    expect(bindingDigest({ ...binding, reason: "token_revocation" })).not.toBe(bindingDigest(binding));
    expect(() => bindingDigest({ ...binding, contractVersion: 2 } as unknown as RevocationBinding)).toThrow(
      "revocation_binding_invalid",
    );
    expect(() => bindingDigest({ ...binding, intent: "activate" } as unknown as RevocationBinding)).toThrow(
      "revocation_binding_invalid",
    );
  });
  const owner = {
    operationId: "eea0342d-079b-460e-9dfe-06c42a0a8a70",
    accountId: "account_a",
    grantId: "grant_a",
    revokedAt: "2026-10-12T00:00:00.000Z",
  };
  const history = ["admitted", "identity-terminal", "payments-terminal", "webhook-excluded", "completed"].map(
    (phase, index) => ({
      streamVersion: index + 1,
      eventType: `identity.agent-grant-revocation.${phase}`,
      payload: owner,
    }),
  );
  it("retains every phase rather than treating terminal Identity as completion", () => {
    expect(parseRevocationHistory(history.slice(0, 2), owner)).toMatchObject({
      phase: "identity-terminal",
      version: 2,
    });
    expect(parseRevocationHistory(history, owner)).toMatchObject({ phase: "completed", version: 5 });
  });
  it.each(["duplicate", "missing", "contradictory", "over-limit", "invalid-instant", "unknown-field", "uuid-array"])(
    "fails closed on %s histories",
    (poison) => {
      let events = structuredClone(history);
      if (poison === "duplicate") events[2] = { ...events[1], streamVersion: 3 };
      if (poison === "missing") events.splice(1, 1);
      if (poison === "contradictory") events[2].payload.accountId = "account_b";
      if (poison === "over-limit")
        events = Array.from({ length: 501 }, (_, index) => ({ ...history[0], streamVersion: index + 1 }));
      if (poison === "invalid-instant") events[0].payload.revokedAt = "invalid";
      if (poison === "unknown-field") Object.assign(events[0].payload, { token: "synthetic-secret" });
      if (poison === "uuid-array") Object.assign(events[0].payload, { operationId: [owner.operationId] });
      expect(() => parseRevocationHistory(events, owner)).toThrow("revocation_history_invalid");
    },
  );
  it.each([6, 500, 501])("never trusts a valid prefix of a %s event history", (count) => {
    const events = [
      ...history,
      ...Array.from({ length: count - 5 }, (_, index) => ({ ...history[4], streamVersion: index + 6 })),
    ];
    expect(() => parseRevocationHistory(events, owner)).toThrow("revocation_history_invalid");
  });
});
