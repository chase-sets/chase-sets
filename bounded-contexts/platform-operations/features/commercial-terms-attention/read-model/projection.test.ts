import { describe, expect, it, vi } from "vitest";
import { buildCommercialTermsEffectiveDateAttentionProjectionHandlers } from "./projection";

function policyEvent(
  type: "platform-policy.document.created" | "platform-policy.document.revised",
  data: Record<string, unknown>,
) {
  return {
    id: "evt_terms_attention",
    type,
    data,
    timing: { recordedAt: "2026-07-15T12:00:00.000Z" },
  } as never;
}

describe("commercial terms effective-date attention projection", () => {
  it("projects upcoming schedules and expiring account overrides from published policy facts", async () => {
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCommercialTermsEffectiveDateAttentionProjectionHandlers({ query } as never);

    await handlers["platform-policy.document.created"]?.(
      policyEvent("platform-policy.document.created", {
        documentId: "cts_upcoming",
        policyKey: "commercial-terms.schedule.business",
        status: "active",
        value: { label: "August business terms", accountType: "business" },
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
    );
    await handlers["platform-policy.document.revised"]?.(
      policyEvent("platform-policy.document.revised", {
        documentId: "cag_launch",
        policyKey: "commercial-terms.agreement.acc_seller",
        status: "active",
        value: { label: "Launch override", accountId: "acc_seller" },
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: "2026-08-15T00:00:00.000Z",
      }),
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "cts_upcoming",
      "schedule",
      "August business terms",
      null,
      "active",
      "2026-08-01T00:00:00.000Z",
      null,
      "2026-07-15T12:00:00.000Z",
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "cag_launch",
      "agreement",
      "Launch override",
      "acc_seller",
      "active",
      "2026-07-01T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
      "2026-07-15T12:00:00.000Z",
    ]);
  });

  it("ignores unrelated commercial terms policy documents", async () => {
    const query = vi.fn(async (_sql: string, _parameters: readonly unknown[]) => ({ rows: [] }));
    const handlers = buildCommercialTermsEffectiveDateAttentionProjectionHandlers({ query } as never);

    await handlers["platform-policy.document.created"]?.(
      policyEvent("platform-policy.document.created", {
        documentId: "pol_checkout_fee",
        policyKey: "commercial-terms.checkout-processing-fee",
        status: "active",
        value: {},
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveUntil: null,
      }),
    );

    expect(query).not.toHaveBeenCalled();
  });
});
