import {
  evaluatePricingAccountRepricingRollout,
  requirePricingAccountRepricingRollout,
} from "../support/request-support/rollout-guard";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { describe, expect, it } from "vitest";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "owner",
  permissions: ["pricing.view", "pricing.manage"],
};

describe("pricing account repricing rollout guard", () => {
  it("requests a Platform Operations account decision before exposing repricing", async () => {
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return Response.json({
        enabled: true,
        reason: "subject-allowlist",
        bucket: 42,
        featureKey: "pricing.account-repricing",
        environment: "production",
        subject: { subjectType: "account", subjectId: "acc_1" },
        cohortSize: 1,
      });
    };

    const decision = await evaluatePricingAccountRepricingRollout(
      new Request("https://market.example.com/account/repricing"),
      actor,
      {
        fetch,
        environment: "production",
      },
    );

    expect(decision.enabled).toBe(true);
    expect(calls[0]).toContain("/api/platform/release-controls/rollouts/pricing.account-repricing/decision");
    expect(calls[0]).toContain("subjectType=account");
    expect(calls[0]).toContain("subjectId=acc_1");
  });

  it("fails closed when the rollout decision is disabled", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({
        enabled: false,
        reason: "kill-switch",
        bucket: 42,
        featureKey: "pricing.account-repricing",
        environment: "production",
        subject: { subjectType: "account", subjectId: "acc_1" },
        cohortSize: 1,
      });

    await expect(
      requirePricingAccountRepricingRollout(new Request("https://market.example.com/account/repricing"), actor, {
        fetch,
        environment: "production",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
