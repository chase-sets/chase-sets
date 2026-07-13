export type MockStoredEvent = Readonly<{
  eventId: string;
  globalPosition: string;
  streamId: string;
  streamVersion: number;
  eventType: string;
  payload: unknown;
  recordedAt: string;
  tenantId: string;
  performedByUserId: string;
  forAccountId: string;
}>;

export type MockPool = {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>;
  connect: () => Promise<MockPoolClient>;
};

export type MockPoolClient = {
  query: MockPool["query"];
  release: () => void;
};

export const sourceEventsByPool = new Map<object, MockStoredEvent[]>();
export const checkpointsByPool = new Map<object, Map<string, string>>();
export const checkpointWriteCountsByPool = new Map<object, Map<string, number>>();
export const projectionRevisionsByPool = new Map<object, Map<string, number>>();
export const truncatedTablesByPool = new Map<object, string[][]>();
export const blockedStreamsByPool = new Map<object, Map<string, MockBlockedStream>>();
export const poisonEventsByPool = new Map<object, Set<string>>();
export const applicationStatusByPool = new Map<object, Map<string, string>>();
// Test override for `loadSubscriptionApplicationAgeMs` (ms an application row has
// been stuck since first claim). Keyed by `${projectionKey}:${eventId}`; unset = 0.
export const applicationAgeMsByPool = new Map<object, Map<string, number>>();
export const cascadeProgressByPool = new Map<object, Map<string, { cursorId: string | null; completed: boolean }>>();
export const readAllCallsByPool = new Map<object, Record<string, unknown>[]>();
export const sourceHeadByPool = new Map<object, string>();
export const generationRetentionByPool = new Map<object, Set<string>>();

export type MockBlockedStream = Readonly<{
  projectionKey: string;
  streamId: string;
  firstBlockedGlobalPosition: string;
  firstBlockedStreamVersion: number;
  lastSeenGlobalPosition: string;
  deferredEventCount: number;
  state: "blocked" | "retrying" | "resolved";
}>;

export function getCheckpointStore(pool: object) {
  let store = checkpointsByPool.get(pool);
  if (!store) {
    store = new Map();
    checkpointsByPool.set(pool, store);
  }

  return store;
}

export function getProjectionRevisionStore(pool: object) {
  let store = projectionRevisionsByPool.get(pool);
  if (!store) {
    store = new Map();
    projectionRevisionsByPool.set(pool, store);
  }

  return store;
}

export function getCheckpointWriteCountStore(pool: object) {
  let store = checkpointWriteCountsByPool.get(pool);
  if (!store) {
    store = new Map();
    checkpointWriteCountsByPool.set(pool, store);
  }

  return store;
}

export function getTruncateLog(pool: object) {
  let log = truncatedTablesByPool.get(pool);
  if (!log) {
    log = [];
    truncatedTablesByPool.set(pool, log);
  }

  return log;
}

export function getBlockedStreamStore(pool: object) {
  let store = blockedStreamsByPool.get(pool);
  if (!store) {
    store = new Map();
    blockedStreamsByPool.set(pool, store);
  }

  return store;
}

export function getPoisonEventStore(pool: object) {
  let store = poisonEventsByPool.get(pool);
  if (!store) {
    store = new Set();
    poisonEventsByPool.set(pool, store);
  }

  return store;
}

export function getApplicationStatusStore(pool: object) {
  let store = applicationStatusByPool.get(pool);
  if (!store) {
    store = new Map();
    applicationStatusByPool.set(pool, store);
  }

  return store;
}

export function getApplicationAgeStore(pool: object) {
  let store = applicationAgeMsByPool.get(pool);
  if (!store) {
    store = new Map();
    applicationAgeMsByPool.set(pool, store);
  }

  return store;
}

export function getCascadeProgressStore(pool: object) {
  let store = cascadeProgressByPool.get(pool);
  if (!store) {
    store = new Map();
    cascadeProgressByPool.set(pool, store);
  }

  return store;
}

