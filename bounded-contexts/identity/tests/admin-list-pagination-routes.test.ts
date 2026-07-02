import { afterEach, describe, expect, it, vi } from "vitest";
import { loader as accountsLoader } from "../routes/admin/accounts";
import { loader as apiKeysLoader } from "../routes/admin/api-keys";
import { loader as invitationsLoader } from "../routes/admin/invitations";
import { loader as membershipsLoader } from "../routes/admin/memberships";
import { loader as usersLoader } from "../routes/admin/users";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

function loaderRequest(path: string) {
  return new Request(`https://admin.chasesets.test${path}`, {
    headers: { cookie: "session=identity" },
  });
}

describe("Identity admin list pagination routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["accounts", accountsLoader, "/access/accounts?limit=25&offset=50", ["/api/identity/accounts?limit=25&offset=50"]],
    ["users", usersLoader, "/access/users?limit=25&offset=50", ["/api/identity/users?limit=25&offset=50"]],
    [
      "memberships",
      membershipsLoader,
      "/access/memberships?limit=25&offset=50",
      ["/api/identity/memberships?limit=25&offset=50"],
    ],
    [
      "invitations",
      invitationsLoader,
      "/access/invitations?limit=25&offset=50",
      ["/api/identity/invitations?limit=25&offset=50"],
    ],
    [
      "api keys",
      apiKeysLoader,
      "/access/api-keys?limit=25&offset=50",
      ["/api/identity/api-keys?limit=25&offset=50", "/api/identity/users?limit=500&offset=0"],
    ],
  ])("forwards URL pagination to the %s API list", async (_name, loader, routePath, expectedApiPaths) => {
    const observedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        observedUrls.push(requestUrl(input));
        return jsonResponse({ items: [], total: 72, count: 0 });
      }),
    );

    await loader({
      request: loaderRequest(routePath),
      params: {},
      context: undefined,
    } as never);

    expect(observedUrls.map((url) => new URL(url).pathname + new URL(url).search).sort()).toEqual(
      [...expectedApiPaths].sort(),
    );
  });

  it("normalizes unsafe list pagination before forwarding it to Identity APIs", async () => {
    const observedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        observedUrls.push(requestUrl(input));
        return jsonResponse({ items: [], total: 0, count: 0 });
      }),
    );

    await usersLoader({
      request: loaderRequest("/access/users?limit=999999&offset=-1%20UNION%20SELECT"),
      params: {},
      context: undefined,
    } as never);

    expect(observedUrls).toHaveLength(1);
    const apiUrl = new URL(observedUrls[0]!);
    expect(`${apiUrl.pathname}${apiUrl.search}`).toBe("/api/identity/users?limit=500&offset=0");
  });
});
