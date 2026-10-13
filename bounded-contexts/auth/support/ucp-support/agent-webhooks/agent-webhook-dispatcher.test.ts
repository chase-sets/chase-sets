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
import type { AgentGrantRevocations } from "@chase-sets/identity/server";
const allowedFence: AgentGrantRevocations["withActiveGrants"] = async (_account, _client, ids, work) =>
  ids.length ? work(ids) : null;

const now = () => new Date("2026-07-09T00:00:00.000Z");

function claimed(overrides: Partial<ClaimedAgentWebhookDelivery> = {}): ClaimedAgentWebhookDelivery {
  return {
    grantIds: ["grant_active"],
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
  it("agent-grant-revocation-downstream-fence awaits the original send even when releasing authority fails", async () => {
    const { outbox, sent } = fakeOutbox([claimed()]);
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const send = vi.fn(async () => {
      entered();
      await response;
      return { status: 200 };
    });
    let settled = false;
    const run = createAgentWebhookDispatcher({
      outbox,
      send,
      resolveSigningSecret: async () => "synthetic-secret",
      claimOwnerId: "worker_1",
      now,
      withActiveGrants: async (_account, _client, ids, work) => {
        await work(ids);
        throw new Error("synthetic-fence-release-failure");
      },
    })
      .runOnce()
      .then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    await started;
    // Drain the already-ready authority failure, not a wall-clock delay.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const prematurelySettled = settled;
    release();
    expect(await run).toBeInstanceOf(Error);
    expect(prematurelySettled).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });
  it("agent-grant-revocation-downstream-fence refuses a stale claimed row before send", async () => {
    const { outbox, failed } = fakeOutbox([claimed({ grantIds: ["grant_revoked"] })]);
    const send = vi.fn(async () => ({ status: 200 }));
    await createAgentWebhookDispatcher({
      outbox,
      send,
      resolveSigningSecret: async () => "synthetic-secret",
      withActiveGrants: async () => null,
      claimOwnerId: "worker_1",
      now,
    }).runOnce();
    expect(send).not.toHaveBeenCalled();
    expect(failed[0]).toMatchObject({ retryAt: null, error: "agent_grant_revoked" });
  });
  it("signs and delivers, marking a 2xx response sent", async () => {
    const { outbox, sent } = fakeOutbox([claimed()]);
    let seen: AgentWebhookSendRequest | null = null;
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      withActiveGrants: allowedFence,
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
      withActiveGrants: allowedFence,
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
      withActiveGrants: allowedFence,
      resolveSigningSecret: async () => "whsec_secret",
      send: async () => {
        throw new Error("connection reset");
      },
      claimOwnerId: "worker-1",
      now,
    });

    await dispatcher.runOnce();

    expect(failed[0].retryAt).toBeNull();
    expect(failed[0].error).toBe("delivery_outcome_unknown");
  });

  it("dead-letters immediately when the signing secret is gone", async () => {
    const { outbox, failed } = fakeOutbox([claimed()]);
    const send = vi.fn(async () => ({ status: 200 }));
    const dispatcher = createAgentWebhookDispatcher({
      outbox,
      withActiveGrants: allowedFence,
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
      withActiveGrants: allowedFence,
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
