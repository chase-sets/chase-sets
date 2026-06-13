import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { createEventCoreMock, createEventCorePostgresMock, resetMockPoolState } from "./index-test-harness";

vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());

import { attachReadConsistencyMiddleware } from "./index";

describe("bounded context read consistency audit", () => {
  beforeEach(() => {
    resetMockPoolState();
  });

  it("audits matched freshness routes that arrive without a read-after-write receipt", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];

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
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
      ],
      {
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
        nowMs: () => 100,
      },
    );

    let nextCalled = false;
    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_secret_session",
          header: () => undefined,
        },
      },
      async () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      type: "read-after-write.freshness",
      outcome: "missing-receipt",
      method: "GET",
      mountPath: "/api/marketplace",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: false,
      readTargetContextHeaderPresent: false,
      readTargetContextHeaderValid: false,
      requestedTargetContextName: null,
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      receiptSourceContextNames: [],
      receiptSourceCount: 0,
      receiptEventCount: 0,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });
    expect(JSON.stringify(auditRecords)).not.toContain("chk_secret_session");
  });

  it("audits successful exact dependency waits without logging raw token, path ids, or event ids", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_secret_checkout"] }],
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
              dependencies: [{ projectionName: "checkout.session-projection" }],
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
      ],
      {
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
        nowMs: () => 250,
      },
    );

    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_secret_session",
          header: (name: string) => {
            if (name === CHASE_SETS_READ_AFTER_WRITE_HEADER) {
              return receipt;
            }
            return name === CHASE_SETS_READ_TARGET_CONTEXT_HEADER ? "checkout" : undefined;
          },
        },
      },
      async () => undefined,
    );

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      type: "read-after-write.freshness",
      outcome: "fresh",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: true,
      readTargetContextHeaderValid: true,
      requestedTargetContextName: "checkout",
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 1,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [],
    });
    const serializedAudit = JSON.stringify(auditRecords);
    expect(serializedAudit).not.toContain(receipt);
    expect(serializedAudit).not.toContain("chk_secret_session");
    expect(serializedAudit).not.toContain("evt_secret_checkout");
    expect(serializedAudit).not.toContain("todd.skelton@outlook.com");
  });

  it("audits projection freshness timeouts with pending lag diagnostics", async () => {
    const middlewares: ((context: unknown, next: () => Promise<void>) => Promise<unknown>)[] = [];
    const auditRecords: unknown[] = [];
    const receipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_secret_checkout"] }],
    });
    const nowValues = [1_000, 1_175];

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
      {
        timeoutMs: 0,
        pollIntervalMs: 1,
        recordReadConsistencyAudit: (record) => auditRecords.push(record),
        nowMs: () => nowValues.shift() ?? 1_175,
      },
    );

    await middlewares[0](
      {
        req: {
          method: "GET",
          path: "/api/marketplace/account/checkout-sessions/chk_secret_session",
          header: (name: string) => (name === CHASE_SETS_READ_AFTER_WRITE_HEADER ? receipt : undefined),
        },
        json: (body: unknown, status: number) => ({ body, status }),
      },
      async () => undefined,
    );

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0]).toMatchObject({
      type: "read-after-write.freshness",
      outcome: "timeout",
      routePaths: ["/account/checkout-sessions/:sessionId"],
      readAfterWriteHeaderPresent: true,
      readTargetContextHeaderPresent: false,
      readTargetContextHeaderValid: false,
      targetContextNames: ["checkout"],
      waitMode: "exact-dependency",
      durationMs: 175,
      receiptSourceContextNames: ["checkout"],
      receiptSourceCount: 1,
      receiptEventCount: 1,
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      pending: [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          sourceContextName: "checkout",
          requiredGlobalPosition: "5",
          lastGlobalPosition: "1",
          globalPositionLag: "4",
          state: "behind",
          lastError: "present",
        },
      ],
    });
    const serializedAudit = JSON.stringify(auditRecords);
    expect(serializedAudit).not.toContain(receipt);
    expect(serializedAudit).not.toContain("chk_secret_session");
    expect(serializedAudit).not.toContain("evt_secret_checkout");
    expect(serializedAudit).not.toContain("worker lagging");
  });
});
