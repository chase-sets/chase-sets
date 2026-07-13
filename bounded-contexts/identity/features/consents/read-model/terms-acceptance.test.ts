import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { resolveTermsAcceptanceStatus } from "./terms-acceptance";

function fakePolicies(version: string): Pick<PolicyRuntime, "resolvePolicy"> {
  return {
    resolvePolicy: vi.fn(async () => ({
      policyKey: "identity.terms-of-service-active-version",
      value: { version },
      source: "policy" as const,
      documentId: "pol_1",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
      resolvedAt: "2026-07-01T00:00:00.000Z",
    })),
  } as unknown as Pick<PolicyRuntime, "resolvePolicy">;
}

function fakeDb(rows: readonly Record<string, unknown>[]) {
  return { query: vi.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as PgQueryable;
}

describe("resolveTermsAcceptanceStatus", () => {
  it("fails closed when no consent fact exists for the subject", async () => {
    const status = await resolveTermsAcceptanceStatus(fakeDb([]), fakePolicies("v2"), {
      userId: "usr_1",
      accountId: "acc_1",
    });

    expect(status).toEqual({
      policyKey: "terms-of-service",
      requiredVersion: "v2",
      accepted: false,
      acceptedVersion: null,
      acceptedAt: null,
    });
  });

  it("is accepted only when the latest recorded version exactly matches the active version", async () => {
    const db = fakeDb([
      {
        consent_id: "cns_1",
        subject_type: "user",
        user_id: "usr_1",
        account_id: "acc_1",
        policy_key: "terms-of-service",
        policy_version: "v1",
        recorded_at: "2026-03-01T00:00:00.000Z",
        updated_at: "2026-03-01T00:00:00.000Z",
      },
    ]);

    const stale = await resolveTermsAcceptanceStatus(db, fakePolicies("v2"), { userId: "usr_1" });
    expect(stale.accepted).toBe(false);
    expect(stale.acceptedVersion).toBe("v1");

    const current = await resolveTermsAcceptanceStatus(db, fakePolicies("v1"), { userId: "usr_1" });
    expect(current.accepted).toBe(true);
    expect(current.acceptedAt).toBe("2026-03-01T00:00:00.000Z");
  });
});
