import type { ReadConsistencyWakeRequest, ReadConsistencyWorkSignalGateway } from "@chase-sets/bounded-context-runtime";

import type { PostgresWorkSignalStore, WorkSignalPriorityLane } from "./work-signal-store";

export const DEFAULT_READ_CONSISTENCY_WAITER_TTL_SLACK_MS = 5_000;
export const READ_CONSISTENCY_WORK_SIGNAL_REQUESTED_BY = "read-consistency";

export type ReadConsistencyWorkSignalGatewayOptions = Readonly<{
  workSignalStore: Pick<PostgresWorkSignalStore, "enqueueProjectionWakeIntent" | "addCheckpointWaiter">;
  priorityLane?: WorkSignalPriorityLane;
  /**
   * Waiter rows currently have no API-side consumer (the read-consistency
   * middleware polls durable checkpoints). Registration stays off by default
   * until the readiness-notification wait path lands, so request traffic does
   * not write rows that influence nothing.
   */
  registerWaiters?: boolean;
  waiterTtlSlackMs?: number;
  now?: () => Date;
}>;

/**
 * Adapts the read-consistency middleware's wake-before-wait hooks onto the
 * durable control-plane work-signal store. API processes only write wake
 * intents and waiter rows through pooled queries; they never hold listener
 * connections, and the middleware's bounded durable poll remains the
 * unconditional freshness fallback.
 */
export function createWorkSignalReadConsistencyGateway(
  options: ReadConsistencyWorkSignalGatewayOptions,
): ReadConsistencyWorkSignalGateway {
  const priorityLane = options.priorityLane ?? "hot";
  const waiterTtlSlackMs = Math.max(
    0,
    Math.floor(options.waiterTtlSlackMs ?? DEFAULT_READ_CONSISTENCY_WAITER_TTL_SLACK_MS),
  );
  const now = options.now ?? (() => new Date());

  return {
    requestWake: async (input) => {
      let enqueuedCount = 0;
      for (const request of input.requests) {
        await options.workSignalStore.enqueueProjectionWakeIntent({
          ...wakeRequestTarget(request),
          requiredPosition: request.requiredPosition,
          priorityLane,
          origin: "api-wait",
          metadata: wakeRequestMetadata(input.metadata),
        });
        enqueuedCount += 1;
      }

      return enqueuedCount;
    },
    ...(options.registerWaiters
      ? {
          registerWaiters: async (
            input: Readonly<{
              requests: readonly ReadConsistencyWakeRequest[];
              timeoutMs: number;
              metadata?: Readonly<Record<string, unknown>>;
            }>,
          ) => {
            const expiresAt = new Date(now().getTime() + Math.max(0, input.timeoutMs) + waiterTtlSlackMs);
            for (const request of input.requests) {
              await options.workSignalStore.addCheckpointWaiter({
                ...wakeRequestTarget(request),
                requiredPosition: request.requiredPosition,
                origin: "api-wait",
                metadata: wakeRequestMetadata(input.metadata),
                expiresAt,
              });
            }
          },
        }
      : {}),
  };
}

function wakeRequestTarget(request: ReadConsistencyWakeRequest) {
  return {
    sourceContextName: request.sourceContextName,
    targetContextName: request.targetContextName,
    projectionName: request.projectionName,
    checkpointKey: request.checkpointKey,
  };
}

function wakeRequestMetadata(metadata: Readonly<Record<string, unknown>> | undefined) {
  return {
    requestedBy: READ_CONSISTENCY_WORK_SIGNAL_REQUESTED_BY,
    ...metadata,
  };
}
