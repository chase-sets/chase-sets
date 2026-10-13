import { describe, expect, it } from "vitest";
import { eligibilityScopeKeys, lockEligibilityScopes } from "./fences";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

describe("issue-7168-ac11-caller-compatibility", () => {
  it("enrolls direct registration, status, membership and Consent writers before stream allocation", () => {
    expect(eligibilityScopeKeys("tnt_test", "identity.account-acc_a", [])).toEqual([
      JSON.stringify(["identity", "tnt_test", "account", "acc_a"]),
    ]);
    expect(
      eligibilityScopeKeys("tnt_test", "identity.membership-mbr_a", [
        { eventType: "identity.membership.granted", payload: { accountId: "acc_a" } },
      ]),
    ).toEqual([JSON.stringify(["identity", "tnt_test", "account", "acc_a"])]);
    const record = {
      eventType: "identity.consent.recorded",
      payload: { subjectType: "user", userId: "usr_a", policyKey: "terms" },
    };
    expect(eligibilityScopeKeys("tnt_test", "identity.consent-cns_a", [record])).toEqual([
      JSON.stringify(["identity", "tnt_test", "consent", "user", "usr_a", "terms"]),
    ]);
    expect(() => eligibilityScopeKeys("tnt_test", "identity.consent-cns_a", [])).toThrow("INDETERMINATE");
  });
  it("sorts and deduplicates scope locks before any stream locks", async () => {
    const calls: string[] = [];
    const db: PgQueryable = {
      query: async (_sql: string, values?: readonly unknown[]) => {
        calls.push(String(values?.[0]));
        return { rows: [] };
      },
    };
    await lockEligibilityScopes(db, ["b", "a", "b"]);
    expect(calls).toEqual(["a", "b"]);
  });
});
