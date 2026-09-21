// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { encodeFreshWriteReceipt } from "@chase-sets/http/responses";
import AccountChannelsConnectionRoute, { loader } from "../../../routes/marketplace/account-channels-connection";
import { createFakeConnectionServices, mountConnectionRouteHarness, routeAccountId } from "./route-harness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("activated connection panel recovery", () => {
  it.each([401, 403, 500])("does not turn a permanent %s panel failure into a loading state", async (status) => {
    const connection = {
      connectionId: "new-connection",
      accountId: routeAccountId,
      providerKey: "tcgplayer",
      environment: "sandbox" as const,
      status: "active" as const,
      createdAt: "2026-09-20T00:00:00Z",
    };
    mountConnectionRouteHarness(createFakeConnectionServices([connection]).services);
    const fetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((input, init) =>
        String(input).endsWith("/manual-sync")
          ? Promise.resolve(Response.json({ error: { code: "permanent_failure" } }, { status }))
          : fetch(input, init),
      ),
    );
    const afterWrite = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "channels", maxGlobalPosition: "5", eventIds: ["activated"] }],
    });
    const result = await loader({
      request: new Request(`http://localhost/account/channels/new-connection?afterWrite=${afterWrite}`),
      params: { connectionId: "new-connection" },
    });
    expect(result).toMatchObject({ kind: "ready", manualSync: { kind: "read-error" } });
  });

  it("keeps the manual-sync heading while catching up and automatically reconciles without replaying activation", async () => {
    vi.useFakeTimers();
    const connection = {
      connectionId: "new-connection",
      providerKey: "tcgplayer",
      environment: "sandbox" as const,
      status: "active" as const,
      createdAt: "2026-09-20T00:00:00Z",
    };
    const harness = createFakeConnectionServices([{ ...connection, accountId: routeAccountId }]);
    const { apiRequests } = mountConnectionRouteHarness(harness.services);
    const fetch = globalThis.fetch;
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (input, init) => {
        if (String(input).endsWith("/manual-sync")) {
          reads += 1;
          return Response.json(
            reads === 1
              ? { error: { code: "projection_freshness_timeout" } }
              : {
                  connection,
                  inboundCoverage: { state: "dark", reason: "no-inbound-authority" },
                  run: null,
                  actions: ["compose"],
                  leaseCountdownMs: null,
                  requestedListingCount: 0,
                  composedListingCount: 0,
                  attentionReason: null,
                },
            { status: reads === 1 ? 503 : 200 },
          );
        }
        return fetch(input, init);
      }),
    );
    const afterWrite = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "channels", maxGlobalPosition: "5", eventIds: ["activated"] }],
    });
    const router = createMemoryRouter(
      [{ path: "/account/channels/:connectionId", loader, Component: AccountChannelsConnectionRoute }],
      {
        initialEntries: [`/account/channels/new-connection?afterWrite=${afterWrite}`],
      },
    );
    await act(async () => {
      render(
        <ChaseRoot linkComponent={RouterLinkAdapter}>
          <RouterProvider router={router} />
        </ChaseRoot>,
      );
    });
    expect(screen.getByRole("heading", { name: "Manual TCGplayer sync" })).toBeTruthy();
    expect(screen.getByText("Loading manual sync…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compose Staged batch" })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByRole("button", { name: "Compose Staged batch" })).toBeTruthy();
    expect(screen.queryByText("Loading manual sync…")).toBeNull();
    expect(reads).toBe(2);
    expect(apiRequests.every((request) => request.method === "GET")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(reads).toBe(2);
  });
});
