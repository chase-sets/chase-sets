import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeCommitReceipt, readFreshWriteToken } from "@chase-sets/http/responses";
import { action } from "./account-product-alerts";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.view"],
};

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const commitHeaders = {
  "Chase-Sets-Consistency": "eventual",
  "Chase-Sets-Commit-Position": "42",
  "Chase-Sets-Commit-Event-Ids": "evt_discovery_42",
  "Chase-Sets-Commit-Receipt": encodeCommitReceipt([
    { sourceContextName: "discovery", maxGlobalPosition: "42", eventIds: ["evt_discovery_42"] },
  ]),
};

let writes: string[];

beforeEach(() => {
  writes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/session") return json({ actor });
      if ((init.method ?? "GET").toUpperCase() === "POST") {
        writes.push(url.pathname);
        return json({ id: "pal_1", version: 2, status: url.pathname.split("/").at(-1) }, 200, commitHeaders);
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(intent: string) {
  return action({
    request: new Request("http://localhost/account/product-alerts", {
      method: "POST",
      body: new URLSearchParams({ intent, alertId: "pal_1" }),
    }),
    params: {},
    context: {},
  } as never) as Promise<Response>;
}

describe("Product alert account action", () => {
  it.each(["pause", "resume", "delete"])(
    "%s goes to the Product alerts settings in one hop, carrying the write's receipt",
    async (intent) => {
      const response = await post(intent);

      expect(writes).toEqual([`/api/marketplace/account/product-alerts/pal_1/${intent}`]);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("Location") ?? "", "http://localhost");
      expect(location.pathname).toBe("/account/notifications");
      expect(location.searchParams.get("view")).toBe("settings");
      expect(location.searchParams.get("section")).toBe("product-alerts");
      expect(readFreshWriteToken(location)?.sources).toEqual([
        { sourceContextName: "discovery", maxGlobalPosition: "42", eventIds: ["evt_discovery_42"] },
      ]);
    },
  );

  it("sends an unknown intent to the settings without a receipt or a write", async () => {
    const response = await post("archive");

    expect(writes).toEqual([]);
    expect(response.headers.get("Location")).toBe("/account/notifications?view=settings&section=product-alerts");
  });
});
