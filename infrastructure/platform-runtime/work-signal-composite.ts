import type { PgPoolClient, PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";

export const WORK_SIGNAL_SCHEMA_VERSION = 1;
export const WORK_SIGNAL_PAYLOAD_VERSION = 1;
export const POSTGRES_WORK_SIGNAL_MAX_PAYLOAD_BYTES = 4 * 1024;

const WORK_SIGNAL_KINDS = [
  "event-store.commit",
  "projection.wake-intent",
  "projection.checkpoint-ready",
  "projection-operation.event",
  "durable-job.event",
  "realtime.outbox-wake",
  "scheduled-runner.due",
  "reconciliation.requested",
] as const;

export type WorkSignalKind = (typeof WORK_SIGNAL_KINDS)[number];

export type WorkSignalPayload = Record<string, unknown>;

export type WorkSignalEnvelope<TPayload extends WorkSignalPayload = WorkSignalPayload> = Readonly<{
  schemaVersion: typeof WORK_SIGNAL_SCHEMA_VERSION;
  payloadVersion: number;
  kind: WorkSignalKind;
  source: string;
  emittedAt: string;
  correlationId?: string;
  payload: TPayload;
}>;

export type CreateWorkSignalEnvelopeInput<TPayload extends WorkSignalPayload = WorkSignalPayload> = Readonly<{
  kind: WorkSignalKind;
  source: string;
  payload: TPayload;
  correlationId?: string | null;
  payloadVersion?: number;
}>;

export type EmitPostgresWorkSignalNotificationInput<TPayload extends WorkSignalPayload = WorkSignalPayload> = Readonly<{
  channel: string;
  envelope: CreateWorkSignalEnvelopeInput<TPayload> | WorkSignalEnvelope<TPayload>;
  maxPayloadBytes?: number;
  now?: () => Date;
  observer?: Pick<WorkSignalObserver, "notificationEmitted" | "payloadRejected">;
}>;

export type PostgresWorkSignalNotification = Readonly<{
  channel: string;
  payload?: string;
  envelope: WorkSignalEnvelope | null;
}>;

export type WorkSignalWaitResult = "notified" | "timeout" | "aborted" | "listener-unavailable";

export type WaitForPostgresWorkSignalInput = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
  matches: (notification: PostgresWorkSignalNotification) => boolean;
}>;

export type PostgresWorkSignalWaiter = Readonly<{
  wait: (input: WaitForPostgresWorkSignalInput) => Promise<WorkSignalWaitResult>;
  stop: () => Promise<void>;
}>;

export type WorkSignalObserver = Readonly<{
  notificationEmitted?: (event: WorkSignalNotificationEmittedEvent) => void;
  notificationReceived?: (event: WorkSignalNotificationReceivedEvent) => void;
  waitEnded?: (event: WorkSignalWaitEndedEvent) => void;
  listenerUnavailable?: (event: WorkSignalListenerUnavailableEvent) => void;
  payloadRejected?: (event: WorkSignalPayloadRejectedEvent) => void;
}>;

export type WorkSignalNotificationEmittedEvent = Readonly<{
  channel: string;
  kind: WorkSignalKind;
  payloadBytes: number;
  correlationId: string | null;
}>;

export type WorkSignalNotificationReceivedEvent = Readonly<{
  channel: string;
  kind: WorkSignalKind | "legacy" | "invalid";
  matchedWaiterCount: number;
  waiterCount: number;
}>;

export type WorkSignalWaitEndedEvent = Readonly<{
  channel: string;
  result: WorkSignalWaitResult;
}>;

export type WorkSignalListenerUnavailableEvent = Readonly<{
  channel: string;
  error: unknown;
}>;

export type WorkSignalPayloadRejectedEvent = Readonly<{
  channel: string;
  kind: WorkSignalKind;
  reason: string;
}>;

type PostgresNotificationClient = PgPoolClient &
  Readonly<{
    on?: (
      event: "notification" | "error",
      listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
    ) => unknown;
    off?: (
      event: "notification" | "error",
      listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
    ) => unknown;
    removeListener?: (
      event: "notification" | "error",
      listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
    ) => unknown;
  }>;

