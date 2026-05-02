export type RealtimeStreamLease = Readonly<{
  activeConnectionCount: number;
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
      const activeForConnectionKey =
        activeStreamsByConnectionKey.get(request.connectionKey) ?? 0;
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

export function createRedisRealtimeStreamLimiter(options: Readonly<{
  client: RedisRealtimeStreamLimiterClient;
  namespace?: string;
  leaseTtlSeconds?: number;
}>): RealtimeStreamLimiter {
  const namespace = options.namespace ?? "chase_sets:realtime:streams";
  const leaseTtlSeconds = options.leaseTtlSeconds ?? 60;

  return {
    acquire: async (request) => {
      const leaseId = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      const globalKey = `${namespace}:active`;
      const connectionKey = `${namespace}:connection:${request.connectionKey}`;
      const leaseKey = `${namespace}:lease:${leaseId}`;
      const result = Number(await options.client.eval(ACQUIRE_STREAM_LEASE_SCRIPT, {
        keys: [globalKey, connectionKey, leaseKey],
        arguments: [
          String(request.maxActiveStreams),
          String(request.maxActiveStreamsPerConnectionKey),
          String(leaseTtlSeconds),
        ],
      }));
      if (result < 0) {
        return null;
      }

      let released = false;
      return {
        activeConnectionCount: result,
        release: async () => {
          if (released) {
            return;
          }

          released = true;
          await options.client.eval(RELEASE_STREAM_LEASE_SCRIPT, {
            keys: [globalKey, connectionKey, leaseKey],
            arguments: [],
          });
        },
      };
    },
  };
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

const RELEASE_STREAM_LEASE_SCRIPT = `
if redis.call("GET", KEYS[3]) then
  redis.call("DEL", KEYS[3])
  if tonumber(redis.call("GET", KEYS[1]) or "0") > 0 then redis.call("DECR", KEYS[1]) end
  if tonumber(redis.call("GET", KEYS[2]) or "0") > 0 then redis.call("DECR", KEYS[2]) end
end
return 1
`;
