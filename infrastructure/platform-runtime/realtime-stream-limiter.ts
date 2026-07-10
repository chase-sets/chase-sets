export type RealtimeStreamLease = Readonly<{
  activeConnectionCount: number;
  renew?: () => Promise<boolean>;
  release: () => void | Promise<void>;
}>;

export type RealtimeStreamLimitRequest = Readonly<{
  connectionKey: string;
  maxActiveStreams: number;
  maxActiveStreamsPerConnectionKey: number;
}>;

export type RealtimeStreamLimiter = Readonly<{
  acquire: (request: RealtimeStreamLimitRequest) => Promise<RealtimeStreamLease | null>;
  activeConnectionCount?: () => number;
}>;

export type PostgresRealtimeStreamLimiterPool = Readonly<{
  connect: () => Promise<{
    query: <Row = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
    release: () => void;
  }>;
  query: <Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: readonly Row[]; rowCount?: number | null }>;
}>;

export type RedisRealtimeStreamLimiterClient = Readonly<{
  eval: (
    script: string,
    options: Readonly<{
      keys: readonly string[];
      arguments: readonly string[];
    }>,
  ) => Promise<number | string>;
}>;

export function createInMemoryRealtimeStreamLimiter(): RealtimeStreamLimiter {
  let activeStreamCount = 0;
  const activeStreamsByConnectionKey = new Map<string, number>();

  return {
    activeConnectionCount: () => activeStreamCount,
    acquire: async (request) => {
      const activeForConnectionKey = activeStreamsByConnectionKey.get(request.connectionKey) ?? 0;
      if (
        activeStreamCount >= request.maxActiveStreams ||
        activeForConnectionKey >= request.maxActiveStreamsPerConnectionKey
      ) {
        return null;
      }

      activeStreamCount += 1;
      activeStreamsByConnectionKey.set(request.connectionKey, activeForConnectionKey + 1);
      let released = false;
      return {
        activeConnectionCount: activeStreamCount,
        release: () => {
          if (released) {
            return;
          }

          released = true;
          activeStreamCount = Math.max(0, activeStreamCount - 1);
          const nextActiveForConnectionKey = Math.max(
            0,
            (activeStreamsByConnectionKey.get(request.connectionKey) ?? 1) - 1,
          );
          if (nextActiveForConnectionKey === 0) {
            activeStreamsByConnectionKey.delete(request.connectionKey);
          } else {
            activeStreamsByConnectionKey.set(request.connectionKey, nextActiveForConnectionKey);
          }
        },
      };
    },
  };
}