export function getGenerationRetentionStore(pool: object) {
  let store = generationRetentionByPool.get(pool);
  if (!store) {
    store = new Set();
    generationRetentionByPool.set(pool, store);
  }

  return store;
}

export function getReadAllCalls(pool: object) {
  let calls = readAllCallsByPool.get(pool);
  if (!calls) {
    calls = [];
    readAllCallsByPool.set(pool, calls);
  }

  return calls;
}

export function createMockPool(): MockPool {
  const pool = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql === "SELECT set_config('statement_timeout', $1, true)") {
        return { rows: [], rowCount: 0 };
      }
      if (sql === "SELECT set_config('idle_in_transaction_session_timeout', $1, true)") {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("pg_sequence_last_value")) {
        const configuredHead = sourceHeadByPool.get(pool);
        if (configuredHead) {
          return { rows: [{ head: configuredHead }] };
        }

        const events = sourceEventsByPool.get(pool) ?? [];
        const head = events.reduce(
          (current, event) => (Number(event.globalPosition) > Number(current) ? event.globalPosition : current),
          "0",
        );
        return { rows: [{ head }] };
      }

      if (sql.includes("SELECT COUNT(*) AS count") && sql.includes("FROM event_store_events")) {
        const afterGlobalPosition = Number(params[0] ?? 0);
        const eventTypes = Array.isArray(params[1]) ? params[1].map(String) : [];
        const events = sourceEventsByPool.get(pool) ?? [];
        const count = events.filter(
          (event) =>
            Number(event.globalPosition) > afterGlobalPosition &&
            (eventTypes.length === 0 || eventTypes.includes(event.eventType)),
        ).length;
        return { rows: [{ count: String(count) }] };
      }

      if (sql.includes("COUNT(*) FILTER") && sql.includes("FROM event_subscription_applications")) {
        const projectionKey = String(params[0]);
        const rows = [...getApplicationStatusStore(pool)].filter(([key]) => key.startsWith(`${projectionKey}:`));
        return {
          rows: [
            {
              applied_rows: rows.filter(([, status]) => status === "applied").length,
              started_rows: rows.filter(([, status]) => status === "started").length,
              poison_rows: rows.filter(([, status]) => status === "poison").length,
              transient_rows: rows.filter(([, status]) => status === "transient").length,
              oldest_started_at: null,
            },
          ],
        };
      }

      if (sql.includes("recovery_global_position") && sql.includes("event_projection_recovery_markers")) {
        const checkpointKey = String(params[0]);
        const value = getCheckpointStore(pool).get(checkpointKey);
        return {
          rows: value ? [{ last_global_position: value, recovery_global_position: value }] : [],
        };
      }

      if (sql.includes("SELECT last_global_position")) {
        const checkpointKey = String(params[0]);
        const value = getCheckpointStore(pool).get(checkpointKey);
        return {
          rows: value ? [{ last_global_position: value }] : [],
        };
      }

      if (
        sql.includes("SELECT") &&
        sql.includes("FROM event_projection_blocked_streams") &&
        sql.includes("FROM event_projection_poison_events")
      ) {
        const projectionKey = String(params[0]);
        const blockedStreamCount = [...getBlockedStreamStore(pool).values()].filter(
          (stream) => stream.projectionKey === projectionKey && stream.state !== "resolved",
        ).length;
        const poisonEventCount = [...getPoisonEventStore(pool)].filter((key) =>
          key.startsWith(`${projectionKey}:`),
        ).length;

        return {
          rows: [
            {
              blocked_stream_count: blockedStreamCount,
              poison_event_count: poisonEventCount,
            },
          ],
        };
      }

      if (sql.includes("FROM event_projection_blocked_streams") && sql.includes("WHERE projection_key = $1")) {
        if (Array.isArray(params[1])) {
          const projectionKey = String(params[0]);
          const streamIds = params[1].map(String);
          return {
            rows: streamIds.flatMap((streamId) => {
              const blockedStream = getBlockedStreamStore(pool).get(`${projectionKey}:${streamId}`);
              return blockedStream && blockedStream.state !== "resolved"
                ? [
                    {
                      projection_key: blockedStream.projectionKey,
                      stream_id: blockedStream.streamId,
                      first_blocked_global_position: blockedStream.firstBlockedGlobalPosition,
                      first_blocked_stream_version: blockedStream.firstBlockedStreamVersion,
                      last_seen_global_position: blockedStream.lastSeenGlobalPosition,
                      deferred_event_count: blockedStream.deferredEventCount,
                      state: blockedStream.state,
                    },
                  ]
                : [];
            }),
          };
        }

        const key = `${String(params[0])}:${String(params[1])}`;
        const blockedStream = getBlockedStreamStore(pool).get(key);
        return {
          rows:
            blockedStream && blockedStream.state !== "resolved"
              ? [
                  {
                    projection_key: blockedStream.projectionKey,
                    stream_id: blockedStream.streamId,
                    first_blocked_global_position: blockedStream.firstBlockedGlobalPosition,
                    first_blocked_stream_version: blockedStream.firstBlockedStreamVersion,
                    last_seen_global_position: blockedStream.lastSeenGlobalPosition,
                    deferred_event_count: blockedStream.deferredEventCount,
                    state: blockedStream.state,
                  },
                ]
              : [],
        };
      }

      if (sql.includes("SELECT projection_revision")) {
        const key = `${params[0]}:${params[1]}`;
        const value = getProjectionRevisionStore(pool).get(key);
        return {
          rows: value ? [{ projection_revision: value }] : [],
        };
      }

      if (sql.includes("SELECT event_id, status") && sql.includes("FROM event_subscription_applications")) {
        const projectionKey = String(params[0]);
        const eventIds = Array.isArray(params[1]) ? params[1].map(String) : [];
        return {
          rows: eventIds.flatMap((eventId) => {
            const status = getApplicationStatusStore(pool).get(`${projectionKey}:${eventId}`);
            return status ? [{ event_id: eventId, status }] : [];
          }),
        };
      }

      if (sql.includes("age_ms") && sql.includes("FROM event_subscription_applications")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        if (!getApplicationStatusStore(pool).has(key)) {
          return { rows: [] };
        }
        return { rows: [{ age_ms: getApplicationAgeStore(pool).get(key) ?? 0 }] };
      }

      if (sql.includes("SELECT") && sql.includes("FROM event_subscription_applications")) {
        const key = `${String(params[0])}:${String(params[1])}`;
        const status = getApplicationStatusStore(pool).get(key);
        return {
          rows: status ? [{ status }] : [],
        };
      }

      if (sql.includes("INSERT INTO event_subscription_applications")) {
        if (Array.isArray(params[1])) {
          const projectionKey = String(params[0]);
          for (const eventId of params[1].map(String)) {
            const key = `${projectionKey}:${eventId}`;
            const existing = getApplicationStatusStore(pool).get(key);
            getApplicationStatusStore(pool).set(key, existing === "applied" ? existing : "started");
          }
          return { rows: [], rowCount: 0 } as never;
        }

        const key = `${String(params[0])}:${String(params[1])}`;
        const existing = getApplicationStatusStore(pool).get(key);
        getApplicationStatusStore(pool).set(key, existing === "applied" ? existing : "started");
        return { rows: [] };
      }

      if (sql.includes("UPDATE event_subscription_applications")) {
        if (Array.isArray(params[1])) {
          const projectionKey = String(params[0]);
          const status = sql.includes("status = 'started'")
            ? "started"
            : sql.includes("status = 'applied'")
              ? "applied"
              : String(params[2]);
          for (const eventId of params[1].map(String)) {
            getApplicationStatusStore(pool).set(`${projectionKey}:${eventId}`, status);
          }
          return { rows: [], rowCount: params[1].length } as never;
        }

        const key = `${String(params[0])}:${String(params[1])}`;
        getApplicationStatusStore(pool).set(key, String(params[2]));
        return { rows: [], rowCount: 1 } as never;
      }

      if (sql.includes("INSERT INTO event_subscription_checkpoints")) {
        const checkpointKey = String(params[0]);
        const lastGlobalPosition = String(params[4]);
        const store = getCheckpointStore(pool);
        const previous = store.get(checkpointKey) ?? "0";
        store.set(checkpointKey, Number(lastGlobalPosition) > Number(previous) ? lastGlobalPosition : previous);
        getCheckpointWriteCountStore(pool).set(
          checkpointKey,
          (getCheckpointWriteCountStore(pool).get(checkpointKey) ?? 0) + 1,
        );
        return { rows: [] };
      }

      if (sql.includes("event_projection_cascade_progress")) {
        if (sql.includes("SELECT cursor_id, completed")) {
          const key = `${String(params[0])}:${String(params[1])}:${String(params[2])}`;
          const row = getCascadeProgressStore(pool).get(key);
          return { rows: row ? [{ cursor_id: row.cursorId, completed: row.completed }] : [] };
        }
        if (sql.includes("INSERT INTO event_projection_cascade_progress")) {
          const key = `${String(params[0])}:${String(params[1])}:${String(params[2])}`;
          getCascadeProgressStore(pool).set(key, {
            cursorId: params[3] === null || params[3] === undefined ? null : String(params[3]),
            completed: Boolean(params[4]),
          });
          return { rows: [], rowCount: 1 } as never;
        }
        if (sql.includes("DELETE FROM event_projection_cascade_progress")) {
          const projectionKey = String(params[0]);
          const eventId = params[1] === undefined ? null : String(params[1]);
          const prefix = eventId === null ? `${projectionKey}:` : `${projectionKey}:${eventId}:`;
          for (const key of [...getCascadeProgressStore(pool).keys()]) {
            if (key.startsWith(prefix)) {
              getCascadeProgressStore(pool).delete(key);
            }
          }
          return { rows: [], rowCount: 0 } as never;
        }
      }

      if (sql.includes("INSERT INTO event_projection_group_revisions")) {
        const key = `${params[0]}:${params[1]}`;
        getProjectionRevisionStore(pool).set(key, Number(params[2]));
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_group_generations")) {
        const key = `${params[0]}:${params[1]}`;
        if (sql.includes("state = 'active'")) {
          getGenerationRetentionStore(pool).add(key);
        }
        if (sql.includes("state = 'failed'")) {
          getGenerationRetentionStore(pool).delete(key);
        }
        return { rows: [], rowCount: 1 } as never;
      }

      if (sql.includes("UPDATE event_projection_group_generations")) {
        const cleaned = getGenerationRetentionStore(pool).size;
        getGenerationRetentionStore(pool).clear();
        return { rows: [], rowCount: cleaned } as never;
      }

      if (sql.includes("DELETE FROM event_subscription_checkpoints")) {
        getCheckpointStore(pool).delete(String(params[0]));
        return { rows: [] };
      }

      if (sql.includes("DELETE FROM event_projection_recovery_markers")) {
        return { rows: [] };
      }

      if (sql.includes("DELETE FROM event_subscription_applications")) {
        const projectionKey = String(params[0]);
        if (sql.includes("status = 'applied'")) {
          const compactThrough = Number(params[1]);
          for (const [key, status] of [...getApplicationStatusStore(pool)]) {
            if (!key.startsWith(`${projectionKey}:`) || status !== "applied") {
              continue;
            }

            const eventId = key.slice(`${projectionKey}:`.length);
            const event = [...sourceEventsByPool.values()].flat().find((candidate) => candidate.eventId === eventId);
            if (event && Number(event.globalPosition) <= compactThrough) {
              getApplicationStatusStore(pool).delete(key);
            }
          }
          return { rows: [] };
        }

        for (const key of [...getApplicationStatusStore(pool).keys()]) {
          if (key.startsWith(`${projectionKey}:`)) {
            getApplicationStatusStore(pool).delete(key);
          }
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE event_projection_blocked_streams")) {
        const projectionKey = String(params[0]);
        const streamId = params[1] ? String(params[1]) : null;
        const nextState = sql.includes("state = 'retrying'")
          ? "retrying"
          : sql.includes("state = 'blocked'")
            ? "blocked"
            : "resolved";
        for (const [key, stream] of getBlockedStreamStore(pool)) {
          if (stream.projectionKey === projectionKey && (!streamId || stream.streamId === streamId)) {
            getBlockedStreamStore(pool).set(key, { ...stream, state: nextState });
          }
        }
        return { rows: [] };
      }

      if (sql.includes("UPDATE event_projection_poison_events")) {
        if (!sql.includes("state = 'resolved'")) {
          return { rows: [] };
        }

        const projectionKey = String(params[0]);
        for (const key of [...getPoisonEventStore(pool)]) {
          if (key.startsWith(`${projectionKey}:`)) {
            getPoisonEventStore(pool).delete(key);
          }
        }
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_poison_events")) {
        getPoisonEventStore(pool).add(`${String(params[0])}:${String(params[1])}`);
        return { rows: [] };
      }

      if (sql.includes("INSERT INTO event_projection_blocked_streams")) {
        const projectionKey = String(params[0]);
        const streamId = String(params[1]);
        const key = `${projectionKey}:${streamId}`;
        const existing = getBlockedStreamStore(pool).get(key);
        getBlockedStreamStore(pool).set(key, {
          projectionKey,
          streamId,
          firstBlockedGlobalPosition: existing?.firstBlockedGlobalPosition ?? String(params[2]),
          firstBlockedStreamVersion: existing?.firstBlockedStreamVersion ?? Number(params[3]),
          lastSeenGlobalPosition: String(params[2]),
          deferredEventCount: existing ? existing.deferredEventCount + 1 : 0,
          state: "blocked",
        });
        return { rows: [] };
      }

      if (sql.startsWith("TRUNCATE TABLE ")) {
        const tables = sql
          .replace("TRUNCATE TABLE ", "")
          .replace(" RESTART IDENTITY CASCADE", "")
          .split(",")
          .map((tableName) => tableName.trim());
        getTruncateLog(pool).push(tables);
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL in test double: ${sql}`);
    },
    connect: async () => ({
      query: pool.query,
      release: () => undefined,
    }),
  };

  return pool;
}

export function createEventCoreMock() {
  return {
    ZERO_GLOBAL_POSITION: "0",
    isTransientProjectionError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { projectionFailureKind?: unknown }).projectionFailureKind === "transient",
      ),
    createProjectionTransactionBudgetExceededError: (message: string, options?: ErrorOptions) => {
      const error = new Error(message, options) as Error & {
        projectionFailureKind: string;
        projectionTransactionBudgetExceeded: boolean;
      };
      error.projectionFailureKind = "transient";
      error.projectionTransactionBudgetExceeded = true;
      return error;
    },
    isProjectionTransactionBudgetExceededError: (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { projectionTransactionBudgetExceeded?: unknown }).projectionTransactionBudgetExceeded === true,
      ),
    toTransportEvent: (storedEvent: MockStoredEvent) => ({
      id: storedEvent.eventId,
      type: storedEvent.eventType,
      data: storedEvent.payload,
      streamId: storedEvent.streamId,
      streamVersion: storedEvent.streamVersion,
      globalPosition: storedEvent.globalPosition,
      tenantId: storedEvent.tenantId,
      audit: {
        performedByUserId: storedEvent.performedByUserId,
        forAccountId: storedEvent.forAccountId,
      },
      timing: {
        recordedAt: storedEvent.recordedAt,
      },
    }),
  };
}

export function createEventCorePostgresMock() {
  return {
    withPgTransaction: async (_pool: object, work: (client: object) => Promise<unknown>) => work(_pool),
    readGapSafeEventStoreHead: async (pool: MockPool) => {
      const result = await pool.query("SELECT pg_sequence_last_value('event_store_events') AS head");
      return String(result.rows[0]?.head ?? "0");
    },
    runInProjectionCascadeContext: <T>(_controller: unknown, work: () => T): T => work(),
    getProjectionCascadeController: () => undefined,
    runBoundedProjectionCascade: async (
      ids: readonly string[],
      processSlice: (ids: readonly string[]) => Promise<void>,
    ) => {
      const unique = [...new Set(ids)];
      if (unique.length > 0) {
        await processSlice(unique);
      }
    },
    isPgConnectionLevelError: (error: unknown) => {
      if (typeof error !== "object" || error === null) {
        return false;
      }
      const candidate = error as { code?: unknown };
      const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
      return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "08000", "08001", "08003"].includes(
        code,
      );
    },
    isPgRetryableTransientError: (error: unknown) => {
      if (typeof error !== "object" || error === null) {
        return false;
      }
      const candidate = error as { code?: unknown; message?: unknown };
      const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
      if (["40001", "40P01", "55P03", "57014", "ECONNRESET"].includes(code)) {
        return true;
      }
      return typeof candidate.message === "string" && candidate.message.toLowerCase().includes("connection terminated");
    },
    createPostgresEventStore: ({ pool }: { pool: object }) => ({
      readAll: async ({
        afterGlobalPosition,
        limit,
        eventTypes,
        streamPrefixes,
      }: {
        afterGlobalPosition: string;
        limit: number;
        eventTypes?: readonly string[];
        streamPrefixes?: readonly string[];
      }) => {
        getReadAllCalls(pool).push({
          afterGlobalPosition,
          limit,
          eventTypes: eventTypes ? [...eventTypes] : undefined,
          streamPrefixes: streamPrefixes ? [...streamPrefixes] : undefined,
        });

        return (sourceEventsByPool.get(pool) ?? [])
          .filter((event) => Number(event.globalPosition) > Number(afterGlobalPosition))
          .filter((event) => !eventTypes?.length || eventTypes.includes(event.eventType))
          .filter(
            (event) => !streamPrefixes?.length || streamPrefixes.some((prefix) => event.streamId.startsWith(prefix)),
          )
          .slice(0, limit);
      },
      readStream: async ({
        streamId,
        fromVersion = 1,
        limit = 500,
      }: {
        streamId: string;
        fromVersion?: number;
        limit?: number;
      }) =>
        (sourceEventsByPool.get(pool) ?? [])
          .filter((event) => event.streamId === streamId && event.streamVersion >= fromVersion)
          .slice(0, limit),
    }),
    createPostgresProjectionStore: ({ db }: { db: object }) => ({
      listBlockedStreams: async (projectionKey: string) =>
        [...getBlockedStreamStore(db).values()].filter(
          (stream) => stream.projectionKey === projectionKey && stream.state !== "resolved",
        ),
      listPoisonEvents: async () => [],
    }),
    eventCorePostgresSchemaSql: "",
    eventStoreEventsReadIndexStatements: [],
  };
}

export function resetMockPoolState() {
  sourceEventsByPool.clear();
  checkpointsByPool.clear();
  projectionRevisionsByPool.clear();
  checkpointWriteCountsByPool.clear();
  truncatedTablesByPool.clear();
  blockedStreamsByPool.clear();
  poisonEventsByPool.clear();
  applicationStatusByPool.clear();
  applicationAgeMsByPool.clear();
  cascadeProgressByPool.clear();
  readAllCallsByPool.clear();
  sourceHeadByPool.clear();
  generationRetentionByPool.clear();
}

export function createStoredEvent(
  globalPosition: string,
  eventType: string,
  payload: Record<string, unknown>,
  streamId = `${eventType}-${globalPosition}`,
): MockStoredEvent {
  return {
    eventId: `evt_${globalPosition}`,
    globalPosition,
    streamId,
    streamVersion: Number(globalPosition),
    eventType,
    payload,
    recordedAt: `2026-04-06T00:0${globalPosition}:00.000Z`,
    tenantId: "tnt_test",
    performedByUserId: "usr_test",
    forAccountId: "acc_test",
  };
}
