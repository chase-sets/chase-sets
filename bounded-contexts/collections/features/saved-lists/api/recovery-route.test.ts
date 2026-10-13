import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { CollectionsApiEnv } from "../../../api";
import { createSavedListRecoveryRoutes } from "./recovery-route";
import { createCollectionsApiClient } from "./client";
import { createCollectionsRequestApiClient } from "./request-client";
import type { SavedListRecoveryServices } from "./recovery-runtime";

describe("recovery-route-authority-and-callers", () => {
  it("rejects missing, unauthorized, and switched-before-admission callers without reading or commanding", async () => {
    const services: SavedListRecoveryServices = {
      get: vi.fn(),
      list: vi.fn(),
      prepare: vi.fn(),
      confirm: vi.fn(),
      beginSend: vi.fn(),
      apply: vi.fn(),
      expire: vi.fn(),
      reserveAnonymous: vi.fn(),
    };
    const guest = createSavedListRecoveryRoutes(services);
    expect((await guest.request("/account/list-operations")).status).toBe(401);
    expect((await guest.request("/account/list-operations/slo_test")).status).toBe(401);
    const app = new Hono<CollectionsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId: "acc_other", permissions: ["accounts.view"] });
      c.set("context", {
        tenantId: "tnt_test" as never,
        audit: { performedByUserId: "usr_test" as never, forAccountId: "acc_original" as never },
      });
      await next();
    });
    app.route("/", createSavedListRecoveryRoutes(services));
    expect((await app.request("/account/list-operations")).status).toBe(401);
    expect(services.get).not.toHaveBeenCalled();
    expect(services.list).not.toHaveBeenCalled();
    expect(services.apply).not.toHaveBeenCalled();
  });
  it("composes receipt-only GETs through the actual client interface and captures admission Account", async () => {
    let accountId = "acc_one";
    const get = vi.fn<SavedListRecoveryServices["get"]>(async (_id, context) => {
      accountId = "acc_two";
      expect(context.audit.forAccountId).toBe("acc_one");
      return null;
    });
    const list = vi.fn<SavedListRecoveryServices["list"]>(async (_page, context) => {
      expect(context.audit.forAccountId).toBe(accountId);
      return { items: [], nextCursor: null };
    });
    const service: SavedListRecoveryServices = {
      get,
      list,
      prepare: vi.fn(),
      confirm: vi.fn(),
      beginSend: vi.fn(),
      apply: vi.fn(),
      expire: vi.fn(),
      reserveAnonymous: vi.fn(),
    };
    const app = new Hono<CollectionsApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { accountId, permissions: ["accounts.view"] });
      c.set("context", {
        tenantId: "tnt_test" as never,
        audit: { performedByUserId: "usr_test" as never, forAccountId: accountId as never },
      });
      await next();
    });
    app.route("/api/collections", createSavedListRecoveryRoutes(service));
    const client = createCollectionsApiClient({ fetch: async (input, init) => app.request(String(input), init) });
    expect(await client.getSavedListRecovery("slo_test")).toBeNull();
    expect(await client.listSavedListRecovery()).toEqual({ items: [], nextCursor: null });
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(service.apply).not.toHaveBeenCalled();
    expect(service.prepare).not.toHaveBeenCalled();
    const { get: _get, ...missingCaller } = service;
    // @ts-expect-error A recovery caller cannot omit the actual receipt reader contract.
    const rejectedCaller: SavedListRecoveryServices = missingCaller;
    expect("get" in rejectedCaller).toBe(false);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) =>
      app.request(new URL(String(input)).pathname, init),
    );
    try {
      accountId = "acc_one";
      const requestClient = createCollectionsRequestApiClient(new Request("http://synthetic.invalid/account"));
      expect(await requestClient.getSavedListRecovery("slo_test")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    get.mockRejectedValueOnce(new Error("synthetic_cookie_secret_snapshot_error_marker"));
    const response = await app.request("/api/collections/account/list-operations/slo_test");
    expect(await response.text()).not.toContain("synthetic_cookie_secret_snapshot_error_marker");
  });
});
