// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { RouterLinkAdapter } from "@chase-sets/design-system/react-router";
import { Hono } from "hono";
import AccountChannelsConnectionRoute, {
  loader,
  action,
  clientAction,
} from "../../../routes/marketplace/account-channels-connection";
import { buildChannelsApi, type ChannelsApiEnv } from "../../../api";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import { createFakeConnectionServices, testContext } from "../../connections/tests/route-harness";
import type { ChannelConnectionStatus } from "../../connections/domain/contracts";
import { ChannelDriftError } from "../domain/contracts";
import type { ChannelDriftDetail, ChannelDriftDetailRow, ChannelReconciliationServices } from "../domain/contracts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const row: Extract<ChannelDriftDetailRow, { rowKind: "listing" }> = {
  rowKind: "listing",
  rowIdentity: "a".repeat(64),
  channelListingId: "synthetic-listing",
  classification: "foreign-edit",
  actionable: true,
  runGeneration: 7,
  observedFingerprint: "b".repeat(64),
  expectedMaterialFingerprint: "c".repeat(64),
  decision: {
    connectionId: "connection-1",
    channelListingId: "synthetic-listing",
    revision: 0,
    accepted: null,
    repushRequested: false,
    operationId: null,
  },
};
const loaded = (): Extract<ChannelDriftDetail, { kind: "loaded" }> => ({
  kind: "loaded",
  basis: "d".repeat(64),
  runState: "completed",
  observedAt: "2026-09-14T00:00:00.000Z",
  rows: [row],
  hasMore: 0,
  cursor: null,
});

function harness(
  options: Readonly<{ initial?: ChannelDriftDetail; manage?: boolean; status?: ChannelConnectionStatus }> = {},
) {
  let detail = options.initial ?? loaded();
  let loseResponse = false;
  let block: Promise<void> | undefined;
  const permissions = options.manage === false ? ["channels.view"] : ["channels.view", "channels.manage"];
  const services = createChannelsServicesForTest();
  const connections = createFakeConnectionServices([
    {
      connectionId: "connection-1",
      accountId: "account-1",
      providerKey: "synthetic-provider",
      environment: "sandbox",
      status: options.status ?? "active",
      createdAt: "2026-09-14T00:00:00.000Z",
    },
  ]);
  const read = vi.fn<ChannelReconciliationServices["readChannelDriftDetail"]>(async () => detail);
  const commands: Array<{ path: string; body: Record<string, unknown> }> = [];
  const accept = vi.fn<ChannelReconciliationServices["acceptChannelDrift"]>(async (input) => {
    await block;
    const decision = {
      ...row.decision,
      revision: 1,
      operationId: input.operationId,
      accepted: {
        observedFingerprint: input.observedFingerprint,
        expectedMaterialFingerprint: input.expectedMaterialFingerprint,
        acceptedAtRunGeneration: 7,
      },
    };
    detail = { ...loaded(), rows: [{ ...row, decision }] };
    return decision;
  });
  const repush = vi.fn<ChannelReconciliationServices["repushChannelListing"]>(async (input) => {
    const decision = { ...row.decision, revision: 2, operationId: input.operationId, repushRequested: true };
    detail = { ...loaded(), rows: [{ ...row, decision }] };
    return decision;
  });
  const api = new Hono<ChannelsApiEnv>();
  api.use("*", async (c, next) => {
    c.set("actor", { accountId: "account-1", permissions });
    c.set("context", testContext);
    await next();
  });
  api.route(
    "/api/channels",
    buildChannelsApi({
      ...services,
      connections: connections.services,
      reconciliation: {
        ...services.reconciliation,
        readChannelDriftDetail: read,
        acceptChannelDrift: accept,
        repushChannelListing: repush,
      },
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? new Request(input, init) : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/api/auth/session")
        return Response.json({
          actor: {
            sessionId: "session",
            tenantId: "tenant",
            userId: "user",
            accountId: "account-1",
            membershipId: "member",
            roleKey: "owner",
            permissions,
          },
        });
      if (path.endsWith("/attention"))
        return Response.json({ connectionId: "connection-1", healthState: "unknown", health: [], manual: null });
      if (path.endsWith("/manual-sync") || path.endsWith("/outbound-operations"))
        return Response.json({}, { status: 503 });
      if (request.method === "POST" && path.includes("/drift/")) {
        commands.push({ path, body: await request.clone().json() });
        const response = await api.request(request);
        if (loseResponse) {
          loseResponse = false;
          throw new Error("synthetic response loss");
        }
        return response;
      }
      return api.request(request);
    }),
  );
  const router = createMemoryRouter(
    [{ path: "/account/channels/:connectionId", loader, action, Component: AccountChannelsConnectionRoute }],
    { initialEntries: ["/account/channels/connection-1"] },
  );
  render(
    <ChaseRoot linkComponent={RouterLinkAdapter}>
      <RouterProvider router={router} />
    </ChaseRoot>,
  );
  return {
    router,
    read,
    accept,
    repush,
    commands,
    setDetail: (value: ChannelDriftDetail) => {
      detail = value;
    },
    lose: () => {
      loseResponse = true;
    },
    block: (value: Promise<void>) => {
      block = value;
    },
  };
}

