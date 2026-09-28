import { describe, expect, it } from "vitest";
import { identityFixture } from "./listing-authority-test-support";

describe("Identity retained account fact decoding", () => {
  it("decodes actual owner grants without reading a projection", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    expect(f.authority.sellerFacts(grant)).toEqual({ badgeKeys: [] });
    expect(f.authority.accountFacts(grant)).toEqual({
      account_id: f.accountId,
      account_type: "personal",
      status: "active",
      founders_window_started_at: null,
      founders_window_ends_at: null,
    });
  });

  it("preserves the exact founder window and seller badges", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    const window = { startedAt: "2026-01-01T00:00:00.000Z", endsAt: "2027-01-01T00:00:00.000Z" };
    const facts = { ...grant, value: { ...grant.value, badges: ["founding-account"], foundersWindow: window } };
    expect(f.authority.sellerFacts(facts)).toEqual({ badgeKeys: ["founding-account"] });
    expect(f.authority.accountFacts(facts)).toMatchObject({
      founders_window_started_at: window.startedAt,
      founders_window_ends_at: window.endsAt,
    });
  });

  it("rejects foreign, settled, cross-account and malformed facts", async () => {
    const f = await identityFixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    for (const invalid of [
      { ...grant, participant: { owner: "catalog", purpose: "product-measures" } as const },
      { ...grant, status: "released" as const },
      ...[
        { accountId: "acc_other" },
        { accountType: "unknown" },
        { badges: ["unknown"] },
        { foundersWindow: {} },
        { foundersWindow: { startedAt: "invalid", endsAt: "invalid" } },
      ].map((value) => ({ ...grant, value: { ...grant.value, ...value } })),
    ]) {
      expect(() => f.authority.accountFacts(invalid)).toThrow("Identity");
      expect(() => f.authority.sellerFacts(invalid)).toThrow("Identity");
    }
  });
});
