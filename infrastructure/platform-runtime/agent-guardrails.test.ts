import { describe, expect, it } from "vitest";
import { createAgentGrantRateLimiter, createInMemoryAgentGrantSpendPolicy } from "./agent-guardrails";

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

  it("tracks spend cap authorizations per grant and operation id", async () => {
    const policy = createInMemoryAgentGrantSpendPolicy({ capCents: 1_000, windowMs: 60_000 });

    expect(
      await policy.authorize({
        grantId: "auth_1",
        accountId: "acc_1",
        operation: "create_offer_intent",
        operationId: "op_1",
        amountCents: 700,
      }),
    ).toEqual({ allowed: true });
    expect(
      await policy.authorize({
        grantId: "auth_1",
        accountId: "acc_1",
        operation: "create_offer_intent",
        operationId: "op_1",
        amountCents: 700,
      }),
    ).toEqual({ allowed: true });
    expect(
      await policy.authorize({
        grantId: "auth_1",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_2",
        amountCents: 400,
      }),
    ).toEqual({
      allowed: false,
      reason: "This agent grant exceeded its platform spend cap.",
      remainingCents: 300,
      capCents: 1_000,
    });
    expect(
      await policy.authorize({
        grantId: "auth_2",
        accountId: "acc_1",
        operation: "complete_checkout",
        operationId: "op_3",
        amountCents: 400,
      }),
    ).toEqual({ allowed: true });
  });
});
