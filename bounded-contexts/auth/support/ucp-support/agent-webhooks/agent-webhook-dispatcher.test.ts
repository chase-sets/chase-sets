import { describe, expect, it, vi } from "vitest";
import type {
  AgentWebhookOutbox,
  ClaimedAgentWebhookDelivery,
  MarkAgentWebhookDeliveryFailedInput,
  MarkAgentWebhookDeliverySentInput,
} from "./agent-webhook-outbox";
import {
  createAgentWebhookDispatcher,
  defaultAgentWebhookRetryDelayMs,
  type AgentWebhookSendRequest,
} from "./agent-webhook-dispatcher";
import { AGENT_WEBHOOK_SIGNATURE_HEADER, verifyAgentWebhookSignature } from "./webhook-signing";

const now = () => new Date("2026-07-09T00:00:00.000Z");

function claimed(overrides: Partial<ClaimedAgentWebhookDelivery> = {}): ClaimedAgentWebhookDelivery {
  return {
    outboxId: "1",
    deliveryId: "ocl_1:evt_1:ord_1",
    clientId: "ocl_1",
    accountId: "acc_buyer",
    callbackUrl: "https://agent.example/hooks",
    sourceEventId: "evt_1",
    eventType: "ordering.order.created",
    orderId: "ord_1",
    orderStatus: "created",
    payloadJson: '{"type":"order.updated","order":{"id":"ord_1","status":"created"}}',
    status: "sending",
    attemptCount: 1,
    maxAttempts: 8,
    nextAttemptAt: "2026-07-09T00:00:00.000Z",
    lastError: null,
    ...overrides,
  };
}

function fakeOutbox(deliveries: readonly ClaimedAgentWebhookDelivery[], renew = true) {
  const sent: MarkAgentWebhookDeliverySentInput[] = [];
  const failed: MarkAgentWebhookDeliveryFailedInput[] = [];
  const outbox = {
    claimPendingDeliveries: vi.fn(async () => deliveries),
    renewClaim: vi.fn(async () => renew),
    markDelivered: vi.fn(async (input: MarkAgentWebhookDeliverySentInput) => {
      sent.push(input);
    }),
    markFailed: vi.fn(async (input: MarkAgentWebhookDeliveryFailedInput) => {
      failed.push(input);
    }),
  } as unknown as AgentWebhookOutbox;
  return { outbox, sent, failed };
}

describe("agent webhook dispatcher", () => {
  it("signs and delivers, marking a 2xx response sent", async () => {
    const { outbox, sent } = fakeOutbox([claimed()]);
    let seen: AgentWebhookSendRequest | null = null;
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      resolveSigningSecret: async () => "whsec_secret",
      send: async (request) => {
        seen = request;
        return { status: 202 };
      },
      claimOwnerId: "worker-1",
      now,
    });

    const result = await dispatcher.runOnce();

    expect(result.processed).toBe(1);
    expect(sent[0]).toMatchObject({ deliveryId: "ocl_1:evt_1:ord_1", responseStatus: 202 });
    const request = seen as AgentWebhookSendRequest | null;
    expect(request).not.toBeNull();
    const header = request!.headers[AGENT_WEBHOOK_SIGNATURE_HEADER];
    expect(
      verifyAgentWebhookSignature({
        signingSecret: "whsec_secret",
        body: request!.body,
        header,
        nowSeconds: Math.floor(now().getTime() / 1000),
      }),
    ).toBe(true);
  });

  it("schedules a retry with backoff on a 5xx response", async () => {
    const { outbox, failed } = fakeOutbox([claimed({ attemptCount: 2 })]);
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      resolveSigningSecret: async () => "whsec_secret",
      send: async () => ({ status: 503 }),
      claimOwnerId: "worker-1",
      now,
    });

    await dispatcher.runOnce();

    expect(failed[0].retryAt).toBe(new Date(now().getTime() + defaultAgentWebhookRetryDelayMs(2)).toISOString());
    expect(failed[0].responseStatus).toBe(503);
  });

  it("dead-letters once attempts are exhausted", async () => {
    const { outbox, failed } = fakeOutbox([claimed({ attemptCount: 8, maxAttempts: 8 })]);
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      resolveSigningSecret: async () => "whsec_secret",
      send: async () => {
        throw new Error("connection reset");
      },
      claimOwnerId: "worker-1",
      now,
    });

    await dispatcher.runOnce();

    expect(failed[0].retryAt).toBeNull();
    expect(failed[0].error).toContain("connection reset");
  });

  it("dead-letters immediately when the signing secret is gone", async () => {
    const { outbox, failed } = fakeOutbox([claimed()]);
    const send = vi.fn(async () => ({ status: 200 }));
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      resolveSigningSecret: async () => null,
      send,
      claimOwnerId: "worker-1",
      now,
    });

    await dispatcher.runOnce();

    expect(send).not.toHaveBeenCalled();
    expect(failed[0].retryAt).toBeNull();
    expect(failed[0].error).toContain("signing secret");
  });

  it("skips a delivery whose claim could not be renewed", async () => {
    const { outbox, sent, failed } = fakeOutbox([claimed()], false);
    const send = vi.fn(async () => ({ status: 200 }));
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      resolveSigningSecret: async () => "whsec_secret",
      send,
      claimOwnerId: "worker-1",
      now,
    });

    await dispatcher.runOnce();

    expect(send).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(failed).toHaveLength(0);
  });
});
