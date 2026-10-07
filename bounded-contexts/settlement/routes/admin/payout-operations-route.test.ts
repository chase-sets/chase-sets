import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { AUTH_ROLE_PERMISSIONS } from "../../../auth/support/auth-support/constants";
import type { SettlementApiEnv } from "../../api";
import { createPayoutRoutes } from "../../features/payouts/api/route";
import type { PayoutServices } from "../../features/payouts/api/runtime";

const { mockCreateSettlementRequestApiClient } = vi.hoisted(() => ({
  mockCreateSettlementRequestApiClient: vi.fn(),
}));

vi.mock("../../support/request-support/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
    "../../support/request-support/api-client",
  );

  return {
    ...actual,
    createSettlementRequestApiClient: mockCreateSettlementRequestApiClient,
  };
});

import { action as payoutOperationsAction, loader } from "./payout-operations";
import contextManifest from "../../context.json";

function formRequest(form: URLSearchParams) {
  return new Request("https://admin.chasesets.com/commerce/payout-operations", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

describe("settlement admin payout operations route action", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns the queued reconciliation job snapshot for operator correction", async () => {
    const runPayoutReconciliation = vi.fn(async () => ({
      jobId: "job_reconcile",
      status: "queued",
      progress: {
        phase: "queued",
        completed: 0,
        total: 3,
        message: "Payout reconciliation queued.",
      },
      result: null,
    }));
    mockCreateSettlementRequestApiClient.mockReturnValue({ runPayoutReconciliation });
    const form = new URLSearchParams({ intent: "run-reconciliation" });

    const result = await payoutOperationsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      jobId: "job_reconcile",
      status: "queued",
      progress: {
        phase: "queued",
        total: 3,
      },
    });
    expect(runPayoutReconciliation).toHaveBeenCalledWith({ limit: 100 });
  });

  it("ignores unsupported intents", async () => {
    const runPayoutReconciliation = vi.fn();
    mockCreateSettlementRequestApiClient.mockReturnValue({ runPayoutReconciliation });
    const form = new URLSearchParams({ intent: "noop" });

    const result = await payoutOperationsAction({
      request: formRequest(form),
      params: {},
      context: undefined,
    } as never);

    expect(result).toBeNull();
    expect(runPayoutReconciliation).not.toHaveBeenCalled();
  });

  it("contributes the payout operations route to admin-web commerce", () => {
    const adminContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "admin-web",
    );

    expect(adminContributions?.routes).toContainEqual({
      routeId: "settlement-payout-operations",
      routePath: "payout-operations",
      fileExport: "./routes/admin/payout-operations",
      routeType: "route",
      sourceContext: "settlement",
      section: "commerce",
    });
  });

  it("no longer contributes payout operations to marketplace-web", () => {
    const marketplaceContributions = contextManifest.deployableContributions.find(
      (contribution) => contribution.deployable === "marketplace-web",
    );

    expect(marketplaceContributions?.routes.some((route) => route.routeId === "account-payout-operations")).toBe(false);
  });
});

