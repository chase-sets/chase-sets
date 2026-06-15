import { describe, expect, it, vi } from "vitest";
import { createPlatformOperationsApiClient } from "./client";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("release controls API client", () => {
  it("returns policy snapshots after release lock and rollout writes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/release-lock")) {
        return jsonResponse({
          releaseLock: { locked: true, reason: "incident", reference: "inc_1" },
          rolloutPolicies: [],
        });
      }
      return jsonResponse({
        releaseLock: { locked: true, reason: "incident", reference: "inc_1" },
        rolloutPolicies: [
          {
            featureKey: "pricing.account-repricing",
            environment: "production",
            percentage: 10,
            allowSubjects: ["account:acc_1"],
            optOutSubjects: [],
            killSwitchActive: false,
            updatedAt: "2026-06-15T00:00:00.000Z",
            updatedByUserId: "usr_ops",
            updatedByAccountId: "acc_ops",
            reason: "canary",
            reference: "pr_1",
          },
        ],
      });
    });
    const client = createPlatformOperationsApiClient({ baseUrl: "https://api.example.test", fetch: fetchMock });

    await expect(client.setReleaseLock({ locked: true, reason: "incident", reference: "inc_1" })).resolves.toEqual({
      releaseLock: { locked: true, reason: "incident", reference: "inc_1" },
      rolloutPolicies: [],
    });
    await expect(
      client.setRolloutPolicy("pricing.account-repricing", {
        environment: "production",
        percentage: 10,
        allowSubjects: ["account:acc_1"],
        reason: "canary",
        reference: "pr_1",
      }),
    ).resolves.toMatchObject({
      rolloutPolicies: [
        {
          featureKey: "pricing.account-repricing",
          environment: "production",
          percentage: 10,
        },
      ],
    });
  });
});
