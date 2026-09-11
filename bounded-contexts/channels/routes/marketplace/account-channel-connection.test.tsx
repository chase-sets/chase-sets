import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loader } from "./account-channel-connection";

describe("Channels account connection route contribution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("declares the exact authenticated account contribution", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../context.json"), "utf8"));
    const contribution = manifest.deployableContributions.find(
      (entry: { deployable: string }) => entry.deployable === "marketplace-web",
    );
    expect(
      contribution.routes.find((route: { routeId: string }) => route.routeId === "account-channel-connection"),
    ).toEqual(
      expect.objectContaining({
        routeId: "account-channel-connection",
        routePath: "account/channels/:connectionId",
        fileExport: "./routes/marketplace/account-channel-connection",
        authorization: { kind: "authenticated", requiredPermissions: ["channels.view"] },
      }),
    );
  });

  it("redirects an unauthenticated actor before a Channels read", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost/account/channels/connection-a");
    await expect(loader(loaderArgs(request))).rejects.toMatchObject({ status: 302 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads auth first and maps a later read failure to the no-table error state", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: actor() }))
      .mockRejectedValueOnce(new Error("synthetic channels read failure"));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost/account/channels/connection-a");
    await expect(loader(loaderArgs(request))).resolves.toEqual({ kind: "read-error" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function actor() {
  return {
    sessionId: "session-a",
    tenantId: "tenant-a",
    userId: "user-a",
    accountId: "acc-owner",
    membershipId: "membership-a",
    roleKey: "owner",
    permissions: ["channels.view"],
  };
}

function loaderArgs(request: Request) {
  return {
    request,
    params: { connectionId: "connection-a" },
    context: {},
    url: new URL(request.url),
    pattern: "/account/channels/:connectionId",
  };
}