const POSTGRES_CHANNEL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// Aligned with the event-store and relay wake denylists (issue #1235): work
// signals are wake hints, so they must carry only opaque work identifiers,
// versions, and correlation metadata — never row-level identity keys.
const SENSITIVE_PAYLOAD_KEY_PATTERN =
  /(^|_|\b)(email|guestEmail|payment|card|pan|cvc|cvv|password|secret|privatePayload|providerPayload|eventPayload|rawPayload|payloadJson|phone|address|tenantId|userId|accountId|streamId|sessionId)(_|$|\b)/i;
const DEFAULT_WAIT_TIMEOUT_MS = 500;

export function createWorkSignalEnvelope<TPayload extends WorkSignalPayload>(
  input: CreateWorkSignalEnvelopeInput<TPayload>,
  options: Readonly<{ now?: () => Date }> = {},
): WorkSignalEnvelope<TPayload> {
  const payloadVersion = input.payloadVersion ?? WORK_SIGNAL_PAYLOAD_VERSION;
  if (!Number.isInteger(payloadVersion) || payloadVersion < 1) {
    throw new Error("Work signal payloadVersion must be a positive integer.");
  }

  if (!input.source.trim()) {
    throw new Error("Work signal source is required.");
  }

  return {
    schemaVersion: WORK_SIGNAL_SCHEMA_VERSION,
    payloadVersion,
    kind: input.kind,
    source: input.source,
    emittedAt: (options.now ?? (() => new Date()))().toISOString(),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    payload: input.payload,
  };
}

