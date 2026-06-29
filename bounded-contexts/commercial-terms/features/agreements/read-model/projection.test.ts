import { describe, expect, it } from "vitest";
import { buildAgreementProjectionHandlers } from "./projection";

describe("commercial terms agreement projection", () => {
  it("projects revised account fee and allowance terms", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildAgreementProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["commercial-terms.agreement.revised"]?.({
      id: "evt_agreement_revised",
      type: "commercial-terms.agreement.revised",
      data: {
        agreementId: "cag_1",
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: "2027-05-01T00:00:00.000Z",
        revisedByUserId: "usr_admin",
      },
      timing: { recordedAt: "2026-05-01T00:00:01.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("UPDATE commercial_terms_agreement_pages");
    expect(calls[0]?.params).toEqual([
      "cag_1",
      "Preferred renewal",
      600,
      "0.00",
      800,
      "active",
      "2026-05-01T00:00:00.000Z",
      "2027-05-01T00:00:00.000Z",
      "2026-05-01T00:00:01.000Z",
    ]);
    expect(calls[1]?.sql).toContain("INSERT INTO commercial_terms_agreement_history");
    expect(calls[1]?.params).toEqual([
      "cag_1",
      "evt_agreement_revised",
      "revised",
      "usr_admin",
      "active",
      JSON.stringify({
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: "2027-05-01T00:00:00.000Z",
      }),
      "2026-05-01T00:00:00.000Z",
      "2027-05-01T00:00:00.000Z",
      "2026-05-01T00:00:01.000Z",
    ]);
  });

  it("uses stored event audit actor when replaying pre-actor agreement events into history", async () => {
    const calls: { sql: string; params: unknown[] }[] = [];
    const handlers = buildAgreementProjectionHandlers({
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    } as never);

    await handlers["commercial-terms.agreement.revised"]?.({
      id: "evt_agreement_legacy",
      type: "commercial-terms.agreement.revised",
      data: {
        agreementId: "cag_1",
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: "2027-05-01T00:00:00.000Z",
      },
      audit: { performedByUserId: "usr_replay", forAccountId: "acc_admin" },
      timing: { recordedAt: "2026-05-01T00:00:01.000Z" },
    } as never);

    expect(calls[1]?.params[1]).toBe("evt_agreement_legacy");
    expect(calls[1]?.params[3]).toBe("usr_replay");
  });
});
