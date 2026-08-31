import { describe, expect, it } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  attachResponseMetadata,
  encodeFreshWriteReceipt,
  navigateAfterWriteFromSources,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { loadPortableAccountRoute, mutatePortableAccountRoute } from "../ui/portable-route";

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function commitResponse(body: unknown) {
  return Response.json(body, {
    headers: {
      "Chase-Sets-Consistency": "read-your-writes",
      "Chase-Sets-Commit-Position": "42",
      "Chase-Sets-Commit-Event-Ids": "evt_1",
    },
  });
}

describe("portable Account route", () => {
  it("maps an expired bearer session to unauthorized", async () => {
    const fetch: PortableClientFetch = () => Promise.resolve(Response.json({ error: "expired" }, { status: 401 }));
    await expect(
      loadPortableAccountRoute(
        { url: new URL("https://mobile.local/account"), params: {} },
        { apiOrigin: "https://api.chasesets.test", fetch },
      ),
    ).resolves.toEqual({ kind: "unauthorized" });
  });

  it("preserves server validation errors from profile mutation", async () => {
    const fetch: PortableClientFetch = (input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/auth/session") {
        return Promise.resolve(
          Response.json({ actor: { accountId: "acct_1", permissions: ["accounts.view", "accounts.manage"] } }),
        );
      }
      return Promise.resolve(Response.json({ fieldErrors: { displayName: "Already used" } }, { status: 422 }));
    };
    const formData = new FormData();
    formData.set("intent", "update-profile");
    formData.set("name", "Trader");
    formData.set("displayName", "Trader");

    await expect(
      mutatePortableAccountRoute(
        { url: new URL("https://mobile.local/account"), params: {}, formData },
        { apiOrigin: "https://api.chasesets.test", fetch },
      ),
    ).resolves.toEqual({
      kind: "validation-error",
      error: { fieldErrors: { displayName: "Already used" } },
    });
  });

  it("carries the account PUT receipt on the navigation outcome", async () => {
    const fetch: PortableClientFetch = (input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/auth/session") {
        return Promise.resolve(
          Response.json({ actor: { accountId: "acct_1", permissions: ["accounts.view", "accounts.manage"] } }),
        );
      }
      return Promise.resolve(commitResponse({ account_id: "acct_1" }));
    };
    const formData = new FormData();
    formData.set("intent", "update-profile");
    formData.set("name", "Trader");
    formData.set("displayName", "Trader");

    const outcome = await mutatePortableAccountRoute(
      { url: new URL("https://mobile.local/account"), params: {}, formData },
      { apiOrigin: "https://api.chasesets.test", fetch },
    );

    expect(outcome.kind).toBe("navigate");
    if (outcome.kind !== "navigate") throw new Error("Expected portable account mutation to navigate.");
    expect(readFreshWriteToken(outcome.to)).toMatchObject({ commitPosition: "42" });
  });

  it("forwards a tokenized load receipt to the account read", async () => {
    let accountReadHeader: string | null = null;
    const fetch: PortableClientFetch = (input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/auth/session") {
        return Promise.resolve(Response.json({ actor: { accountId: "acct_1", permissions: ["accounts.view"] } }));
      }
      if (url.pathname === "/api/identity/accounts/acct_1") {
        accountReadHeader = new Headers(init?.headers).get(CHASE_SETS_READ_AFTER_WRITE_HEADER);
        return Promise.resolve(Response.json({ account_id: "acct_1" }));
      }
      return Promise.resolve(Response.json({}));
    };
    const result = attachResponseMetadata({ account_id: "acct_1" }, commitResponse({ account_id: "acct_1" }));
    const destination = navigateAfterWriteFromSources([result], "/account");
    const receipt = readFreshWriteToken(destination);
    if (!receipt) throw new Error("Expected test navigation to carry a fresh-write receipt.");

    await loadPortableAccountRoute(
      { url: new URL(destination, "https://mobile.local"), params: {} },
      { apiOrigin: "https://api.chasesets.test", fetch },
    );

    expect(accountReadHeader).toBe(encodeFreshWriteReceipt(receipt));
  });
});
