import { describe, expect, it } from "vitest";
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
): OrderingServices {
  return {
    db: {
      query: async (text: string, values?: readonly unknown[]) => {
        queryCalls.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
    },
    orders: { commandHandler } as OrderingServices["orders"],
    postagePolicies: {} as OrderingServices["postagePolicies"],
    projectors: [],
    pool: {} as OrderingServices["pool"],
  };
}

function getPaymentCapturedHandler(services: OrderingServices) {
  const subscription = (orderingModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) => candidate.subscriptionName === "ordering.payment-capture",
  );
  const handler = subscription?.handlers["payments.payment-captured"];

  if (!handler) {
    throw new Error("Ordering payment-capture subscription handler was not registered.");
  }

  return handler;
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

  return {
    id: "evt_payment_captured",
    type: "payments.payment-captured",
    streamId: "payments.payment-pay_1",
    streamVersion: 1,
    globalPosition: "1",
    tenantId: "tenant_1",
    data: {
      paymentId: "pay_1",
      orderIds: [...orderIds],
      buyerAccountId: "acct_buyer",
      amount: "42.00",
      currencyCode: "USD",
      processorName: "stripe",
      processorPaymentReference: "pi_1",
      processorStatus: "succeeded",
      capturedAt,
    },
    metadata: {},
    audit: {
      performedByUserId: "usr_system",
      forAccountId: "acct_buyer",
    },
    trace: {
      traceId: "trace_1",
    },
    timing: {
      occurredAt: capturedAt,
      recordedAt: capturedAt,
    },
  } as unknown as TransportEvent;
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

  it("does not dispatch fulfillment readiness for payment authorization events", () => {
    const subscription = getPaymentCaptureSubscription(createServices(async () => undefined as never));

    expect(subscription.handlers["payments.payment-authorized"]).toBeUndefined();
    expect(Object.keys(subscription.handlers)).toEqual(["payments.payment-captured"]);
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

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0]?.text).toContain("to_jsonb($3::text[])");
    expect(queryCalls[0]?.values?.[2]).toEqual(["ord_1", "ord_2"]);
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
