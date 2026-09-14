// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountChannelsConnectionRoute, { action, loader, readActionError } from "./account-channels-connection";
import { action as downloadAction } from "./account-channel-connection-manual-sync-download";

describe("Channels account connection route contribution", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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

  it("preserves a loaded Manual Sync panel when the operation-log transport fails", async () => {
    const fetch = auxiliaryFetch({
      operation: () => Promise.reject(new Error("synthetic operation-log transport failure")),
      manualSync: () => Response.json(manualSyncPanel()),
    });
    vi.stubGlobal("fetch", fetch);
    await expect(loader(loaderArgs(routeRequest()))).resolves.toMatchObject({
      kind: "ready",
      manualSync: { kind: "loaded", data: manualSyncPanel() },
      operationLog: { kind: "read-error" },
      drift: { kind: "not-yet-observed" },
    });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("renders the valid Manual Sync panel with the named operation-log error", async () => {
    vi.stubGlobal(
      "fetch",
      auxiliaryFetch({
        operation: () => Promise.reject(new Error("synthetic operation-log transport failure")),
        manualSync: () => Response.json(manualSyncPanel()),
      }),
    );

    renderRoute();

    expect(await screen.findByRole("button", { name: "Compose Staged batch" })).toBeTruthy();
    expect(await screen.findByText("Publication activity is unavailable")).toBeTruthy();
  });

  it("renders exactly one Manual TCGplayer sync panel heading", async () => {
    vi.stubGlobal(
      "fetch",
      auxiliaryFetch({
        operation: () => Response.json(operationLogBody()),
        manualSync: () => Response.json(manualSyncPanel()),
      }),
    );
    renderRoute();
    expect(await screen.findAllByRole("heading", { name: "Manual TCGplayer sync" })).toHaveLength(1);
  });

  it("preserves a loaded operation log when Manual Sync returns 503", async () => {
    const fetch = auxiliaryFetch({
      operation: () => Response.json(operationLogBody()),
      manualSync: () => new Response("synthetic manual-sync unavailable", { status: 503 }),
    });
    vi.stubGlobal("fetch", fetch);

    await expect(loader(loaderArgs(routeRequest()))).resolves.toMatchObject({
      kind: "ready",
      manualSync: { kind: "read-error" },
      operationLog: { kind: "loaded", log: { items: [] } },
      drift: { kind: "not-yet-observed" },
    });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it("renders the named Manual Sync error with the valid operation log", async () => {
    vi.stubGlobal(
      "fetch",
      auxiliaryFetch({
        operation: () => Response.json(operationLogBody()),
        manualSync: () => new Response("synthetic manual-sync unavailable", { status: 503 }),
      }),
    );

    renderRoute();

    expect(await screen.findByText("Manual TCGplayer sync is unavailable")).toBeTruthy();
    expect(await screen.findByText("No publication activity")).toBeTruthy();
  });

  it("preserves manual, operation-log and attention children when drift alone fails", async () => {
    vi.stubGlobal(
      "fetch",
      auxiliaryFetch({
        operation: () => Response.json(operationLogBody()),
        manualSync: () => Response.json(manualSyncPanel()),
        drift: () => new Response(null, { status: 503 }),
      }),
    );
    await expect(loader(loaderArgs(routeRequest()))).resolves.toMatchObject({
      drift: { kind: "unavailable" },
      manualSync: { kind: "loaded", data: manualSyncPanel() },
      operationLog: { kind: "loaded", log: { items: [] } },
      attention: { kind: "loaded" },
    });
  });

  it("preserves manual and operation-log children when attention alone fails", async () => {
    vi.stubGlobal(
      "fetch",
      auxiliaryFetch({
        operation: () => Response.json(operationLogBody()),
        manualSync: () => Response.json(manualSyncPanel()),
        attention: () => new Response(null, { status: 503 }),
      }),
    );
    renderRoute();
    expect(await screen.findByText("Channel health and attention is unavailable")).toBeTruthy();
    expect(await screen.findByText("No publication activity")).toBeTruthy();
    expect(await screen.findAllByRole("heading", { name: "Manual TCGplayer sync" })).toHaveLength(1);
  });

  it("contains auxiliary status and JSON decoding failures without losing the successful sibling", async () => {
    const operationStatus = auxiliaryFetch({
      operation: () => new Response("unavailable", { status: 503 }),
      manualSync: () => Response.json(manualSyncPanel()),
    });
    vi.stubGlobal("fetch", operationStatus);
    await expect(loader(loaderArgs(routeRequest()))).resolves.toMatchObject({
      manualSync: { kind: "loaded", data: manualSyncPanel() },
      operationLog: { kind: "read-error" },
    });

    const manualDecode = auxiliaryFetch({
      operation: () => Response.json(operationLogBody()),
      manualSync: () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    });
    vi.stubGlobal("fetch", manualDecode);
    await expect(loader(loaderArgs(routeRequest()))).resolves.toMatchObject({
      manualSync: { kind: "read-error" },
      operationLog: { kind: "loaded", log: { items: [] } },
    });
  });

  it("loads the manual panel and operation log from the same authorized connection surface", async () => {
    const connection = actorConnection();
    const manualSync = manualSyncPanel();
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
      expect.objectContaining({ kind: "ready", connection, manualSync: { kind: "loaded", data: manualSync } }),
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

  it.each([200, 409])(
    "posts the exact attention generation and contains status %s without a manual error",
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ actor: { ...actor(), permissions: ["channels.manage"] } }))
        .mockResolvedValueOnce(Response.json({ outcome: status === 200 ? "resolved" : "stale" }, { status }));
      vi.stubGlobal("fetch", fetch);
      const request = new Request("http://localhost/account/channels/connection-a", {
        method: "POST",
        body: new URLSearchParams({
          intent: "resolve-attention",
          reasonCode: "polling",
          generation: "7",
          resolutionReason: "handled-on-channel",
        }),
      });
      const result = await action(loaderArgs(request));
      expect(fetch.mock.calls[1]?.[0]).toBe("http://localhost/api/channels/connections/connection-a/attention/resolve");
      expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body)).toEqual({
        reasonCode: "polling",
        generation: 7,
        resolutionReason: "handled-on-channel",
      });
      if (status === 200) expect(result).toMatchObject({ status: 302 });
      else
        expect(result).toEqual({
          kind: "attention-error",
          error: "Attention was not resolved. Refresh and check the current generation.",
        });
    },
  );

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
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(new TextEncoder().encode(csv)));
  });

  it("reads only object error results for the account-route banner", () => {
    expect(readActionError({ error: "synthetic failure" })).toBe("synthetic failure");
    expect(readActionError("TCGplayer Id,Add to Quantity,TCG Marketplace Price\n")).toBeNull();
    expect(readActionError(new Response("csv"))).toBeNull();
  });

  it("connector-pairing-surface: generates a validated code through the existing authenticated action", async () => {
    const generated = { pairingId: "pair_test", revision: 1, code: "a".repeat(43), expiresAt: "2026-09-14T12:10:00Z" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: { ...actor(), permissions: ["channels.manage"] } }))
      .mockResolvedValueOnce(Response.json(generated));
    vi.stubGlobal("fetch", fetch);
    const request = new Request(routeRequest(), {
      method: "POST",
      body: new URLSearchParams({ intent: "connector-code" }),
    });
    expect(await action(loaderArgs(request))).toEqual({ kind: "pairing-code", generated });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "http://localhost/api/channels/connections/connection-a/connector-pairing/code",
    );
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: "{}" });
  });

  it.each(["transport", "refusal", "malformed"])(
    "connector-pairing-surface: %s returns a safe retry, not generated success",
    async (failure) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({ actor: { ...actor(), permissions: ["channels.manage"] } }));
      if (failure === "transport") fetch.mockRejectedValueOnce(new Error("connector-secret-sentinel-network"));
      else
        fetch.mockResolvedValueOnce(
          failure === "refusal"
            ? new Response("connector-secret-sentinel-refusal", { status: 503 })
            : Response.json({ pairingId: "x", expiresAt: "2026-09-14", code: "sentinel", revision: 1 }),
        );
      vi.stubGlobal("fetch", fetch);
      const request = new Request(routeRequest(), {
        method: "POST",
        body: new URLSearchParams({ intent: "connector-code" }),
      });
      const result = await action(loaderArgs(request));
      expect(result).toEqual({ error: "Reload this connection and try again." });
      expect(JSON.stringify(result)).not.toContain("sentinel");
    },
  );

  it("connector-pairing-surface: unpairs the exact revision and redirects for a fresh detail read", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: { ...actor(), permissions: ["channels.manage"] } }))
      .mockResolvedValueOnce(Response.json({ state: "unpaired" }));
    vi.stubGlobal("fetch", fetch);
    const request = new Request(routeRequest(), {
      method: "POST",
      body: new URLSearchParams({ intent: "connector-unpair", pairingId: "pair_test", revision: "2" }),
    });
    expect(await action(loaderArgs(request))).toMatchObject({ status: 302 });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ pairingId: "pair_test", revision: 2 }) });
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