describe("payout operations trusted loader and action", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function setup(role: "platform-admin" | "owner" | "viewer" | null, empty = false) {
    const actual = await vi.importActual<typeof import("../../support/request-support/api-client")>(
      "../../support/request-support/api-client",
    );
    mockCreateSettlementRequestApiClient.mockImplementation(actual.createSettlementRequestApiClient);
    vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", "http://internal.test");
    const actor = role
      ? {
          sessionId: "ses_test",
          tenantId: "tnt_test",
          userId: "usr_test",
          accountId: "acc_a",
          membershipId: "mem_test",
          roleKey: role,
          permissions: AUTH_ROLE_PERMISSIONS[role],
        }
      : null;
    const rows = empty
      ? []
      : [
          { payout_id: "pyo_a", account_id: "acc_a" },
          { payout_id: "pyo_b", account_id: "acc_b" },
        ];
    const listPayoutsNeedingReconciliation = vi.fn(async ({ accountId }: { accountId: string | null }) =>
      rows.filter((row) => accountId === null || accountId === row.account_id),
    );
    const listProviderIdempotencyKeys = vi.fn(async () => [{ operation_key: "key_a" }]);
    const enqueuePayoutReconciliationJob = vi.fn();
    const app = new Hono<SettlementApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route(
      "/api/settlement",
      createPayoutRoutes({
        listPayoutsNeedingReconciliation,
        listProviderIdempotencyKeys,
        enqueuePayoutReconciliationJob,
      } as unknown as PayoutServices),
    );
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/auth/session")
        return actor ? Response.json({ actor }) : new Response(null, { status: 401 });
      if (url.pathname === "/api/settlement/payout-readiness")
        return Response.json({ status: "ready", missing_requirements: [] });
      return app.request(url.toString(), init);
    });
    vi.stubGlobal("fetch", fetch);
    return {
      fetch,
      rows,
      listPayoutsNeedingReconciliation,
      listProviderIdempotencyKeys,
      enqueuePayoutReconciliationJob,
    };
  }

  function load() {
    return loader({
      request: new Request("https://admin.test/commerce/payout-operations?filter=failed&scope=platform"),
      params: {},
      context: undefined,
    } as never);
  }

  it.each([false, true])("loads platform grants with only reconciliation data, empty=%s", async (empty) => {
    const s = await setup("platform-admin", empty);
    const result = await load();
    expect(result).toMatchObject({
      payouts: { items: s.rows },
      canReconcile: false,
      idempotencyKeys: null,
      payoutReadiness: null,
      filter: "failed",
    });
    expect(s.listPayoutsNeedingReconciliation).toHaveBeenCalledExactlyOnceWith({
      accountId: null,
      limit: 100,
      filter: "failed",
    });
    expect(s.listProviderIdempotencyKeys).not.toHaveBeenCalled();
    expect(s.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/auth/session",
      "/api/settlement/payouts/reconciliation",
    ]);
  });

  it.each([false, true])("preserves reconciler loader data and requests, empty=%s", async (empty) => {
    const s = await setup("owner", empty);
    const result = await load();
    expect(result).toMatchObject({
      canReconcile: true,
      payouts: { items: empty ? [] : [s.rows[0]] },
      idempotencyKeys: { items: [{ operation_key: "key_a" }] },
      payoutReadiness: { status: "ready" },
    });
    expect(s.listPayoutsNeedingReconciliation).toHaveBeenCalledExactlyOnceWith({
      accountId: "acc_a",
      limit: 100,
      filter: "failed",
    });
    expect(s.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/api/auth/session",
      "/api/settlement/payouts/reconciliation",
      "/api/settlement/payouts/provider-idempotency",
      "/api/settlement/payout-readiness",
    ]);
  });

  it.each(["viewer", null] as const)("preserves API denial rather than fabricating empty data for %s", async (role) => {
    const s = await setup(role);
    await expect(load()).rejects.toMatchObject({ status: role === null ? 401 : 403 });
    expect(s.listPayoutsNeedingReconciliation).not.toHaveBeenCalled();
    expect(s.listProviderIdempotencyKeys).not.toHaveBeenCalled();
  });

  it.each(["platform-admin", "owner"] as const)("propagates data failure for %s", async (role) => {
    const s = await setup(role);
    const original = s.fetch.getMockImplementation()!;
    s.fetch.mockImplementation(async (input, init) =>
      String(input).includes("/api/auth/session")
        ? original(input, init)
        : Response.json({ error: { code: "unavailable", message: "Unavailable" } }, { status: 503 }),
    );
    await expect(load()).rejects.toMatchObject({ status: 503 });
  });

  it("does not load Settlement data when Auth resolution fails", async () => {
    const s = await setup("platform-admin");
    s.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(load()).rejects.toMatchObject({ status: 503 });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(s.listPayoutsNeedingReconciliation).not.toHaveBeenCalled();
  });

  it("preserves the real API denial when platform readers forge the run action", async () => {
    const s = await setup("platform-admin");
    await expect(
      payoutOperationsAction({
        request: formRequest(new URLSearchParams({ intent: "run-reconciliation" })),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(s.enqueuePayoutReconciliationJob).not.toHaveBeenCalled();
  });
});