describe("channel-drift-detail production loader/action/router", () => {
  it("retains historical foreign edits without exposing decision controls", async () => {
    harness({ initial: { ...loaded(), rows: [{ ...row, actionable: false }] } });
    expect(await screen.findByText(row.channelListingId)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept channel change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request repush" })).toBeNull();
    expect(screen.getByTestId("channel-health-panel")).toBeTruthy();
  });
  it.each([302, 403])("rethrows the exact auth Response %s from the production client action", async (status) => {
    const form = new FormData();
    form.set("intent", "repush-drift");
    form.set("channelListingId", row.channelListingId);
    form.set("operationId", "synthetic-auth-response");
    form.set("expectedDecisionRevision", "0");
    const response = new Response(null, { status, headers: status === 302 ? { Location: "/sign-in" } : {} });
    const url = new URL("http://localhost/account/channels/connection-1");
    await expect(
      clientAction({
        request: new Request(url, { method: "POST", body: form }),
        url,
        pattern: "/account/channels/:connectionId",
        params: { connectionId: "connection-1" },
        context: {},
        serverAction: async () => {
          throw response;
        },
      }),
    ).rejects.toBe(response);
  });

  it("retains the browser request identity when the server action response is lost", async () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      intent: "accept-drift",
      channelListingId: row.channelListingId,
      operationId: "synthetic-browser-lost-response",
      expectedDecisionRevision: "0",
      observedFingerprint: row.observedFingerprint!,
      expectedMaterialFingerprint: row.expectedMaterialFingerprint!,
    }))
      form.set(key, value);
    const serverAction = vi.fn(async () => {
      throw new Error("synthetic browser response loss");
    });
    const args = {
      request: new Request("http://localhost/account/channels/connection-1", { method: "POST", body: form }),
      url: new URL("http://localhost/account/channels/connection-1"),
      pattern: "/account/channels/:connectionId",
      params: { connectionId: "connection-1" },
      context: {},
      serverAction,
    };
    expect(await clientAction(args)).toEqual({
      kind: "drift-result",
      outcome: "uncertain",
      submission: {
        intent: "accept-drift",
        input: {
          connectionId: "connection-1",
          channelListingId: row.channelListingId,
          operationId: "synthetic-browser-lost-response",
          expectedDecisionRevision: 0,
          observedFingerprint: row.observedFingerprint,
          expectedMaterialFingerprint: row.expectedMaterialFingerprint,
        },
      },
    });
    expect(serverAction).toHaveBeenCalledTimes(1);
    form.set("intent", "pause");
    await expect(
      clientAction({ ...args, request: new Request(args.request.url, { method: "POST", body: form }) }),
    ).rejects.toThrow("synthetic browser response loss");
  });
  it.each(["active", "paused", "pending-setup", "disconnected"] as const)(
    "retains eligible decisions and independent children for %s connections",
    async (status) => {
      harness({ status });
      expect(await screen.findByText("synthetic-listing")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Accept channel change" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Request repush" })).toBeTruthy();
      expect(screen.getByTestId("channel-health-panel")).toBeTruthy();
    },
  );
  it.each([
    [{ kind: "not-yet-observed" }, "This connection has not been checked yet"],
    [{ kind: "unavailable" }, "Channel differences are unavailable"],
    [{ kind: "stale-page" }, "The check changed. Refresh to start again."],
    [{ ...loaded(), rows: [] }, "No rows on this page. This does not confirm that all differences are resolved."],
  ] as const)("renders the closed state %s without implying settlement", async (initial, text) => {
    harness({ initial });
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept channel change" })).toBeNull();
  });
  it("shows view-only rows and structural flags without controls", async () => {
    harness({
      manage: false,
      initial: {
        ...loaded(),
        rows: [
          row,
          { ...row, rowIdentity: "e".repeat(64), channelListingId: "structural-listing", classification: "structural" },
          { rowKind: "finding", rowIdentity: "f".repeat(64), flag: "unmapped", runGeneration: 7 },
        ],
      },
    });
    expect(await screen.findByText("synthetic-listing")).toBeTruthy();
    expect(screen.getByText("Listing structure needs attention")).toBeTruthy();
    expect(screen.getByText("An unmapped channel record needs attention")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept channel change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request repush" })).toBeNull();
  });
  it("blocks repeat clicks through revalidation, stamps the loader and submits fresh repush identity", async () => {
    const h = harness();
    let release = () => {};
    h.block(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await screen.findByText("synthetic-listing");
    const identity = screen.getByTestId("channel-drift-panel").getAttribute("data-load-identity");
    fireEvent.click(screen.getByRole("button", { name: "Accept channel change" }));
    await waitFor(() => expect(h.commands).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Request repush" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Accept channel change" }));
    expect(h.commands).toHaveLength(1);
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByTestId("channel-drift-panel").getAttribute("data-load-identity")).not.toBe(identity),
    );
    expect(h.commands[0]!.body).toMatchObject({
      expectedDecisionRevision: 0,
      observedFingerprint: row.observedFingerprint,
      expectedMaterialFingerprint: row.expectedMaterialFingerprint,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Request repush" }).hasAttribute("disabled")).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Request repush" }));
    await waitFor(() => expect(h.commands).toHaveLength(2));
    expect(h.commands[1]!.body.expectedDecisionRevision).toBe(1);
    expect(h.commands[1]!.body.operationId).not.toBe(h.commands[0]!.body.operationId);
  });
  it("requires an explicit refresh after conflict and replaces pages instead of merging them", async () => {
    const h = harness();
    await screen.findByText("synthetic-listing");
    h.accept.mockRejectedValueOnce(new ChannelDriftError("stale-decision"));
    fireEvent.click(screen.getByRole("button", { name: "Accept channel change" }));
    await screen.findByText("The decision changed. Refresh before deciding again.");
    expect(h.commands).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Accept channel change" }).hasAttribute("disabled")).toBe(true);
    h.setDetail({ ...loaded(), hasMore: 1, cursor: "synthetic-next-cursor" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh differences" }));
    await screen.findByRole("button", { name: "Next differences" });
    h.setDetail({ ...loaded(), rows: [{ ...row, channelListingId: "second-page-listing" }] });
    fireEvent.click(screen.getByRole("button", { name: "Next differences" }));
    await screen.findByText("second-page-listing");
    expect(screen.queryByText("synthetic-listing")).toBeNull();
    expect(h.read).toHaveBeenLastCalledWith({
      accountId: "account-1",
      connectionId: "connection-1",
      cursor: "synthetic-next-cursor",
    });
    expect(h.commands).toHaveLength(1);
  });
  it("retains the exact request after an actual API 503 without substituting a revision", async () => {
    const h = harness();
    await screen.findByText("synthetic-listing");
    h.accept.mockRejectedValueOnce(new ChannelDriftError("unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Accept channel change" }));
    await screen.findByRole("button", { name: "Retry the same request" });
    expect(screen.getByRole("button", { name: "Accept channel change" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }));
    await waitFor(() => expect(h.commands).toHaveLength(2));
    expect(h.commands[1]).toEqual(h.commands[0]);
  });

  it("retains exact uncertain request across refresh failure and retries without a new revision", async () => {
    const h = harness();
    await screen.findByText("synthetic-listing");
    h.lose();
    fireEvent.click(screen.getByRole("button", { name: "Accept channel change" }));
    await screen.findByRole("button", { name: "Retry the same request" });
    h.setDetail({ kind: "unavailable" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh differences" }));
    await screen.findByText("Channel differences are unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry the same request" }));
    await waitFor(() => expect(h.commands).toHaveLength(2));
    expect(h.commands[1]).toEqual(h.commands[0]);
    expect(screen.getByTestId("channel-health-panel")).toBeTruthy();
  });
});
