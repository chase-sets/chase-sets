import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OrderingApiEnv } from "../../../api";
import { createAccountPurchaseOrderRoutes } from "./route";
import type { OrderingOrderServices } from "./runtime";
import type { OrderCleanupAuthorityObservation, OrderCleanupAuthorityReport } from "./cleanup-authority";
import { BUYER_ACCOUNT_ID, ORDER_ID } from "../../../tests/test-support/cleanup-authority";

const WINDOW_OPENED_AT = "2026-08-01T00:00:00.000Z";
const ROUTE_PATH = `/account/purchases/${ORDER_ID}/cleanup-authority`;

const COMPLETE_REPORT: OrderCleanupAuthorityReport = {
  schemaVersion: "ordering-cleanup-authority/v1",
  state: "cleanup-complete",
  retryable: false,
  orderStatus: "cancelled",
  cancellationStatusBefore: "pending-payment",
  holdCounts: { total: 1, active: 0, released: 1, consumed: 0, expired: 0 },
  orderStreamVersion: 4,
  holdStreamVersions: [2],
};

type Actor = OrderingApiEnv["Variables"]["actor"];

const buyerActor = {
  accountId: BUYER_ACCOUNT_ID,
  userId: "usr_buyer",
  permissions: ["orders.view", "orders.manage"],
} as unknown as Actor;

const guestActor = {
  accountId: "acc_guest",
  userId: "usr_guest",
  permissions: ["guest-checkout.manage"],
} as unknown as Actor;

function buildApp(
  options: Readonly<{
    actor: Actor | null;
    observation?: OrderCleanupAuthorityObservation;
    mounted?: boolean;
    withContext?: boolean;
  }>,
) {
  const observe = vi.fn(async () => options.observation ?? { outcome: "observed", report: COMPLETE_REPORT });
  const services = {
    getPurchase: vi.fn(async () => null),
    getOrderReviewOpportunity: vi.fn(async () => null),
    projectors: [],
    cleanupAuthority:
      options.mounted === false
        ? { kind: "not-mounted" }
        : {
            kind: "available",
            observeBuyerOrderCleanupAuthority: observe,
            observeEvidenceWindowSourceCleanupAuthority: vi.fn(),
          },
  } as unknown as OrderingOrderServices;

  const app = new Hono<OrderingApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    c.set(
      "context",
      options.actor && options.withContext !== false
        ? {
            tenantId: "tnt_cleanup" as never,
            audit: {
              performedByUserId: "usr_buyer" as never,
              forAccountId: options.actor.accountId as never,
            },
          }
        : (null as never),
    );
    await next();
  });
  app.route("/account", createAccountPurchaseOrderRoutes(services));

  return { app, observe };
}

