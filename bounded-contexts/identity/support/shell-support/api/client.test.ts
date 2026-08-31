import { describe, expect, it, vi } from "vitest";
import { createIdentityApiClient } from "./client";

function buildClient() {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json({ id: "acc_1", version: 2, status: "active" });
  });
  return {
    client: createIdentityApiClient({ baseUrl: "https://identity.test/api/identity", fetch }),
    requests,
  };
}

describe("Identity API account enforcement client", () => {
  it("keeps the one-argument lifecycle calls as literal empty JSON objects", async () => {
    const { client, requests } = buildClient();

    await client.suspendAccount("acc_1");
    await client.reactivateAccount("acc_1");
    await client.closeAccount("acc_1");

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/identity/accounts/acc_1/suspend",
      "/api/identity/accounts/acc_1/reactivate",
      "/api/identity/accounts/acc_1/close",
    ]);
    await expect(Promise.all(requests.map((request) => request.clone().json()))).resolves.toEqual([{}, {}, {}]);
  });

  it("forwards a supplied structured lifecycle body unchanged", async () => {
    const { client, requests } = buildClient();
    const body = {
      reason: "policy-violation" as const,
      reference: {
        kind: "support-request" as const,
        supportRequestId: "sup_01ARYZ6S41TSV4RRFFQ69G5FAV" as const,
      },
    };

    await client.suspendAccount("acc_1", body);

    await expect(requests[0]?.json()).resolves.toEqual(body);
  });
});