function manualSyncPanel() {
  return {
    connection: actorConnection(),
    inboundCoverage: { state: "dark", reason: "no-inbound-authority" },
    run: null,
    actions: ["ingest-live", "ingest-staged", "compose"],
    leaseCountdownMs: null,
    requestedListingCount: 0,
    composedListingCount: 0,
    attentionReason: null,
  };
}

function operationLogBody() {
  return {
    connection: actorConnection(),
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
  };
}

function auxiliaryFetch(
  responses: Readonly<{
    operation: () => Response | Promise<Response>;
    manualSync: () => Response | Promise<Response>;
    attention?: () => Response | Promise<Response>;
    drift?: () => Response | Promise<Response>;
  }>,
) {
  return vi
    .fn()
    .mockResolvedValueOnce(Response.json({ actor: actor() }))
    .mockResolvedValueOnce(Response.json(actorConnection()))
    .mockImplementationOnce(responses.operation)
    .mockImplementationOnce(responses.manualSync)
    .mockImplementationOnce(
      responses.attention ??
        (() => Response.json({ connectionId: "connection-a", healthState: "healthy", health: [], manual: null })),
    )
    .mockImplementationOnce(responses.drift ?? (() => Response.json({ kind: "not-yet-observed" })));
}

function renderRoute() {
  const router = createMemoryRouter(
    [
      {
        path: "/account/channels/:connectionId",
        loader,
        Component: AccountChannelsConnectionRoute,
      },
    ],
    { initialEntries: ["/account/channels/connection-a"] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
}

function routeRequest() {
  return new Request("http://localhost/account/channels/connection-a");
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