function post(app: Hono<OrderingApiEnv>, body: unknown, path = ROUTE_PATH) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("cleanup-authority-n8-contract", () => {
  it("returns the exact 200 body under an available capability", async () => {
    const { app, observe } = buildApp({ actor: buyerActor });
    const response = await post(app, { windowOpenedAt: WINDOW_OPENED_AT });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      schemaVersion: "ordering-cleanup-authority/v1",
      state: "cleanup-complete",
      retryable: false,
      orderStatus: "cancelled",
      cancellationStatusBefore: "pending-payment",
      holdCounts: { total: 1, active: 0, released: 1, consumed: 0, expired: 0 },
      orderStreamVersion: 4,
      holdStreamVersions: [2],
    });
    expect(Object.keys(body).sort()).toEqual([
      "cancellationStatusBefore",
      "holdCounts",
      "holdStreamVersions",
      "orderStatus",
      "orderStreamVersion",
      "retryable",
      "schemaVersion",
      "state",
    ]);
    // The buyer identity comes from the principal, never the request.
    expect(observe).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      windowOpenedAt: WINDOW_OPENED_AT,
      buyerAccountId: BUYER_ACCOUNT_ID,
      tenantId: "tnt_cleanup",
    });
  });

  it("exposes no handler at all when the capability is not mounted", async () => {
    const { app, observe } = buildApp({ actor: buyerActor, mounted: false });
    const response = await post(app, { windowOpenedAt: WINDOW_OPENED_AT });

    expect(response.status).toBe(404);
    expect(observe).not.toHaveBeenCalled();
    // The cancel route on the same router is unaffected by the mount decision.
    const cancelResponse = await post(app, {}, `/account/purchases/${ORDER_ID}/cancel`);
    expect(cancelResponse.status).not.toBe(404);
  });

  it("denies an unauthenticated caller, a guest, and a request without an event-store context", async () => {
    const anonymous = buildApp({ actor: null });
    const anonymousResponse = await post(anonymous.app, { windowOpenedAt: WINDOW_OPENED_AT });
    expect(anonymousResponse.status).toBe(401);
    expect((await anonymousResponse.json()).error.code).toBe("authentication_required");

    const guest = buildApp({ actor: guestActor });
    const guestResponse = await post(guest.app, { windowOpenedAt: WINDOW_OPENED_AT });
    expect(guestResponse.status).toBe(403);
    expect((await guestResponse.json()).error.code).toBe("authorization_forbidden");
    expect(guest.observe).not.toHaveBeenCalled();

    const contextless = buildApp({ actor: buyerActor, withContext: false });
    const contextlessResponse = await post(contextless.app, { windowOpenedAt: WINDOW_OPENED_AT });
    expect(contextlessResponse.status).toBe(401);
    expect(contextless.observe).not.toHaveBeenCalled();
  });

  it("accepts exactly one body field and rejects identity smuggled through the request", async () => {
    const rejectedBodies: readonly unknown[] = [
      {},
      { windowOpenedAt: WINDOW_OPENED_AT, buyerAccountId: "acc_other" },
      { windowOpenedAt: WINDOW_OPENED_AT, orderId: "ord_other" },
      { windowOpenedAt: WINDOW_OPENED_AT, sourceReferenceId: "chk_1" },
      { WindowOpenedAt: WINDOW_OPENED_AT },
      { windowOpenedAt: 1 },
      [WINDOW_OPENED_AT],
      null,
    ];

    for (const body of rejectedBodies) {
      const { app, observe } = buildApp({ actor: buyerActor });
      const response = await post(app, body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect(await response.json()).toEqual({
        error: {
          code: "ordering_cleanup_authority_input_invalid",
          message: "Cleanup authority request is invalid.",
        },
      });
      expect(observe).not.toHaveBeenCalled();
    }
  });

  it("rejects an unparseable body without throwing", async () => {
    const { app, observe } = buildApp({ actor: buyerActor });
    const response = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "ordering_cleanup_authority_input_invalid",
        message: "Cleanup authority request is invalid.",
      },
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("maps each observation outcome to its envelope without leaking the supplied Order id", async () => {
    const cases: readonly Readonly<{
      observation: OrderCleanupAuthorityObservation;
      status: number;
      code: string;
      message: string;
    }>[] = [
      {
        observation: { outcome: "invalid-request", reason: "window-opened-at-invalid" },
        status: 400,
        code: "ordering_cleanup_authority_input_invalid",
        message: "Cleanup authority request is invalid.",
      },
      {
        observation: { outcome: "not-found" },
        status: 404,
        code: "ordering_cleanup_authority_not_found",
        message: "Cleanup authority is unavailable.",
      },
      {
        observation: { outcome: "conflict", reason: "inventory-reservation-authority-incomplete" },
        status: 409,
        code: "ordering_cleanup_authority_incomplete",
        message: "Cleanup authority is incomplete.",
      },
    ];

    for (const testCase of cases) {
      const { app } = buildApp({ actor: buyerActor, observation: testCase.observation });
      const response = await post(app, { windowOpenedAt: WINDOW_OPENED_AT });
      const text = await response.text();

      expect({ status: response.status, ...JSON.parse(text).error }).toEqual({
        status: testCase.status,
        code: testCase.code,
        message: testCase.message,
      });
      expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
      expect(Object.keys(JSON.parse(text).error).sort()).toEqual(["code", "message"]);
      // Privacy: no response repeats the supplied Order id, and no internal
      // diagnostic reason is representable on the wire.
      expect(text).not.toContain(ORDER_ID);
      if (testCase.observation.outcome !== "not-found") {
        expect(text).not.toContain(String((testCase.observation as { reason?: string }).reason));
      }
    }
  });

  it("never renders a raw event, Hold, source, provider, credential, email, or exception", async () => {
    const { app } = buildApp({ actor: buyerActor });
    const text = await (await post(app, { windowOpenedAt: WINDOW_OPENED_AT })).text();

    for (const forbidden of [
      "hld_",
      "inventory.hold-",
      "inventory.reservation-",
      "ordering.order-",
      "@",
      "sourceRef",
      "stack",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toContain(ORDER_ID);
  });
});
