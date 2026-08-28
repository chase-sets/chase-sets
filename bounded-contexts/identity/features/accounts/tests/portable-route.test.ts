import { describe, expect, it } from "vitest";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { loadPortableAccountRoute, mutatePortableAccountRoute } from "../ui/portable-route";

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : input.toString());
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
});
