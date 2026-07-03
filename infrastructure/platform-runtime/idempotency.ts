export type PlatformIdempotencyRecordStatus = "pending" | "completed";

export type PlatformIdempotencyRecord<TResponse = unknown> = Readonly<{
  key: string;
  requestHash: string;
  response: TResponse | null;
  status: PlatformIdempotencyRecordStatus;
  createdAt: string;
  expiresAt?: string | null;
}>;

export type PlatformIdempotencyReservation<TResponse = unknown> =
  | Readonly<{ outcome: "reserved"; record: PlatformIdempotencyRecord<TResponse> }>
  | Readonly<{ outcome: "pending"; record: PlatformIdempotencyRecord<TResponse> }>
  | Readonly<{ outcome: "completed"; record: PlatformIdempotencyRecord<TResponse> }>
  | Readonly<{ outcome: "conflict"; record: PlatformIdempotencyRecord<TResponse> }>;

export type PlatformIdempotencyStore<TResponse = unknown> = Readonly<{
  get: (
    key: string,
  ) => Promise<PlatformIdempotencyRecord<TResponse> | null> | PlatformIdempotencyRecord<TResponse> | null;
  reserve: (input: {
    key: string;
    requestHash: string;
    createdAt: string;
    expiresAt?: string | null;
  }) => Promise<PlatformIdempotencyReservation<TResponse>> | PlatformIdempotencyReservation<TResponse>;
  complete: (record: PlatformIdempotencyRecord<TResponse> & Readonly<{ response: TResponse }>) => Promise<void> | void;
  abandon: (input: { key: string; requestHash: string }) => Promise<void> | void;
  put: (record: PlatformIdempotencyRecord<TResponse> & Readonly<{ response: TResponse }>) => Promise<void> | void;
  pruneExpired?: (now?: Date) => Promise<number> | number;
}>;

export function createMemoryPlatformIdempotencyStore<TResponse = unknown>(): PlatformIdempotencyStore<TResponse> {
  const records = new Map<string, PlatformIdempotencyRecord<TResponse>>();
  return {
    get: (key) => {
      const record = records.get(key);
      if (!record || isExpired(record, new Date())) {
        if (record) {
          records.delete(key);
        }
        return null;
      }
      return record;
    },
    reserve: (input) => {
      const existing = records.get(input.key);
      const now = new Date(input.createdAt);
      if (existing && isExpired(existing, now)) {
        records.delete(input.key);
      } else if (existing) {
        if (existing.requestHash !== input.requestHash) {
          return { outcome: "conflict", record: existing };
        }
        return { outcome: existing.status === "completed" ? "completed" : "pending", record: existing };
      }

      const record: PlatformIdempotencyRecord<TResponse> = {
        key: input.key,
        requestHash: input.requestHash,
        response: null,
        status: "pending",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt ?? null,
      };
      records.set(input.key, record);
      return { outcome: "reserved", record };
    },
    complete: (record) => {
      records.set(record.key, { ...record, status: "completed" });
    },
    abandon: (input) => {
      const record = records.get(input.key);
      if (record?.status === "pending" && record.requestHash === input.requestHash) {
        records.delete(input.key);
      }
    },
    put: (record) => {
      records.set(record.key, { ...record, status: "completed" });
    },
    pruneExpired: (now = new Date()) => {
      let deletedCount = 0;
      for (const [key, record] of records) {
        if (isExpired(record, now)) {
          records.delete(key);
          deletedCount += 1;
        }
      }
      return deletedCount;
    },
  };
}

function isExpired(record: Pick<PlatformIdempotencyRecord, "expiresAt">, now: Date): boolean {
  return Boolean(record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime());
}
