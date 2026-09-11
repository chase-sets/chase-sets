import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { useLoaderData, useActionData, useNavigation } = vi.hoisted(() => ({
  useLoaderData: vi.fn(),
  useActionData: vi.fn(() => undefined),
  useNavigation: vi.fn(() => ({ state: "idle" })),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useLoaderData, useActionData, useNavigation };
});
vi.mock("@chase-sets/design-system/react-router", async () => {
  const React = await import("react");
  return {
    RouterForm: (props: { children?: unknown; [key: string]: unknown }) =>
      React.createElement("form", props, props.children),
  };
});

import AccountChannelsConnectionRoute, { loader } from "./account-channels-connection";

const connection = {
  connectionId: "connection-a",
  providerKey: "shopify",
  environment: "sandbox" as const,
  status: "active" as const,
};

const operation = {
  operationId: "operation-a",
  channelListingId: "channel-listing-a",
  listingId: "listing-a",
  operationKind: "publish" as const,
  status: "succeeded" as const,
  terminalReason: null,
  rejectionCode: null,
  attemptCount: 1,
  linkWriteState: "applied" as const,
  sourceOccurredAt: "2026-09-07T19:00:00.000Z",
  enqueuedAt: "2026-09-07T19:00:00.500Z",
  terminalAt: "2026-09-07T19:00:01.000Z",
  eventToEnqueueMs: 500,
  enqueueToTerminalMs: 500,
  eventToProviderAckMs: 1_000,
};

const summary = {
  completeness: { kind: "complete" as const, total: 1 },
  succeeded: 1,
  failed: 0,
  pending: 0,
  inFlight: 0,
  blocked: 0,
  inlineEventToProviderAckMs: { p50: 1_000, p95: 1_000, p99: 1_000 },
  claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
};

describe("canonical Channels connection detail contribution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useLoaderData.mockReset();
  });

  it("resolves the manifest route and renders populated, empty, incomplete, and read-error log states", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../context.json"), "utf8"));
    const route = manifest.deployableContributions
      .find((entry: { deployable: string }) => entry.deployable === "marketplace-web")
      .routes.find((entry: { routeId: string }) => entry.routeId === "channels-connection-detail");
    expect(route).toMatchObject({
      routePath: "account/channels/:connectionId",
      fileExport: "./routes/marketplace/account-channels-connection",
    });

    const states = [
      {
        kind: "loaded" as const,
        log: { items: [operation], completeness: { kind: "complete" as const, total: 1 } },
        summary,
        navigation: { previous: null, next: null },
      },
      {
        kind: "loaded" as const,
        log: { items: [], completeness: { kind: "complete" as const, total: 0 } },
        summary: { ...summary, completeness: { kind: "complete" as const, total: 0 }, succeeded: 0 },
        navigation: { previous: null, next: null },
      },
      {
        kind: "loaded" as const,
        log: { items: [operation], completeness: { kind: "bounded-incomplete" as const, reason: "bounded" } },
        summary: { ...summary, completeness: { kind: "bounded-incomplete" as const, reason: "bounded" } },
        navigation: { previous: null, next: null },
      },
      { kind: "read-error" as const },
    ];
    for (const outbound of states) {
      useLoaderData.mockReturnValue({ kind: "ready", connection, outbound });
      const html = renderToStaticMarkup(<AccountChannelsConnectionRoute />);
      if (outbound.kind === "read-error") {
        expect(html).toContain("Publication activity is unavailable");
      } else {
        expect(html).toContain('data-channels-outbound-operation-log="true"');
      }
    }
  });

  it("authenticates before reading and keeps an account-isolated connection absent", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: actor() }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    const result = await loader(loaderArgs(new Request("http://localhost/account/channels/foreign")));
    expect(result).toEqual({ kind: "not-found" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("loads the connection, metrics, cursor, and rows through the canonical export", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ actor: actor() }))
      .mockResolvedValueOnce(Response.json(connection))
      .mockResolvedValueOnce(
        Response.json({
          connection,
          log: { items: [operation], nextCursor: "cursor-next", completeness: { kind: "complete", total: 1 } },
          summary,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(
      loader(loaderArgs(new Request("http://localhost/account/channels/connection-a"))),
    ).resolves.toMatchObject({
      kind: "ready",
      connection,
      outbound: { kind: "loaded", log: { nextCursor: "cursor-next" } },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
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