export async function emitPostgresWorkSignalNotification<TPayload extends WorkSignalPayload>(
  db: PgQueryable,
  input: EmitPostgresWorkSignalNotificationInput<TPayload>,
): Promise<void> {
  const channel = assertPostgresWorkSignalChannel(input.channel);
  const envelope = isWorkSignalEnvelope(input.envelope)
    ? input.envelope
    : createWorkSignalEnvelope(input.envelope, { now: input.now });
  let serialized: string;

  try {
    serialized = serializeWorkSignalEnvelope(envelope, {
      maxPayloadBytes: input.maxPayloadBytes,
    });
  } catch (error) {
    input.observer?.payloadRejected?.({
      channel,
      kind: envelope.kind,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  await db.query(`SELECT pg_notify($1, $2)`, [channel, serialized]);
  input.observer?.notificationEmitted?.({
    channel,
    kind: envelope.kind,
    payloadBytes: byteLengthUtf8(serialized),
    correlationId: envelope.correlationId ?? null,
  });
}

export function serializeWorkSignalEnvelope(
  envelope: WorkSignalEnvelope,
  options: Readonly<{ maxPayloadBytes?: number }> = {},
): string {
  assertSafeWorkSignalEnvelope(envelope);
  const serialized = JSON.stringify(envelope);
  const maxPayloadBytes = Math.max(1, Math.floor(options.maxPayloadBytes ?? POSTGRES_WORK_SIGNAL_MAX_PAYLOAD_BYTES));
  const payloadBytes = byteLengthUtf8(serialized);

  if (payloadBytes > maxPayloadBytes) {
    throw new Error(`Work signal payload is ${payloadBytes} bytes, which exceeds the ${maxPayloadBytes} byte limit.`);
  }

  return serialized;
}

export function parseWorkSignalEnvelope(payload: string | undefined): WorkSignalEnvelope | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isWorkSignalEnvelope(parsed)) {
      return null;
    }
    assertSafeWorkSignalEnvelope(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function createPostgresWorkSignalWaiter(
  db: PgTransactionalPool,
  input: Readonly<{
    channel: string;
    observer?: Pick<WorkSignalObserver, "listenerUnavailable" | "notificationReceived" | "waitEnded">;
    defaultTimeoutMs?: number;
  }>,
): PostgresWorkSignalWaiter {
  const channel = assertPostgresWorkSignalChannel(input.channel);
  const defaultTimeoutMs = Math.max(100, Math.floor(input.defaultTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
  const waiters = new Set<
    Readonly<{
      matches: WaitForPostgresWorkSignalInput["matches"];
      resolve: (result: WorkSignalWaitResult) => void;
    }>
  >();
  let clientPromise: Promise<PostgresNotificationClient> | null = null;
  let activeClient: PostgresNotificationClient | null = null;
  let activeErrorListener: (() => void) | null = null;
  let stopped = false;

  const removeListener = (
    client: PostgresNotificationClient,
    event: "notification" | "error",
    listener: (message?: Readonly<{ channel?: string; payload?: string }>) => void,
  ) => {
    if (client.off) {
      client.off(event, listener);
      return;
    }

    client.removeListener?.(event, listener);
  };

  const resetClient = (client: PostgresNotificationClient, onError: () => void) => {
    removeListener(client, "notification", onNotification);
    removeListener(client, "error", onError);
    clientPromise = null;
    if (activeClient === client) {
      activeClient = null;
      activeErrorListener = null;
    }
    client.release();
  };

  const onNotification = (message?: Readonly<{ channel?: string; payload?: string }>) => {
    if (message?.channel !== channel) {
      return;
    }

    const notification: PostgresWorkSignalNotification = {
      channel,
      payload: message.payload,
      envelope: parseWorkSignalEnvelope(message.payload),
    };
    const pending = [...waiters];
    let matchedWaiterCount = 0;

    for (const waiter of pending) {
      if (!waiter.matches(notification)) {
        continue;
      }
      matchedWaiterCount += 1;
      waiters.delete(waiter);
      waiter.resolve("notified");
    }

    input.observer?.notificationReceived?.({
      channel,
      kind: notification.envelope?.kind ?? (message.payload ? "legacy" : "invalid"),
      matchedWaiterCount,
      waiterCount: pending.length,
    });
  };

  async function getClient() {
    if (stopped) {
      throw new Error(`Work signal waiter for '${channel}' has been stopped.`);
    }

    clientPromise ??= (async () => {
      const client = (await db.connect()) as PostgresNotificationClient;
      const onError = () => resetClient(client, onError);
      activeClient = client;
      activeErrorListener = onError;
      client.on?.("error", onError);
      client.on?.("notification", onNotification);

      try {
        await client.query(`LISTEN ${channel}`);
      } catch (error) {
        removeListener(client, "notification", onNotification);
        resetClient(client, onError);
        throw error;
      }

      return client;
    })();

    return clientPromise;
  }

  return {
    wait: async (waitInput) => {
      const timeoutMs = Math.max(100, Math.floor(waitInput.timeoutMs ?? defaultTimeoutMs));
      if (waitInput.signal?.aborted) {
        const result = await waitForWorkSignalTimeout(timeoutMs, waitInput.signal);
        input.observer?.waitEnded?.({ channel, result });
        return result;
      }

      try {
        await getClient();
      } catch (error) {
        input.observer?.listenerUnavailable?.({ channel, error });
        const timeoutResult = await waitForWorkSignalTimeout(timeoutMs, waitInput.signal);
        const result = timeoutResult === "aborted" ? "aborted" : "listener-unavailable";
        input.observer?.waitEnded?.({ channel, result });
        return result;
      }

      const result = await new Promise<WorkSignalWaitResult>((resolve) => {
        let settled = false;
        let entry: Readonly<{
          matches: WaitForPostgresWorkSignalInput["matches"];
          resolve: (result: WorkSignalWaitResult) => void;
        }> | null = null;
        const done = (value: WorkSignalWaitResult) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (entry) {
            waiters.delete(entry);
          }
          waitInput.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        };
        entry = {
          matches: waitInput.matches,
          resolve: (value: WorkSignalWaitResult) => done(value),
        };
        const onAbort = () => done("aborted");
        const timer = setTimeout(() => done("timeout"), timeoutMs);
        timer.unref?.();

        waiters.add(entry);
        waitInput.signal?.addEventListener("abort", onAbort, { once: true });
      });
      input.observer?.waitEnded?.({ channel, result });
      return result;
    },
    stop: async () => {
      stopped = true;
      for (const waiter of [...waiters]) {
        waiters.delete(waiter);
        waiter.resolve("aborted");
      }

      const client = await clientPromise?.catch(() => null);
      clientPromise = null;
      if (!client) {
        return;
      }

      removeListener(client, "notification", onNotification);
      if (activeErrorListener) {
        removeListener(client, "error", activeErrorListener);
      }
      try {
        await client.query(`UNLISTEN ${channel}`);
      } finally {
        client.release();
        activeClient = null;
        activeErrorListener = null;
      }
    },
  };
}

export function assertPostgresWorkSignalChannel(channel: string): string {
  if (!POSTGRES_CHANNEL_PATTERN.test(channel)) {
    throw new Error(`Invalid Postgres work signal channel '${channel}'.`);
  }

  return channel;
}

function assertSafeWorkSignalEnvelope(envelope: WorkSignalEnvelope): void {
  if (envelope.schemaVersion !== WORK_SIGNAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported work signal schemaVersion '${String(envelope.schemaVersion)}'.`);
  }
  if (!Number.isInteger(envelope.payloadVersion) || envelope.payloadVersion < 1) {
    throw new Error("Work signal payloadVersion must be a positive integer.");
  }
  if (!isWorkSignalKind(envelope.kind)) {
    throw new Error(`Unsupported work signal kind '${String(envelope.kind)}'.`);
  }
  if (!envelope.source.trim()) {
    throw new Error("Work signal source is required.");
  }
  if (!envelope.emittedAt || Number.isNaN(new Date(envelope.emittedAt).getTime())) {
    throw new Error("Work signal emittedAt must be an ISO timestamp.");
  }
  assertSafePayloadRecord(envelope.payload, "payload");
}

function assertSafePayloadRecord(value: unknown, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Work signal ${path} must be a JSON object.`);
  }

  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (SENSITIVE_PAYLOAD_KEY_PATTERN.test(key)) {
      throw new Error(`Work signal ${nestedPath} uses a sensitive payload key.`);
    }

    if (nested && typeof nested === "object") {
      if (Array.isArray(nested)) {
        for (let index = 0; index < nested.length; index += 1) {
          const item = nested[index];
          if (item && typeof item === "object") {
            assertSafePayloadRecord(item, `${nestedPath}[${index}]`);
          }
        }
        continue;
      }

      assertSafePayloadRecord(nested, nestedPath);
    }
  }
}

function isWorkSignalEnvelope(value: unknown): value is WorkSignalEnvelope {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === WORK_SIGNAL_SCHEMA_VERSION &&
    typeof (value as { payloadVersion?: unknown }).payloadVersion === "number" &&
    isWorkSignalKind((value as { kind?: unknown }).kind) &&
    typeof (value as { source?: unknown }).source === "string" &&
    typeof (value as { emittedAt?: unknown }).emittedAt === "string" &&
    Boolean((value as { payload?: unknown }).payload) &&
    typeof (value as { payload?: unknown }).payload === "object" &&
    !Array.isArray((value as { payload?: unknown }).payload)
  );
}

function isWorkSignalKind(value: unknown): value is WorkSignalKind {
  return typeof value === "string" && WORK_SIGNAL_KINDS.includes(value as WorkSignalKind);
}

function waitForWorkSignalTimeout(
  ms: number,
  signal?: AbortSignal,
): Promise<Exclude<WorkSignalWaitResult, "notified">> {
  if (signal?.aborted) {
    return Promise.resolve("aborted");
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve("aborted");
      },
      { once: true },
    );
  });
}

function byteLengthUtf8(value: string): number {
  return typeof Buffer !== "undefined" ? Buffer.byteLength(value, "utf8") : new TextEncoder().encode(value).length;
}
