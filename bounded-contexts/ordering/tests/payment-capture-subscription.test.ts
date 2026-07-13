import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { module as orderingModule } from "../index";
import type { OrderingServices } from "../support/runtime-support/services";

type QueryCall = Readonly<{
  text: string;
  values?: readonly unknown[];
}>;

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function createServices(
  commandHandler: OrderingServices["orders"]["commandHandler"],
  queryCalls: QueryCall[] = [],
  orderRows: readonly Readonly<{ order_id: string; status: string }>[] = [],
  orderServiceOverrides: Partial<OrderingServices["orders"]> = {},
): OrderingServices {
  return {
    db: {
      query: async (text: string, values?: readonly unknown[]) => {
        queryCalls.push({ text, values });
        if (text.includes("FROM ordering_order_pages")) {
          return { rows: [...orderRows], rowCount: orderRows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    },
    orders: { commandHandler, ...orderServiceOverrides } as OrderingServices["orders"],
    postagePolicies: {} as OrderingServices["postagePolicies"],
    projectors: [],
    pool: {} as OrderingServices["pool"],
  };
}

function getPaymentHandler<T extends keyof ReturnType<typeof getPaymentCaptureSubscription>["handlers"]>(
  services: OrderingServices,
  eventType: T,
) {
  const subscription = (orderingModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) => candidate.subscriptionName === "ordering.payment-capture",
  );
  const handler = subscription?.handlers[eventType];

  if (!handler) {
    throw new Error(`Ordering payment-capture subscription handler for ${String(eventType)} was not registered.`);
  }

  return handler;
}

function getPaymentCapturedHandler(services: OrderingServices) {
  return getPaymentHandler(services, "payments.payment-captured");
}

function getPaymentCaptureSubscription(services: OrderingServices) {
  const subscription = (orderingModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) => candidate.subscriptionName === "ordering.payment-capture",
  );

  if (!subscription) {
    throw new Error("Ordering payment-capture subscription was not registered.");
  }

  return subscription;
}

function createPaymentCapturedEvent(orderIds: readonly string[]): TransportEvent {
  const capturedAt = "2026-06-12T10:30:00.000Z";

  return buildTransportEvent(
    "payments.payment-captured",
    {
      paymentId: "pay_1",
      orderIds: [...orderIds],
      buyerAccountId: "acc_buyer",
      amount: "42.00",
      currencyCode: "usd",
      processorName: "stripe",
      processorPaymentReference: "pi_1",
      processorStatus: "succeeded",
      capturedAt,
    },
    {
      id: "evt_payment_captured",
      streamId: "payments.payment-pay_1",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_system", forAccountId: "acc_buyer" },
      trace: { traceId: "trace_1" },
      timing: { occurredAt: capturedAt, recordedAt: capturedAt },
    },
  );
}

function createPaymentCreatedEvent(orderIds: readonly string[]): TransportEvent {
  const createdAt = "2026-06-12T10:00:00.000Z";

  return buildTransportEvent(
    "payments.payment-created",
    {
      paymentId: "pay_1",
      orderIds: [...orderIds],
      buyerAccountId: "acc_buyer",
      amount: "42.00",
      currencyCode: "usd",
      paymentMethodCategory: "bank-account",
      processorName: "stripe",
      processorPaymentReference: "pi_1",
      processorStatus: "requires_action",
      createdAt,
    },
    {
      id: "evt_payment_created",
      streamId: "payments.payment-pay_1",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_system", forAccountId: "acc_buyer" },
      trace: { traceId: "trace_1" },
      timing: { occurredAt: createdAt, recordedAt: createdAt },
    },
  );
}

function createPaymentFailedEvent(orderIds: readonly string[]): TransportEvent {
  const failedAt = "2026-06-12T10:05:00.000Z";

  return buildTransportEvent(
    "payments.payment-failed",
    {
      paymentId: "pay_1",
      orderIds: [...orderIds],
      buyerAccountId: "acc_buyer",
      amount: "42.00",
      currencyCode: "usd",
      processorName: "stripe",
      processorPaymentReference: "pi_1",
      processorStatus: "failed",
      failureCode: "requires_payment_method",
      failureMessage: null,
      failedAt,
    },
    {
      id: "evt_payment_failed",
      streamId: "payments.payment-pay_1",
      streamVersion: 2,
      globalPosition: "2",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_system", forAccountId: "acc_buyer" },
      trace: { traceId: "trace_1" },
      timing: { occurredAt: failedAt, recordedAt: failedAt },
    },
  );
}

describe("ordering payment-capture subscription", () => {
  it("registers payment capture as a reaction with explicit failure semantics", () => {
    expect(getPaymentCaptureSubscription(createServices(async () => undefined as never))).toMatchObject({
      handlerKind: "reaction",
      idempotencyPolicy: "idempotent-command-dispatch",
      retryPolicy: "retry-from-last-checkpoint",
      failurePolicy: "surface-as-reaction-failure",
    });
  });

  it("registers only payment events that feed capture and deadline workflows", () => {
    const subscription = getPaymentCaptureSubscription(createServices(async () => undefined as never));

    expect(subscription.handlers["payments.payment-authorized"]).toBeUndefined();
    expect(Object.keys(subscription.handlers)).toEqual([
      "payments.payment-created",
      "payments.payment-captured",
      "payments.payment-failed",
      "payments.payment-cancelled",
    ]);
  });

  it("records payment-created deadlines without dispatching fulfillment readiness", async () => {
    const recordPaymentDeadlineStarted = vi.fn(async () => 2);
    const commandHandler = vi.fn(async () => undefined as never);
    const handler = getPaymentHandler(
      createServices(commandHandler, [], [], { recordPaymentDeadlineStarted } as Partial<OrderingServices["orders"]>),
      "payments.payment-created",
    );

    await handler(createPaymentCreatedEvent(["ord_1", "ord_2"]));

    expect(recordPaymentDeadlineStarted).toHaveBeenCalledWith({
      paymentId: "pay_1",
      orderIds: ["ord_1", "ord_2"],
      paymentMethodCategory: "bank-account",
      paymentStartedAt: "2026-06-12T10:00:00.000Z",
    });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("records terminal failure deadlines without dispatching fulfillment readiness", async () => {
    const recordTerminalPaymentFailureDeadline = vi.fn(async () => 2);
    const commandHandler = vi.fn(async () => undefined as never);
    const handler = getPaymentHandler(
      createServices(commandHandler, [], [], {
        recordTerminalPaymentFailureDeadline,
      } as Partial<OrderingServices["orders"]>),
      "payments.payment-failed",
    );

    await handler(createPaymentFailedEvent(["ord_1", "ord_2"]));

    expect(recordTerminalPaymentFailureDeadline).toHaveBeenCalledWith({
      paymentId: "pay_1",
      orderIds: ["ord_1", "ord_2"],
      failedAt: "2026-06-12T10:05:00.000Z",
      failureCode: "requires_payment_method",
    });
    expect(commandHandler).not.toHaveBeenCalled();
  });

  it("stores captured order IDs as JSONB and starts per-order command dispatch concurrently", async () => {
    const firstDispatchStarted = createDeferred();
    const releaseFirstDispatch = createDeferred();
    const queryCalls: QueryCall[] = [];
    const startedStreams: string[] = [];
    const commandHandler: OrderingServices["orders"]["commandHandler"] = async (input) => {
      startedStreams.push(input.streamId);

      if (input.streamId === "ordering.order-ord_1") {
        firstDispatchStarted.resolve();
        await releaseFirstDispatch.promise;
      }

      return undefined as never;
    };
    const handler = getPaymentCapturedHandler(createServices(commandHandler, queryCalls));
    const handling = handler(createPaymentCapturedEvent(["ord_1", "ord_2"]));

    await firstDispatchStarted.promise;
    expect(startedStreams).toEqual(["ordering.order-ord_1", "ordering.order-ord_2"]);

    releaseFirstDispatch.resolve();
    await handling;

    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0]?.text).toContain("to_jsonb($3::text[])");
    expect(queryCalls[0]?.values?.[2]).toEqual(["ord_1", "ord_2"]);
    expect(queryCalls[1]?.text).toContain("FROM ordering_order_pages");
    expect(queryCalls[1]?.values?.[0]).toEqual(["ord_1", "ord_2"]);
  });

  it("does not mark already-cancelled captured orders ready for fulfillment", async () => {
    const startedStreams: string[] = [];
    const commandHandler: OrderingServices["orders"]["commandHandler"] = async (input) => {
      startedStreams.push(input.streamId);
      return undefined as never;
    };
    const handler = getPaymentCapturedHandler(
      createServices(
        commandHandler,
        [],
        [
          { order_id: "ord_cancelled", status: "cancelled" },
          { order_id: "ord_ready", status: "pending-payment" },
        ],
      ),
    );

    await handler(createPaymentCapturedEvent(["ord_cancelled", "ord_ready"]));

    expect(startedStreams).toEqual(["ordering.order-ord_ready"]);
  });

  it("waits for all order dispatches before rejecting partial payment-capture failures", async () => {
    const successfulDispatchStarted = createDeferred();
    const releaseSuccessfulDispatch = createDeferred();
    const settledStreams: string[] = [];
    const commandHandler: OrderingServices["orders"]["commandHandler"] = async (input) => {
      if (input.streamId === "ordering.order-ord_success") {
        successfulDispatchStarted.resolve();
        await releaseSuccessfulDispatch.promise;
        settledStreams.push(input.streamId);
        return undefined as never;
      }

      settledStreams.push(input.streamId);
      throw new Error("order dispatch failed");
    };
    const handler = getPaymentCapturedHandler(createServices(commandHandler));
    const handling = handler(createPaymentCapturedEvent(["ord_success", "ord_failure"]));

    await successfulDispatchStarted.promise;
    releaseSuccessfulDispatch.resolve();

    let thrown: unknown;
    try {
      await handling;
    } catch (error) {
      thrown = error;
    }

    expect(settledStreams).toEqual(["ordering.order-ord_failure", "ordering.order-ord_success"]);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toBe("Failed to mark 1 of 2 captured order(s) ready for fulfillment.");
    expect((thrown as AggregateError).errors).toHaveLength(1);
  });
});
