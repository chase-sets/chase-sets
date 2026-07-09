import { describe, expect, it } from "vitest";
import {
  createAgentGrantRateLimiter,
  createInMemoryAgentGrantSpendPolicy,
  decideAgentGrantSpend,
  HANDOFF_ONLY_SPENDING_MANDATE,
  type AgentSpendingMandate,
} from "./agent-guardrails";

const AUTONOMOUS_MANDATE: AgentSpendingMandate = {
  maxPerOrderCents: 4_000,
  dailyCapCents: 5_000,
  monthlyCapCents: 20_000,
  humanPresentRequired: false,
  allowedRails: ["ap2"],
};

describe("agent guardrails", () => {
  it("rate limits writes by agent grant instead of only account", () => {
    const limiter = createAgentGrantRateLimiter({ max: 1, windowMs: 60_000 });

    const first = limiter.check({
      grantId: "auth_1",
      accountId: "acc_1",
      actorId: "usr_1",
      operation: "complete_checkout",
    });
    const secondSameGrant = limiter.check({
      grantId: "auth_1",
      accountId: "acc_1",
      actorId: "usr_1",
      operation: "complete_checkout",
    });
    const differentGrant = limiter.check({
      grantId: "auth_2",
      accountId: "acc_1",
      actorId: "usr_1",
      operation: "complete_checkout",
    });

    expect(first.allowed).toBe(true);
    expect(secondSameGrant.allowed).toBe(false);
    expect(differentGrant.allowed).toBe(true);
  });

  describe("decideAgentGrantSpend", () => {
    const base = {
      amountCents: 1_000,
      rail: "ap2" as const,
      humanPresent: false,
      humanNotPresentAuthorized: true,
      spentDailyCents: 0,
      spentMonthlyCents: 0,
    };

    it("denies autonomous rails under the conservative default handoff-only mandate", () => {
      const decision = decideAgentGrantSpend({ ...base, mandate: HANDOFF_ONLY_SPENDING_MANDATE });
      expect(decision).toMatchObject({ allowed: false, limitKind: "rail-not-allowed" });
    });

    it("requires a person when the mandate flag demands human presence", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        mandate: { ...AUTONOMOUS_MANDATE, humanPresentRequired: true },
      });
      expect(decision).toMatchObject({ allowed: false, limitKind: "human-present-required" });
    });

    it("blocks human-not-present purchases when the rail carries no HNP authorization", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        humanNotPresentAuthorized: false,
        mandate: AUTONOMOUS_MANDATE,
      });
      expect(decision).toMatchObject({ allowed: false, limitKind: "human-not-present-unsupported" });
    });

    it("allows a human-present purchase even without an HNP authorization", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        humanPresent: true,
        humanNotPresentAuthorized: false,
        mandate: AUTONOMOUS_MANDATE,
      });
      expect(decision).toEqual({ allowed: true });
    });

    it("names the per-order cap when a single purchase is too large", () => {
      const decision = decideAgentGrantSpend({ ...base, amountCents: 6_000, mandate: AUTONOMOUS_MANDATE });
      expect(decision).toMatchObject({
        allowed: false,
        limitKind: "per-order-cap",
        capCents: 4_000,
      });
      if (!decision.allowed) {
        expect(decision.reason).toContain("$40.00 per-order limit");
      }
    });

    it("denies a $60 purchase against a $50 daily cap and names the remaining budget", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        amountCents: 6_000,
        mandate: { ...AUTONOMOUS_MANDATE, maxPerOrderCents: null, dailyCapCents: 5_000 },
      });
      expect(decision).toMatchObject({
        allowed: false,
        limitKind: "daily-cap",
        capCents: 5_000,
        remainingCents: 5_000,
      });
      if (!decision.allowed) {
        expect(decision.reason).toContain("$50.00 daily limit");
      }
    });

    it("counts prior spend within the daily window toward the cap", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        amountCents: 3_000,
        spentDailyCents: 3_000,
        mandate: { ...AUTONOMOUS_MANDATE, maxPerOrderCents: null, dailyCapCents: 5_000 },
      });
      expect(decision).toMatchObject({ allowed: false, limitKind: "daily-cap", remainingCents: 2_000 });
    });

    it("enforces the monthly cap after the daily window clears", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        amountCents: 3_000,
        spentDailyCents: 0,
        spentMonthlyCents: 18_000,
        mandate: { ...AUTONOMOUS_MANDATE, maxPerOrderCents: null, dailyCapCents: null, monthlyCapCents: 20_000 },
      });
      expect(decision).toMatchObject({ allowed: false, limitKind: "monthly-cap", remainingCents: 2_000 });
    });

    it("applies the platform ceiling as an additional daily bound", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        amountCents: 4_000,
        mandate: { ...AUTONOMOUS_MANDATE, maxPerOrderCents: null, dailyCapCents: 100_000 },
        platformCeilingCents: 3_000,
      });
      expect(decision).toMatchObject({ allowed: false, limitKind: "daily-cap", capCents: 3_000 });
    });

    it("does not apply rail or human-presence gates to purchase-intent operations (null rail)", () => {
      const decision = decideAgentGrantSpend({
        ...base,
        rail: null,
        humanPresent: false,
        humanNotPresentAuthorized: false,
        mandate: { ...AUTONOMOUS_MANDATE, dailyCapCents: null, maxPerOrderCents: null },
      });
      expect(decision).toEqual({ allowed: true });
    });
  });

  describe("createInMemoryAgentGrantSpendPolicy", () => {
    it("accumulates authorized spend per grant and blocks once the daily cap is exhausted", async () => {
      const policy = createInMemoryAgentGrantSpendPolicy({
        mandateResolver: () => ({ ...AUTONOMOUS_MANDATE, maxPerOrderCents: null, dailyCapCents: 5_000 }),
      });
      const context = { rail: "ap2" as const, humanPresent: false, humanNotPresentAuthorized: true };

      expect(
        await policy.authorize({
          grantId: "auth_1",
          accountId: "acc_1",
          operation: "complete_checkout",
          operationId: "op_1",
          amountCents: 3_000,
          ...context,
        }),
      ).toEqual({ allowed: true });

      // Idempotent retry of the same operation does not double-count.
      expect(
        await policy.authorize({
          grantId: "auth_1",
          accountId: "acc_1",
          operation: "complete_checkout",
          operationId: "op_1",
          amountCents: 3_000,
          ...context,
        }),
      ).toEqual({ allowed: true });

      expect(
        await policy.authorize({
          grantId: "auth_1",
          accountId: "acc_1",
          operation: "complete_checkout",
          operationId: "op_2",
          amountCents: 3_000,
          ...context,
        }),
      ).toMatchObject({ allowed: false, limitKind: "daily-cap", remainingCents: 2_000 });

      // A different grant is unaffected.
      expect(
        await policy.authorize({
          grantId: "auth_2",
          accountId: "acc_1",
          operation: "complete_checkout",
          operationId: "op_3",
          amountCents: 3_000,
          ...context,
        }),
      ).toEqual({ allowed: true });
    });

    it("resets the counter once prior authorizations age out of the daily window", async () => {
      let current = new Date("2026-07-08T00:00:00.000Z");
      const policy = createInMemoryAgentGrantSpendPolicy({
        now: () => current,
        mandateResolver: () => ({ ...AUTONOMOUS_MANDATE, maxPerOrderCents: null, dailyCapCents: 5_000 }),
      });
      const context = { rail: "ap2" as const, humanPresent: false, humanNotPresentAuthorized: true };

      expect(
        await policy.authorize({
          grantId: "auth_1",
          accountId: "acc_1",
          operation: "complete_checkout",
          operationId: "op_1",
          amountCents: 4_000,
          ...context,
        }),
      ).toEqual({ allowed: true });

      current = new Date("2026-07-09T01:00:00.000Z");
      expect(
        await policy.authorize({
          grantId: "auth_1",
          accountId: "acc_1",
          operation: "complete_checkout",
          operationId: "op_2",
          amountCents: 4_000,
          ...context,
        }),
      ).toEqual({ allowed: true });
    });
  });
});
