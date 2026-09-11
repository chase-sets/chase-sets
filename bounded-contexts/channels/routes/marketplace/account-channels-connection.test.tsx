import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { action, loader, readActionError } from "./account-channels-connection";
import { action as downloadAction } from "./account-channel-connection-manual-sync-download";

describe("Channels account connection route contribution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("declares the canonical authenticated account contribution and separate download resource", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../context.json"), "utf8"));
    expect(manifest.deployableContributions).toEqual([
      expect.objectContaining({
        deployable: "marketplace-web",
        routes: expect.arrayContaining([
          expect.objectContaining({
            routeId: "channels-connection-detail",
            routePath: "account/channels/:connectionId",
            fileExport: "./routes/marketplace/account-channels-connection",
            authorization: { kind: "authenticated", requiredPermissions: ["channels.view"] },
          }),
          expect.objectContaining({
            routeId: "account-channel-connection-manual-sync-download",
            routePath: "account/channels/:connectionId/manual-sync/download",
            fileExport: "./routes/marketplace/account-channel-connection-manual-sync-download",
            delivery: "web-resource-only",
            authorization: { kind: "authenticated", requiredPermissions: ["channels.manage"] },
          }),
        ]),
      }),
    ]);
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
      .mockResolvedValueOnce(Response.json({ connection: actorConnection() }))
      .mockRejectedValueOnce(new Error("synthetic channels read failure"))
      .mockRejectedValueOnce(new Error("synthetic manual sync read failure"));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost/account/channels/connection-a");
    await expect(loader(loaderArgs(request))).resolves.toMatchObject({
      kind: "ready",
      operationLog: { kind: "read-error" },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("loads the manual panel and operation log from the same authorized connection surface", async () => {
    const connection = {
      connectionId: "connection-a",
      providerKey: "tcgplayer",
      environment: "production",
      status: "active",
      createdAt: "2026-09-10T12:00:00.000Z",
    };
    const manualSync = {
      connection,
      inboundCoverage: { state: "dark", reason: "no-inbound-authority" },
      run: null,
      actions: ["ingest-live", "ingest-staged", "compose"],
      leaseCountdownMs: null,
      requestedListingCount: 0,
      composedListingCount: 0,
      attentionReason: null,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: actor() }))
      .mockResolvedValueOnce(Response.json(connection))
      .mockResolvedValueOnce(
        Response.json({
          connection,
          log: { items: [], completeness: { kind: "complete", total: 0 } },
          summary: {
            completeness: { kind: "complete", total: 0 },
            succeeded: 0,
            failed: 0,
            pending: 0,
            inFlight: 0,
            blocked: 0,
            inlineEventToProviderAckMs: { p50: null, p95: null, p99: null },
            claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
          },
        }),
      )
      .mockResolvedValueOnce(Response.json(manualSync));
    vi.stubGlobal("fetch", fetch);
    await expect(loader(loaderArgs(new Request("http://localhost/account/channels/connection-a")))).resolves.toEqual(
      expect.objectContaining({ kind: "ready", connection, manualSync }),
    );
  });

  it("posts the recovery retry through the revision-fenced manual-sync route", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: { ...actor(), permissions: ["channels.manage"] } }))
      .mockResolvedValueOnce(Response.json({ attentionReason: null }));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost/account/channels/connection-a", {
      method: "POST",
      body: new URLSearchParams({ intent: "retry-clamp", runId: "run-recovery", expectedRevision: "7" }),
    });

    await expect(action(loaderArgs(request))).resolves.toMatchObject({ status: 302 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "http://localhost/api/channels/connections/connection-a/manual-sync/runs/run-recovery/retry-clamp?expectedRevision=7",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("downloads through the authenticated resource route without changing attachment status, bytes, or headers", async () => {
    const csv = "TCGplayer Id,Add to Quantity,TCG Marketplace Price\n123,1,2.34\n";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: { ...actor(), permissions: ["channels.manage"] } }))
      .mockResolvedValueOnce(
        new Response(csv, {
          status: 206,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="tcgplayer-staged-run-resource.csv"',
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const request = new Request("http://localhost/account/channels/connection-a/manual-sync/download", {
      method: "POST",
      headers: { cookie: "session=synthetic-owner" },
      body: new URLSearchParams({ runId: "run-resource", expectedRevision: "7" }),
    });

    const response = await downloadAction(loaderArgs(request));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "http://localhost/api/channels/connections/connection-a/manual-sync/runs/run-resource/download?expectedRevision=7",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("cookie")).toBe("session=synthetic-owner");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="tcgplayer-staged-run-resource.csv"',
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(csv));
  });

  it("reads only object error results for the account-route banner", () => {
    expect(readActionError({ error: "synthetic failure" })).toBe("synthetic failure");
    expect(readActionError("TCGplayer Id,Add to Quantity,TCG Marketplace Price\n")).toBeNull();
    expect(readActionError(new Response("csv"))).toBeNull();
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

function actorConnection() {
  return {
    connectionId: "connection-a",
    providerKey: "tcgplayer",
    environment: "production",
    status: "active",
    createdAt: "2026-09-10T12:00:00.000Z",
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
