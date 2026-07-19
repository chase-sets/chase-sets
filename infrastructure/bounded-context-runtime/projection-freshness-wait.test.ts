import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEventCoreMock, createEventCorePostgresMock, resetMockPoolState } from "./index-test-harness";

vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());

import { ProjectionFreshnessTimeoutError, waitForProjectionFreshness } from "./index";

describe("bounded context projection freshness waits", () => {
  beforeEach(() => {
    resetMockPoolState();
  });

  it("waits for matching projection runners to reach a write receipt", async () => {
    let lastGlobalPosition = "1";
    let refreshCount = 0;

    await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 1) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(refreshCount).toBe(2);
  });

  it("rechecks freshness immediately when checkpoint readiness is notified before the poll interval", async () => {
    let lastGlobalPosition = "1";
    let refreshCount = 0;
    const waitCalls: { timeoutMs: number; requests: readonly { checkpointKey: string; requiredPosition: string }[] }[] =
      [];

    const startedAt = performance.now();
    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => {
                refreshCount += 1;
                return {
                  lastGlobalPosition,
                  state: lastGlobalPosition === "5" ? "caught-up" : "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 1_000,
      pollIntervalMs: 500,
      workSignalGateway: {
        waitForReadiness: async (input) => {
          waitCalls.push(input);
          lastGlobalPosition = "5";
          return "notified";
        },
      },
    });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(outcome).toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
    expect(refreshCount).toBe(2);
    expect(waitCalls).toEqual([
      {
        timeoutMs: 500,
        requests: [
          {
            sourceContextName: "marketplace",
            targetContextName: "marketplace",
            projectionName: "marketplace-listing-projection",
            checkpointKey: "marketplace-listing-projection:marketplace:v1",
            requiredPosition: "5",
          },
        ],
      },
    ]);
  });

  it("keeps polling semantics when checkpoint readiness notifications are unavailable", async () => {
    let lastGlobalPosition = "1";
    let refreshCount = 0;
    let waitCount = 0;

    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 2) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: lastGlobalPosition === "5" ? "caught-up" : "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
      workSignalGateway: {
        waitForReadiness: async () => {
          waitCount += 1;
          return "listener-unavailable";
        },
      },
    });

    expect(outcome).toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
    expect(refreshCount).toBe(3);
    expect(waitCount).toBe(2);
  });

  it("fails closed when projections do not reach the receipt before timeout", async () => {
    await expect(
      waitForProjectionFreshness({
        projectionGroups: [
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
        targetContextNames: ["marketplace"],
        receipt: {
          observedAtMs: 1,
          sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
        },
        timeoutMs: 0,
        pollIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
  });

  it("returns fresh from an eligible runner's completed receipt applications while its checkpoint is behind", async () => {
    const areReceiptEventsApplied = vi.fn(async () => true);

    await expect(
      waitForProjectionFreshness({
        projectionGroups: [
          {
            targetContextName: "marketplace",
            projectionName: "marketplace-listing-projection",
            subscriptionRunners: [
              {
                sourceContextName: "marketplace",
                inlineApply: true,
                errorPolicy: "strict-per-stream",
                areReceiptEventsApplied,
                refreshStatus: async () => ({
                  lastGlobalPosition: "1",
                  state: "behind",
                  lastError: null,
                }),
              },
            ],
          },
        ],
        targetContextNames: ["marketplace"],
        receipt: {
          observedAtMs: 1,
          sources: [
            {
              sourceContextName: "marketplace",
              maxGlobalPosition: "5",
              eventIds: ["evt_subscribed", "evt_ignored"],
            },
          ],
        },
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
    expect(areReceiptEventsApplied).toHaveBeenCalledOnce();
    expect(areReceiptEventsApplied).toHaveBeenCalledWith(["evt_subscribed", "evt_ignored"]);
  });

  it("keeps checkpoint-only behavior for receipts without event ids and when the ledger query fails", async () => {
    const noIdsLedgerCheck = vi.fn(async () => true);
    const failedLedgerCheck = vi.fn(async () => {
      throw new Error("ledger unavailable");
    });
    const createInput = (
      eventIds: readonly string[],
      areReceiptEventsApplied: (ids: readonly string[]) => Promise<boolean>,
    ) => ({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              inlineApply: true,
              areReceiptEventsApplied,
              refreshStatus: async () => ({ lastGlobalPosition: "1", state: "behind", lastError: null }),
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds }],
      },
      timeoutMs: 0,
      pollIntervalMs: 1,
    });

    await expect(waitForProjectionFreshness(createInput([], noIdsLedgerCheck))).rejects.toBeInstanceOf(
      ProjectionFreshnessTimeoutError,
    );
    expect(noIdsLedgerCheck).not.toHaveBeenCalled();

    await expect(waitForProjectionFreshness(createInput(["evt_5"], failedLedgerCheck))).rejects.toBeInstanceOf(
      ProjectionFreshnessTimeoutError,
    );
    expect(failedLedgerCheck).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "global-strict", group: {}, runner: { errorPolicy: "global-strict" } },
    { label: "side-effect-only", group: { sideEffectOnly: true }, runner: {} },
    { label: "reaction", group: { handlerKind: "reaction" }, runner: {} },
  ])("does not use ledger freshness for $label runner-owned work", async ({ group, runner }) => {
    const areReceiptEventsApplied = vi.fn(async () => true);

    await expect(
      waitForProjectionFreshness({
        projectionGroups: [
          {
            targetContextName: "marketplace",
            projectionName: "marketplace-listing-projection",
            ...group,
            subscriptionRunners: [
              {
                sourceContextName: "marketplace",
                inlineApply: true,
                areReceiptEventsApplied,
                ...runner,
                refreshStatus: async () => ({ lastGlobalPosition: "1", state: "behind", lastError: null }),
              },
            ],
          },
        ],
        targetContextNames: ["marketplace"],
        receipt: {
          observedAtMs: 1,
          sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
        },
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
    expect(areReceiptEventsApplied).not.toHaveBeenCalled();
  });

  it("requests a wake and registers waiters once for exactly the pending dependencies", async () => {
    const wakeCalls: { requests: readonly unknown[]; metadata?: unknown }[] = [];
    const waiterCalls: { requests: readonly unknown[]; timeoutMs: number }[] = [];
    let lastGlobalPosition = "1";
    let refreshCount = 0;

    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 1) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
      workSignalGateway: {
        requestWake: async (input) => {
          wakeCalls.push(input);
          return input.requests.length;
        },
        registerWaiters: async (input) => {
          waiterCalls.push(input);
        },
      },
      workSignalMetadata: { mountPath: "/api/marketplace" },
    });

    expect(outcome).toEqual({ wakeRequestCount: 1, workSignalErrorPresent: false });
    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0].requests).toEqual([
      {
        sourceContextName: "marketplace",
        targetContextName: "marketplace",
        projectionName: "marketplace-listing-projection",
        checkpointKey: "marketplace-listing-projection:marketplace:v1",
        requiredPosition: "5",
      },
    ]);
    expect(wakeCalls[0].metadata).toEqual({ mountPath: "/api/marketplace" });
    expect(waiterCalls).toHaveLength(1);
    expect(waiterCalls[0].timeoutMs).toBe(100);
  });

  it("keeps exact-dependency waits correct without a work-signal gateway", async () => {
    let checkoutRefreshCount = 0;
    let paymentsRefreshCount = 0;

    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "checkout",
          projectionName: "checkout.session-projection",
          subscriptionRunners: [
            {
              sourceContextName: "checkout",
              checkpointKey: "checkout.session-projection:checkout:v1",
              refreshStatus: async () => {
                checkoutRefreshCount += 1;
                return {
                  lastGlobalPosition: checkoutRefreshCount > 1 ? "5" : "1",
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
        {
          targetContextName: "payments",
          projectionName: "payments.payment-detail-projection",
          subscriptionRunners: [
            {
              sourceContextName: "payments",
              checkpointKey: "payments.payment-detail-projection:payments:v1",
              refreshStatus: async () => {
                paymentsRefreshCount += 1;
                return {
                  lastGlobalPosition: "0",
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["checkout", "payments"],
      dependencies: [{ targetContextName: "checkout", projectionName: "checkout.session-projection" }],
      receipt: {
        observedAtMs: 1,
        sources: [
          { sourceContextName: "checkout", maxGlobalPosition: "5", eventIds: ["evt_checkout_5"] },
          { sourceContextName: "payments", maxGlobalPosition: "5", eventIds: ["evt_payment_5"] },
        ],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
    });

    expect(outcome).toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
    expect(checkoutRefreshCount).toBe(2);
    expect(paymentsRefreshCount).toBe(0);
  });

  it("does not request wakes when projections are already fresh", async () => {
    let wakeRequested = false;

    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => ({
                lastGlobalPosition: "9",
                state: "caught-up",
                lastError: null,
              }),
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
      workSignalGateway: {
        requestWake: async () => {
          wakeRequested = true;
          return 0;
        },
      },
    });

    expect(wakeRequested).toBe(false);
    expect(outcome).toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
  });

  it("continues the durable poll when the work-signal gateway fails", async () => {
    let lastGlobalPosition = "1";
    let refreshCount = 0;

    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 1) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
      workSignalGateway: {
        requestWake: async () => {
          throw new Error("control database unavailable");
        },
      },
    });

    expect(outcome).toEqual({ wakeRequestCount: 0, workSignalErrorPresent: true });
  });

  it("skips wake requests for subscription runners without checkpoint keys", async () => {
    let wakeRequested = false;

    await expect(
      waitForProjectionFreshness({
        projectionGroups: [
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
        targetContextNames: ["marketplace"],
        receipt: {
          observedAtMs: 1,
          sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
        },
        timeoutMs: 0,
        pollIntervalMs: 1,
        workSignalGateway: {
          requestWake: async () => {
            wakeRequested = true;
            return 0;
          },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);

    expect(wakeRequested).toBe(false);
  });

  it("issues a single wake batch even when the wait spans multiple poll iterations", async () => {
    let wakeCalls = 0;
    let lastGlobalPosition = "1";
    let refreshCount = 0;

    await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 3) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 500,
      pollIntervalMs: 1,
      workSignalGateway: {
        requestWake: async (input) => {
          wakeCalls += 1;
          return input.requests.length;
        },
      },
    });

    expect(refreshCount).toBeGreaterThan(3);
    expect(wakeCalls).toBe(1);
  });

  it("keeps the wake count and flags the error when waiter registration fails after a wake succeeds", async () => {
    let lastGlobalPosition = "1";
    let refreshCount = 0;

    const outcome = await waitForProjectionFreshness({
      projectionGroups: [
        {
          targetContextName: "marketplace",
          projectionName: "marketplace-listing-projection",
          subscriptionRunners: [
            {
              sourceContextName: "marketplace",
              checkpointKey: "marketplace-listing-projection:marketplace:v1",
              refreshStatus: async () => {
                refreshCount += 1;
                if (refreshCount > 1) {
                  lastGlobalPosition = "5";
                }

                return {
                  lastGlobalPosition,
                  state: "behind",
                  lastError: null,
                };
              },
            },
          ],
        },
      ],
      targetContextNames: ["marketplace"],
      receipt: {
        observedAtMs: 1,
        sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] }],
      },
      timeoutMs: 100,
      pollIntervalMs: 1,
      workSignalGateway: {
        requestWake: async (input) => input.requests.length,
        registerWaiters: async () => {
          throw new Error("control database unavailable");
        },
      },
    });

    expect(outcome).toEqual({ wakeRequestCount: 1, workSignalErrorPresent: true });
  });

  it("dedupes wake requests by checkpoint and clamps forged positions to the durable source head", async () => {
    const wakeCalls: { requests: readonly { checkpointKey: string; requiredPosition: string }[] }[] = [];

    // The forged source position can never become fresh, so the wait itself
    // times out; the wake request must still be deduped and clamped.
    await expect(
      waitForProjectionFreshness({
        projectionGroups: [
          {
            targetContextName: "marketplace",
            projectionName: "marketplace-listing-projection",
            subscriptionRunners: [
              {
                sourceContextName: "marketplace",
                checkpointKey: "marketplace-listing-projection:marketplace:v1",
                refreshStatus: async () => ({
                  lastGlobalPosition: "1",
                  sourceHeadGlobalPosition: "9",
                  state: "behind",
                  lastError: null,
                }),
              },
            ],
          },
        ],
        targetContextNames: ["marketplace"],
        receipt: {
          observedAtMs: 1,
          sources: [
            { sourceContextName: "marketplace", maxGlobalPosition: "5", eventIds: ["evt_5"] },
            { sourceContextName: "marketplace", maxGlobalPosition: "900000", eventIds: ["evt_forged"] },
          ],
        },
        timeoutMs: 25,
        pollIntervalMs: 1,
        workSignalGateway: {
          requestWake: async (input) => {
            wakeCalls.push({ requests: input.requests });
            return input.requests.length;
          },
        },
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);

    expect(wakeCalls).toHaveLength(1);
    expect(wakeCalls[0].requests).toHaveLength(1);
    expect(wakeCalls[0].requests[0]).toMatchObject({
      checkpointKey: "marketplace-listing-projection:marketplace:v1",
      requiredPosition: "9",
    });
  });
});
