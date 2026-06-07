import { describe, expect, it } from "vitest";
import { buildPostagePolicyProjectionHandlers } from "./projection";

describe("ordering postage policy projection", () => {
  it("projects policy creation and activation into the admin read model", async () => {
    const calls: { sql: string; params: unknown[] | undefined }[] = [];
    const db = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        return sql.includes("SELECT payload")
          ? {
              rows: [
                {
                  payload: {
                    policyVersion: "operator-postage-v1",
                    maxLetterUnits: 8,
                    maxLetterWeightOunces: 3.5,
                    maxLetterThicknessInches: 0.25,
                    maxLetterDeclaredValueAmount: 50,
                    letterEnvelopeWeightOunces: 0.4,
                    parcelPackagingWeightOunces: 2,
                    parcelRequiredShippingOptions: ["priority"],
                    letterRequiredPhysicalFlags: ["raw-card"],
                    parcelRequiredPhysicalFlags: ["slab"],
                    signatureRequiredShippingOptions: ["priority"],
                    signatureRequiredDeclaredValueAmount: null,
                    signatureRequiredPhysicalFlags: [],
                  },
                  effective_from: "2026-06-01T00:00:00.000Z",
                  effective_until: null,
                },
              ],
            }
          : { rows: [] };
      },
    };
    const handlers = buildPostagePolicyProjectionHandlers(db as never);

    await handlers["ordering.postage-policy.created"]?.({
      type: "ordering.postage-policy.created",
      data: {
        policyId: "opp_test",
        label: "Default",
        status: "draft",
        payload: {
          policyVersion: "operator-postage-v1",
          maxLetterUnits: 8,
          maxLetterWeightOunces: 3.5,
          maxLetterThicknessInches: 0.25,
          maxLetterDeclaredValueAmount: 50,
          letterEnvelopeWeightOunces: 0.4,
          parcelPackagingWeightOunces: 2,
          parcelRequiredShippingOptions: ["priority"],
          letterRequiredPhysicalFlags: ["raw-card"],
          parcelRequiredPhysicalFlags: ["slab"],
          signatureRequiredShippingOptions: ["priority"],
          signatureRequiredDeclaredValueAmount: null,
          signatureRequiredPhysicalFlags: [],
        },
        effectiveFrom: "2026-06-01T00:00:00.000Z",
        effectiveUntil: null,
        createdByUserId: "usr_admin",
      },
      timing: { recordedAt: "2026-06-01T00:00:00.000Z" },
    } as never);

    await handlers["ordering.postage-policy.activated"]?.({
      type: "ordering.postage-policy.activated",
      data: {
        policyId: "opp_test",
        activatedByUserId: "usr_admin",
        activationReason: "Reviewed",
      },
      timing: { recordedAt: "2026-06-02T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("INSERT INTO ordering_postage_policy_pages");
    expect(calls[0]?.params?.[3]).toBe("operator-postage-v1");
    expect(calls[1]?.sql).toContain("INSERT INTO ordering_postage_policy_history");
    expect(calls[2]?.sql).toContain("SELECT payload");
    expect(calls[3]?.sql).toContain("SET status = 'active'");
    expect(calls[4]?.sql).toContain("INSERT INTO ordering_postage_policy_history");
  });
});
