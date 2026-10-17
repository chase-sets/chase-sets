import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventCoreMock, createEventCorePostgresMock, resetMockPoolState } from "./index-test-harness";

vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());

import { ProjectionFreshnessTimeoutError, waitForProjectionFreshness } from "./index";

describe("reaction output freshness", () => {
  function fixture() {
    const reaction = {
      sourceContextName: "marketplace",
      checkpointKey: "reaction:marketplace:v1",
      refreshStatus: vi.fn(async () => ({ lastGlobalPosition: "1000", state: "degraded", lastError: "private" })),
      readReceiptApplicationOutputs: vi.fn(async (_ids: readonly string[]) => ({
        state: "applied" as "applied" | "pending" | "failed",
        outputPositions: ["20"],
      })),
    };
    const destination = {
      sourceContextName: "ordering",
      checkpointKey: "orders:ordering:v1",
      refreshStatus: vi.fn(async () => ({ lastGlobalPosition: "19", state: "behind", lastError: null })),
      readOutputApplicationStatus: vi.fn(async (_positions: readonly string[]) => ({
        failed: false,
        requiredGlobalPosition: "20" as string | null,
      })),
    };
    return {
      reaction,
      destination,
      input: {
        projectionGroups: [
          {
            targetContextName: "ordering",
            projectionName: "reaction",
            handlerKind: "reaction",
            subscriptionRunners: [reaction],
          },
          { targetContextName: "ordering", projectionName: "orders", subscriptionRunners: [destination] },
        ],
        targetContextNames: ["ordering"],
        dependencies: [
          { targetContextName: "ordering", projectionName: "reaction" },
          { targetContextName: "ordering", projectionName: "orders" },
        ],
        receipt: {
          observedAtMs: 1,
          sources: [{ sourceContextName: "marketplace", maxGlobalPosition: "1000", eventIds: ["accepted"] }],
        },
        timeoutMs: 0,
        pollIntervalMs: 1,
      },
    };
  }

  it("holds the destination at its recorded position, never the independent receipt position", async () => {
    const { input, destination } = fixture();
    await expect(waitForProjectionFreshness(input)).rejects.toMatchObject({
      name: "ProjectionFreshnessTimeoutError",
      details: { pending: [expect.objectContaining({ projectionName: "orders", requiredGlobalPosition: "20" })] },
    });
    expect(destination.readOutputApplicationStatus).toHaveBeenCalledWith(["20"]);
    destination.refreshStatus.mockResolvedValue({ lastGlobalPosition: "20", state: "caught-up", lastError: null });
    await expect(waitForProjectionFreshness(input)).resolves.toMatchObject({ wakeRequestCount: 0 });
  });

  it.each(["missing", "NULL"])("pends on a %s reaction output record despite its checkpoint", async () => {
    const { input, reaction, destination } = fixture();
    reaction.readReceiptApplicationOutputs.mockResolvedValue({ state: "pending", outputPositions: [] });
    await expect(waitForProjectionFreshness(input)).rejects.toMatchObject({
      name: "ProjectionFreshnessTimeoutError",
      details: { pending: [expect.objectContaining({ projectionName: "reaction" })] },
    });
    expect(destination.readOutputApplicationStatus).not.toHaveBeenCalled();
  });

  it("requires the reaction checkpoint even when its output record is applied", async () => {
    const { input, reaction } = fixture();
    reaction.refreshStatus.mockResolvedValue({ lastGlobalPosition: "999", state: "behind", lastError: "private" });
    await expect(waitForProjectionFreshness(input)).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
  });

  it("refuses receipt-scoped reaction failure immediately, even below its checkpoint", async () => {
    const { input, reaction } = fixture();
    reaction.refreshStatus.mockResolvedValue({ lastGlobalPosition: "0", state: "degraded", lastError: "private" });
    reaction.readReceiptApplicationOutputs.mockResolvedValue({ state: "failed", outputPositions: [] });
    await expect(waitForProjectionFreshness(input)).rejects.toMatchObject({
      name: "ProjectionFreshnessFailedError",
      details: { pending: [expect.objectContaining({ projectionName: "reaction" })] },
    });
  });

  it("refuses destination poison or deferral only after reaching its exact output target", async () => {
    const { input, destination } = fixture();
    destination.readOutputApplicationStatus.mockResolvedValue({ failed: true, requiredGlobalPosition: "20" });
    await expect(waitForProjectionFreshness(input)).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
    destination.refreshStatus.mockResolvedValue({ lastGlobalPosition: "20", state: "degraded", lastError: null });
    await expect(waitForProjectionFreshness(input)).rejects.toMatchObject({ name: "ProjectionFreshnessFailedError" });
  });

  it("has no destination requirement for an empty record or outputs the destination does not handle", async () => {
    const { input, reaction, destination } = fixture();
    reaction.readReceiptApplicationOutputs.mockResolvedValue({ state: "applied", outputPositions: [] });
    await expect(waitForProjectionFreshness(input)).resolves.toMatchObject({ wakeRequestCount: 0 });
    reaction.readReceiptApplicationOutputs.mockResolvedValue({ state: "applied", outputPositions: ["20"] });
    destination.readOutputApplicationStatus.mockResolvedValue({ failed: false, requiredGlobalPosition: null });
    await expect(waitForProjectionFreshness(input)).resolves.toMatchObject({ wakeRequestCount: 0 });
  });

  it("freezes exact outputs and adds only one newly pending destination wake batch", async () => {
    const { input, reaction, destination } = fixture();
    reaction.refreshStatus.mockResolvedValueOnce({ lastGlobalPosition: "0", state: "behind", lastError: "private" });
    const requestWake = vi.fn(async () => 1);
    let notification = 0;
    await waitForProjectionFreshness({
      ...input,
      timeoutMs: 100,
      workSignalGateway: {
        requestWake,
        waitForReadiness: async () => {
          notification += 1;
          if (notification === 2) {
            reaction.readReceiptApplicationOutputs.mockResolvedValue({ state: "applied", outputPositions: ["99999"] });
            destination.refreshStatus.mockResolvedValue({
              lastGlobalPosition: "20",
              state: "caught-up",
              lastError: null,
            });
          }
          return "notified";
        },
      },
    });
    expect(requestWake.mock.calls).toHaveLength(2);
    expect(requestWake.mock.calls[1]).toEqual([
      expect.objectContaining({ requests: [expect.objectContaining({ requiredPosition: "20" })] }),
    ]);
    expect(reaction.readReceiptApplicationOutputs).toHaveBeenCalledTimes(3);
    expect(destination.readOutputApplicationStatus).toHaveBeenLastCalledWith(["20"]);
  });
});

describe("bounded context projection freshness waits", () => {
  beforeEach(() => {
    resetMockPoolState();
  });

  afterEach(() => {
    vi.useRealTimers();
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

    const pollIntervalMs = 500;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let settled = false;
    const wait = waitForProjectionFreshness({
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
      pollIntervalMs,
      nowMs: () => Date.now(),
      workSignalGateway: {
        waitForReadiness: async (input) => {
          waitCalls.push(input);
          lastGlobalPosition = "5";
          return "notified";
        },
      },
    }).finally(() => {
      settled = true;
    });

    // The notification, not the poll interval, must trigger the recheck: the
    // wait settles while less fake time than one poll interval has elapsed.
    await vi.advanceTimersByTimeAsync(pollIntervalMs - 1);
    expect(settled, "wait did not settle before the poll interval elapsed").toBe(true);
    const outcome = await wait;
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
