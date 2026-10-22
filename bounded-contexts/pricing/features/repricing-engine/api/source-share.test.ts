import { describe, expect, it, vi } from "vitest";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import { getRepricingSourceShareReport, resolveBulkRepriceSunsetPolicy } from "./source-share";

const policy = { maxBulkSharePercent: 0, consecutiveCompleteWeeks: 1, relianceListingThreshold: 0 };

function policyDb(value: unknown, present = true) {
  return {
    query: vi.fn().mockResolvedValue({
      rows: present ? [{ document_id: "doc_sunset", value, effective_from: "2026-01-01", effective_until: null }] : [],
    }),
  };
}

describe("source-share report policy boundary", () => {
  it("never substitutes the registry fallback for a missing threshold policy", async () => {
    expect(await resolveBulkRepriceSunsetPolicy(createPolicyResolver({ db: policyDb(null, false) }))).toBeNull();
  });

  it("preserves explicit zero and treats a malformed active policy as unknown", async () => {
    expect(await resolveBulkRepriceSunsetPolicy(createPolicyResolver({ db: policyDb(policy) }))).toEqual(policy);
    expect(
      await resolveBulkRepriceSunsetPolicy(createPolicyResolver({ db: policyDb({ ...policy, extra: true }) })),
    ).toBeNull();
  });

  it("propagates database failure instead of displaying zeros", async () => {
    const db = { query: vi.fn().mockRejectedValue(new Error("database-unavailable")) };
    await expect(getRepricingSourceShareReport(db, { from: "2026-10-04", to: "2026-10-04" })).rejects.toThrow(
      "database-unavailable",
    );
  });

  it("returns incomplete weeks and an unknown decision without evidence", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await getRepricingSourceShareReport(db, { from: "2026-10-04", to: "2026-10-04" })).toMatchObject({
      status: "available",
      weeks: [{ status: "incomplete", reason: "checkpoint-lag" }],
      decision: { status: "unknown", reasons: ["policy-not-configured"] },
    });
  });

  it("exposes an invalid range as unavailable, not zero activity", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await getRepricingSourceShareReport(db, { from: "bad", to: "2026-10-04" })).toEqual({
      status: "unavailable",
      weeks: [],
      reason: "invalid-week-range",
    });
  });
});