export function createPostgresRealtimeStreamLimiter(
  options: Readonly<{
    pool: PostgresRealtimeStreamLimiterPool;
    leaseTtlMs?: number;
    renewIntervalMs?: number;
    cleanupIntervalMs?: number;
    onRenewalError?: (error: unknown) => void;
  }>,
): RealtimeStreamLimiter {
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const renewIntervalMs = options.renewIntervalMs ?? 10_000;
  void options.cleanupIntervalMs;

  return {
    activeConnectionCount: () => 0,
    acquire: async (request) => {
      const leaseId = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      const client = await options.pool.connect();
      const globalCounterKey = "global";
      const connectionCounterKey = realtimeStreamConnectionCounterKey(request.connectionKey);

      try {
        await client.query("BEGIN");
        await cleanupExpiredRealtimeStreamLeases(client);
        await client.query(
          `INSERT INTO platform_realtime_stream_counters (counter_key, active_count, updated_at)
           VALUES ($1, 0, now()), ($2, 0, now())
           ON CONFLICT (counter_key) DO NOTHING`,
          [globalCounterKey, connectionCounterKey],
        );
        const countResult = await client.query<{
          counter_key: string;
          active_count: string | number;
        }>(
          `SELECT counter_key, active_count
           FROM platform_realtime_stream_counters
           WHERE counter_key = ANY($1::text[])
           ORDER BY counter_key
           FOR UPDATE`,
          [[globalCounterKey, connectionCounterKey]],
        );
        const counts = new Map(countResult.rows.map((row) => [row.counter_key, Number(row.active_count)]));
        const activeCount = counts.get(globalCounterKey) ?? 0;
        const connectionCount = counts.get(connectionCounterKey) ?? 0;

        if (activeCount >= request.maxActiveStreams || connectionCount >= request.maxActiveStreamsPerConnectionKey) {
          await client.query("ROLLBACK");
          return null;
        }

        await client.query(
          `INSERT INTO platform_realtime_stream_leases (
             lease_id,
             connection_key,
             expires_at,
             acquired_at
           ) VALUES (
             $1,
             $2,
             now() + ($3::text || ' milliseconds')::interval,
             now()
          )`,
          [leaseId, request.connectionKey, leaseTtlMs],
        );
        await client.query(
          `UPDATE platform_realtime_stream_counters
           SET active_count = active_count + 1,
               updated_at = now()
           WHERE counter_key = ANY($1::text[])`,
          [[globalCounterKey, connectionCounterKey]],
        );
        await client.query("COMMIT");

        let released = false;
        const renew = async () => {
          if (released) {
            return false;
          }

          const result = await options.pool.query(
            `UPDATE platform_realtime_stream_leases
             SET expires_at = now() + ($2::text || ' milliseconds')::interval
             WHERE lease_id = $1
               AND expires_at > now()`,
            [leaseId, leaseTtlMs],
          );
          return (result.rowCount ?? 0) > 0;
        };
        const renewalTimer = setInterval(() => {
          observeLeaseRenewal(renew(), options.onRenewalError);
        }, renewIntervalMs);
        renewalTimer.unref?.();

        return {
          activeConnectionCount: activeCount + 1,
          renew,
          release: async () => {
            if (released) {
              return;
            }

            released = true;
            clearInterval(renewalTimer);
            await options.pool.query(
              `WITH removed AS (
                 DELETE FROM platform_realtime_stream_leases
                 WHERE lease_id = $1
                 RETURNING connection_key
               ),
               decrement_keys AS (
                 SELECT 'global'::text AS counter_key
                 FROM removed
                 UNION ALL
                 SELECT 'connection:' || connection_key
                 FROM removed
               )
               UPDATE platform_realtime_stream_counters AS counter
               SET active_count = GREATEST(0, counter.active_count - 1),
                   updated_at = now()
               WHERE counter.counter_key IN (SELECT counter_key FROM decrement_keys)`,
              [leaseId],
            );
          },
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function cleanupExpiredRealtimeStreamLeases(
  client: Awaited<ReturnType<PostgresRealtimeStreamLimiterPool["connect"]>>,
) {
  await client.query(
    `WITH expired AS (
       DELETE FROM platform_realtime_stream_leases
       WHERE expires_at <= now()
       RETURNING connection_key
     ),
     expired_total AS (
       SELECT COUNT(*)::integer AS active_count
       FROM expired
     ),
     expired_by_key AS (
       SELECT 'connection:' || connection_key AS counter_key,
              COUNT(*)::integer AS active_count
       FROM expired
       GROUP BY connection_key
     ),
     decrement_global AS (
       UPDATE platform_realtime_stream_counters AS counter
       SET active_count = GREATEST(0, counter.active_count - expired_total.active_count),
           updated_at = now()
       FROM expired_total
       WHERE counter.counter_key = 'global'
         AND expired_total.active_count > 0
     )
     UPDATE platform_realtime_stream_counters AS counter
     SET active_count = GREATEST(0, counter.active_count - expired_by_key.active_count),
         updated_at = now()
     FROM expired_by_key
     WHERE counter.counter_key = expired_by_key.counter_key`,
  );
}

function realtimeStreamConnectionCounterKey(connectionKey: string): string {
  return `connection:${connectionKey}`;
}

export function createRedisRealtimeStreamLimiter(
  options: Readonly<{
    client: RedisRealtimeStreamLimiterClient;
    namespace?: string;
    leaseTtlSeconds?: number;
    renewIntervalMs?: number;
    onRenewalError?: (error: unknown) => void;
  }>,
): RealtimeStreamLimiter {
  const namespace = options.namespace ?? "chase_sets:realtime:streams";
  const leaseTtlSeconds = options.leaseTtlSeconds ?? 60;
  const renewIntervalMs = options.renewIntervalMs ?? Math.max(1_000, Math.floor(leaseTtlSeconds * 500));

  return {
    acquire: async (request) => {
      const leaseId = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      const globalKey = `${namespace}:active`;
      const connectionKey = `${namespace}:connection:${request.connectionKey}`;
      const leaseKey = `${namespace}:lease:${leaseId}`;
      const result = Number(
        await options.client.eval(ACQUIRE_STREAM_LEASE_SCRIPT, {
          keys: [globalKey, connectionKey, leaseKey],
          arguments: [
            String(request.maxActiveStreams),
            String(request.maxActiveStreamsPerConnectionKey),
            String(leaseTtlSeconds),
          ],
        }),
      );
      if (result < 0) {
        return null;
      }

      let released = false;
      const renew = async () => {
        if (released) {
          return false;
        }

        const renewed = Number(
          await options.client.eval(RENEW_STREAM_LEASE_SCRIPT, {
            keys: [globalKey, connectionKey, leaseKey],
            arguments: [String(leaseTtlSeconds)],
          }),
        );
        return renewed > 0;
      };
      const renewalTimer = setInterval(() => {
        observeLeaseRenewal(renew(), options.onRenewalError);
      }, renewIntervalMs);
      renewalTimer.unref?.();
      return {
        activeConnectionCount: result,
        renew,
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          clearInterval(renewalTimer);
          await options.client.eval(RELEASE_STREAM_LEASE_SCRIPT, {
            keys: [globalKey, connectionKey, leaseKey],
            arguments: [],
          });
        },
      };
    },
  };
}

function observeLeaseRenewal(renewal: Promise<boolean>, onError?: (error: unknown) => void): void {
  void renewal.catch((error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A background lease-renewal observer must never turn a recoverable
      // coordination outage into an unhandled rejection or process exit.
    }
  });
}

const ACQUIRE_STREAM_LEASE_SCRIPT = `
local global = tonumber(redis.call("GET", KEYS[1]) or "0")
local connection = tonumber(redis.call("GET", KEYS[2]) or "0")
local max_global = tonumber(ARGV[1])
local max_connection = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if global >= max_global or connection >= max_connection then
  return -1
end
global = redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], ttl)
redis.call("INCR", KEYS[2])
redis.call("EXPIRE", KEYS[2], ttl)
redis.call("SET", KEYS[3], "1", "EX", ttl)
return global
`;

const RENEW_STREAM_LEASE_SCRIPT = `
if redis.call("GET", KEYS[3]) then
  local ttl = tonumber(ARGV[1])
  redis.call("EXPIRE", KEYS[1], ttl)
  redis.call("EXPIRE", KEYS[2], ttl)
  redis.call("EXPIRE", KEYS[3], ttl)
  return 1
end
return 0
`;

const RELEASE_STREAM_LEASE_SCRIPT = `
if redis.call("GET", KEYS[3]) then
  redis.call("DEL", KEYS[3])
  if tonumber(redis.call("GET", KEYS[1]) or "0") > 0 then redis.call("DECR", KEYS[1]) end
  if tonumber(redis.call("GET", KEYS[2]) or "0") > 0 then redis.call("DECR", KEYS[2]) end
end
return 1
`;
