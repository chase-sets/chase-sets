import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import type { ProjectorRunResult } from "@chase-sets/event-core/projector";
import type { AgentWebhookOutbox, ClaimedAgentWebhookDelivery } from "./agent-webhook-outbox";
import {
  AGENT_WEBHOOK_EVENT_TYPE_HEADER,
  AGENT_WEBHOOK_ID_HEADER,
  AGENT_WEBHOOK_SIGNATURE_HEADER,
  signAgentWebhookPayload,
} from "./webhook-signing";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CLAIM_TTL_MS = 60_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_CAP_MS = 6 * 60 * 60_000;

export type AgentWebhookSendRequest = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}>;

export type AgentWebhookSendResult = Readonly<{ status: number }>;

export type AgentWebhookSender = (request: AgentWebhookSendRequest) => Promise<AgentWebhookSendResult>;

export type AgentWebhookDispatcher = Readonly<{ runOnce: () => Promise<ProjectorRunResult> }>;

export type AgentWebhookDispatcherOptions = Readonly<{
  outbox: AgentWebhookOutbox;
  /** Plaintext signing secret for a client (never logged). */
  resolveSigningSecret: (clientId: string) => Promise<string | null>;
  send: AgentWebhookSender;
  claimOwnerId: string;
  batchSize?: number;
  claimTtlMs?: number;
  retryDelayMs?: (attemptCount: number) => number;
  now?: () => Date;
}>;

/** Exponential backoff (base·2^(n-1)) capped, ceilinged at six hours. */
export function defaultAgentWebhookRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(DEFAULT_RETRY_CAP_MS, DEFAULT_RETRY_BASE_MS * 2 ** exponent);
}

export function createAgentWebhookDispatcher(options: AgentWebhookDispatcherOptions): AgentWebhookDispatcher {
  const now = options.now ?? (() => new Date());
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const claimTtlMs = Math.max(1, options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS);
  const retryDelayMs = options.retryDelayMs ?? defaultAgentWebhookRetryDelayMs;

  return {
    async runOnce() {
      const deliveries = await options.outbox.claimPendingDeliveries({
        limit: batchSize,
        claimOwnerId: options.claimOwnerId,
        claimTtlMs,
        now: now().toISOString(),
      });

      for (const delivery of deliveries) {
        const renewed = await options.outbox.renewClaim({
          deliveryId: delivery.deliveryId,
          claimOwnerId: options.claimOwnerId,
          claimTtlMs,
          now: now().toISOString(),
        });
        if (!renewed) {
          continue;
        }
        await attemptDelivery(options, delivery, retryDelayMs, now);
      }

      return { processed: deliveries.length, lastGlobalPosition: ZERO_GLOBAL_POSITION };
    },
  };
}

async function attemptDelivery(
  options: AgentWebhookDispatcherOptions,
  delivery: ClaimedAgentWebhookDelivery,
  retryDelayMs: (attemptCount: number) => number,
  now: () => Date,
): Promise<void> {
  const signingSecret = await options.resolveSigningSecret(delivery.clientId);
  if (!signingSecret) {
    // The client withdrew (or never held) a webhook secret — retrying cannot
    // succeed, so dead-letter immediately for ops visibility.
    await options.outbox.markFailed({
      deliveryId: delivery.deliveryId,
      error: "signing secret unavailable for client",
      retryAt: null,
      now: now().toISOString(),
    });
    return;
  }

  const timestampSeconds = Math.floor(now().getTime() / 1000);
  const signature = signAgentWebhookPayload({
    signingSecret,
    body: delivery.payloadJson,
    timestampSeconds,
  });

  try {
    const result = await options.send({
      url: delivery.callbackUrl,
      headers: {
        "content-type": "application/json",
        [AGENT_WEBHOOK_SIGNATURE_HEADER]: signature.header,
        [AGENT_WEBHOOK_ID_HEADER]: delivery.deliveryId,
        [AGENT_WEBHOOK_EVENT_TYPE_HEADER]: delivery.eventType,
      },
      body: delivery.payloadJson,
    });

    if (result.status >= 200 && result.status < 300) {
      await options.outbox.markDelivered({
        deliveryId: delivery.deliveryId,
        responseStatus: result.status,
        now: now().toISOString(),
      });
      return;
    }

    await failDelivery(options, delivery, retryDelayMs, now, `callback responded ${result.status}`, result.status);
  } catch (error) {
    await failDelivery(options, delivery, retryDelayMs, now, describeError(error), null);
  }
}

async function failDelivery(
  options: AgentWebhookDispatcherOptions,
  delivery: ClaimedAgentWebhookDelivery,
  retryDelayMs: (attemptCount: number) => number,
  now: () => Date,
  error: string,
  responseStatus: number | null,
): Promise<void> {
  const canRetry = delivery.attemptCount < delivery.maxAttempts;
  await options.outbox.markFailed({
    deliveryId: delivery.deliveryId,
    error,
    responseStatus,
    retryAt: canRetry ? new Date(now().getTime() + retryDelayMs(delivery.attemptCount)).toISOString() : null,
    now: now().toISOString(),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Default HTTP sender: POST JSON, refuse redirects, bounded timeout. */
export function createFetchAgentWebhookSender(
  options: Readonly<{ timeoutMs?: number; fetchImpl?: typeof fetch }> = {},
): AgentWebhookSender {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(request.url, {
        method: "POST",
        headers: { ...request.headers },
        body: request.body,
        redirect: "error",
        signal: controller.signal,
      });
      return { status: response.status };
    } finally {
      clearTimeout(timer);
    }
  };
}
