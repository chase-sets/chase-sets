import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { createEventCoreMock, createEventCorePostgresMock, resetMockPoolState } from "./index-test-harness";

vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());

import { attachReadConsistencyMiddleware, waitForProjectionFreshness } from "./index";

describe("bounded context read consistency middleware", () => {
  beforeEach(() => {
    resetMockPoolState();
  });

  it("returns a projection freshness timeout response before serving stale API reads", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [{ contextName: "marketplace", mountPath: "/api/marketplace" }],
      [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: null,
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          pending: [
            {
              targetContextName: "marketplace",
              projectionName: "marketplace-listing-projection",
              sourceContextName: "marketplace",
              requiredGlobalPosition: "5",
              lastGlobalPosition: "1",
            },
          ],
        },
      },
    });
  });

  it("uses the request target context to avoid waiting on unrelated projections mounted at the same path", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        { contextName: "marketplace", mountPath: "/api/marketplace" },
        { contextName: "pricing", mountPath: "/api/marketplace" },
      ],
      [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => ({
                lastGlobalPosition: "5",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
        {
          targetContextName: "pricing",
          projectionName: "pricing-market-input-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: null,
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }

            return name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER ? "marketplace" : undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
  });

  it("uses route-declared dependencies to avoid waiting on unrelated projections in the same context", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "5",
      state: "caught-up",
      lastError: null,
    }));
    const refreshCart = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCart }],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshCart).not.toHaveBeenCalled();
  });

  it("waits only on the account cart projection for account cart self-refreshes", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: "session projection should not be inspected",
    }));
    const refreshCart = vi.fn(async () => ({
      lastGlobalPosition: "5",
      state: "caught-up",
      lastError: null,
    }));
    const refreshSellList = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: "sell list projection should not be inspected",
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/cart",
              dependencies: [{ readModelTable: "checkout_cart_line_pages" }],
            },
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
            {
              routePath: "/account/sell-list",
              dependencies: [{ readModelTable: "checkout_sell_list_line_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCart }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.sell-list-projection",
          ownedTables: ["checkout_sell_list_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSellList }],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/cart",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(refreshCart).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(refreshSellList).not.toHaveBeenCalled();
  });

  it("can fall back exact route dependencies to target-context waits through route tuning", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "5",
      state: "caught-up",
      lastError: null,
    }));
    const refreshCart = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCart }],
        },
      ],
      {
        timeoutMs: 0,
        pollIntervalMs: 1,
        routeTuning: [
          {
            mountPath: "/api/marketplace",
            routePath: "/account/checkout-sessions/:sessionId",
            targetContextName: "checkout",
            exactDependencyMode: "target-context",
          },
        ],
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
      },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            return name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER ? "checkout" : undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshCart).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "target-context",
          dependencies: [],
          pending: [
            {
              targetContextName: "checkout",
              projectionName: "checkout.cart-projection",
              sourceContextName: "checkout",
            },
          ],
        },
      },
    });
    expect(auditRecords[0]).toMatchObject({
      outcome: "timeout",
      waitMode: "target-context",
      dependencies: [],
    });
  });

  it("uses route tuning timeout and poll interval without changing global defaults", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const nowValues = [1_000, 1_000, 1_005, 1_010];
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ projectionName: "checkout.session-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
      ],
      {
        timeoutMs: 2_500,
        pollIntervalMs: 75,
        routeTuning: [
          {
            mountPath: "/api/marketplace",
            routePath: "/account/checkout-sessions/:sessionId",
            timeoutMs: 10,
            pollIntervalMs: 5,
          },
        ],
        nowMs: () => nowValues.shift() ?? 1_010,
      },
    );

    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
        },
      },
    });
    expect(refreshSession.mock.calls.length).toBeGreaterThan(1);
    expect(refreshSession.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("prefers later equally specific route tuning entries so environment overrides can replace defaults", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));
    const refreshCart = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCart }],
        },
      ],
      {
        timeoutMs: 0,
        pollIntervalMs: 1,
        routeTuning: [
          {
            mountPath: "/api/marketplace",
            routePath: "/account/checkout-sessions/:sessionId",
            exactDependencyMode: "target-context",
          },
          {
            mountPath: "/api/marketplace",
            routePath: "/account/checkout-sessions/:sessionId",
            exactDependencyMode: "enabled",
          },
        ],
      },
    );

    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshCart).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
          dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
        },
      },
    });
  });

  it("keeps target-context fallback for read routes without declared dependencies", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "5",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.cart-projection",
          ownedTables: ["checkout_cart_line_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: null,
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/cart",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "target-context",
        },
      },
    });
  });

  it("waits only on exact dependency source pairs for multi-source receipts", async () => {
    const refreshSession = vi.fn(async () => ({
      lastGlobalPosition: "7",
      state: "caught-up",
      lastError: null,
    }));
    const refreshMarketInput = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: null,
    }));

    await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshSession }],
        },
        {
          targetContextName: "checkout",
          projectionName: "checkout.market-input-projection",
          ownedTables: ["checkout_market_input_pages"],
          subscriptionRunners: [{ sourceContextName: "marketplace", refreshStatus: refreshMarketInput }],
        },
      ],
      targetContextNames: ["checkout"],
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      receipt: {
        observedAtMs: 1,
        sources: [
          { sourceContextName: "checkout", maxGlobalPosition: "7", eventIds: ["evt_checkout"] },
          { sourceContextName: "marketplace", maxGlobalPosition: "9", eventIds: ["evt_marketplace"] },
        ],
      },
      timeoutMs: 0,
      pollIntervalMs: 1,
    });

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(refreshMarketInput).not.toHaveBeenCalled();
  });

  it("honors read target context for multi-source receipts on shared mount routes", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const refreshCheckoutResource = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: "checkout should not be inspected",
    }));
    const refreshPaymentLocal = vi.fn(async () => ({
      lastGlobalPosition: "11",
      state: "caught-up",
      lastError: null,
    }));
    const refreshPaymentCheckoutInput = vi.fn(async () => ({
      lastGlobalPosition: "7",
      state: "caught-up",
      lastError: null,
    }));
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        { sourceContextName: "checkout", maxGlobalPosition: "7", eventIds: ["evt_checkout"] },
        { sourceContextName: "payments", maxGlobalPosition: "11", eventIds: ["evt_payment"] },
        { sourceContextName: "inventory", maxGlobalPosition: "99", eventIds: ["evt_inventory"] },
      ],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "checkout.shared-projection" }],
            },
          ],
        },
        {
          contextName: "payments",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "payments.shared-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.shared-projection",
          ownedTables: ["checkout_shared_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCheckoutResource }],
        },
        {
          targetContextName: "payments",
          projectionName: "payments.shared-projection",
          ownedTables: ["payments_shared_pages"],
          subscriptionRunners: [
            { sourceContextName: "payments", refreshStatus: refreshPaymentLocal },
            { sourceContextName: "checkout", refreshStatus: refreshPaymentCheckoutInput },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/shared/pay_1",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            if (name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER) {
              return "payments";
            }
            return undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(refreshPaymentLocal).toHaveBeenCalledTimes(1);
    expect(refreshPaymentCheckoutInput).toHaveBeenCalledTimes(1);
    expect(refreshCheckoutResource).not.toHaveBeenCalled();
  });

  it("reports only pending dependency source pairs for multi-source shared mount timeouts", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const refreshCheckoutResource = vi.fn(async () => ({
      lastGlobalPosition: "1",
      state: "behind",
      lastError: "checkout should not be inspected",
    }));
    const refreshPaymentLocal = vi.fn(async () => ({
      lastGlobalPosition: "11",
      state: "caught-up",
      lastError: null,
    }));
    const refreshPaymentCheckoutInput = vi.fn(async () => ({
      lastGlobalPosition: "3",
      state: "behind",
      lastError: "checkout input lagging",
    }));
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        { sourceContextName: "checkout", maxGlobalPosition: "7", eventIds: ["evt_checkout"] },
        { sourceContextName: "payments", maxGlobalPosition: "11", eventIds: ["evt_payment"] },
        { sourceContextName: "inventory", maxGlobalPosition: "99", eventIds: ["evt_inventory"] },
      ],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "checkout.shared-projection" }],
            },
          ],
        },
        {
          contextName: "payments",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/shared/:id",
              dependencies: [{ projectionName: "payments.shared-projection" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.shared-projection",
          ownedTables: ["checkout_shared_pages"],
          subscriptionRunners: [{ sourceContextName: "checkout", refreshStatus: refreshCheckoutResource }],
        },
        {
          targetContextName: "payments",
          projectionName: "payments.shared-projection",
          ownedTables: ["payments_shared_pages"],
          subscriptionRunners: [
            { sourceContextName: "payments", refreshStatus: refreshPaymentLocal },
            { sourceContextName: "checkout", refreshStatus: refreshPaymentCheckoutInput },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    let nextCalled = false;
    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/shared/pay_1",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            if (name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER) {
              return "payments";
            }
            return undefined;
          },
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(false);
    expect(refreshPaymentLocal).toHaveBeenCalledTimes(1);
    expect(refreshPaymentCheckoutInput).toHaveBeenCalledTimes(1);
    expect(refreshCheckoutResource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
          dependencies: [{ targetContextName: "payments", projectionName: "payments.shared-projection" }],
          pending: [
            {
              targetContextName: "payments",
              projectionName: "payments.shared-projection",
              sourceContextName: "checkout",
              requiredGlobalPosition: "7",
              lastGlobalPosition: "3",
              lastError: "present",
            },
          ],
        },
      },
    });
  });

  it("returns exact Checkout session dependency diagnostics in projection freshness timeout responses", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
    });

    attachReadConsistencyMiddleware(
      {
        use: (_path, middleware) => {
          middlewares.push(middleware);
        },
      },
      [
        {
          contextName: "checkout",
          mountPath: "/api/marketplace",
          readFreshnessRoutes: [
            {
              routePath: "/account/checkout-sessions/:sessionId",
              dependencies: [{ readModelTable: "checkout_session_pages" }],
            },
          ],
        },
      ],
      [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          ownedTables: ["checkout_session_pages"],
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              refreshStatus: async () => ({
                lastGlobalPosition: "1",
                state: "behind",
                lastError: "worker lagging",
              }),
            },
          ],
        },
      ],
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    const result = await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_1",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(result).toMatchObject({
      status: 503,
      body: {
        error: {
          code: "projection_freshness_timeout",
          waitMode: "exact-dependency",
          dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
          pending: [
            {
              targetContextName: "checkout",
              projectionName: "checkout.session-projection",
              sourceContextName: "checkout",
              requiredGlobalPosition: "5",
              lastGlobalPosition: "1",
              lastError: "present",
            },
          ],
        },
      },
    });
  });
});
