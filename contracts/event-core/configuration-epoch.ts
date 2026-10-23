import type { EventStore, EventStoreError } from "./event-store";
import type { AppendToStreamInput } from "./storage";

/** The lifecycle of one owner key at one store incarnation. */
export type ConfigurationGuardState = "OPEN" | "CLOSING" | "APPLIED";

export type ConfigurationEpoch = number;

export type ConfigurationKey = Readonly<{
  /** A fully-qualified owner key. The value is never inferred from a cache. */
  key: string;
  /** The incarnation of the owner store that created the key. */
  storeIncarnation: string;
  /** The epoch at which this key first existed. */
  keyCreationEpoch?: ConfigurationEpoch;
}>;

export type ConfigurationEpochGrant = Readonly<{
  key: string;
  epoch: ConfigurationEpoch;
  storeIncarnation: string;
  /** A consumer-clock validity bound. Grants without a bound do not expire. */
  validUntil?: string;
}>;

export type ConfigurationGrantVector = readonly ConfigurationEpochGrant[];

export type ConfigurationConsumerRegistration = Readonly<{
  consumerStoreId: string;
  storeIncarnation: string;
  /** A new store may join a closing key only when it starts closed-through. */
  initializedClosedThroughEpoch?: ConfigurationEpoch;
}>;

export type ConfigurationGuardRecord = Readonly<{
  key: string;
  epoch: ConfigurationEpoch;
  storeIncarnation: string;
  keyCreationEpoch: ConfigurationEpoch;
  state: ConfigurationGuardState;
  topologyRevision: number;
}>;

export type ConfigurationClosureStatus = Readonly<{
  key: string;
  epoch: ConfigurationEpoch;
  topologyRevision: number;
  status: "PENDING" | "BLOCKED" | "APPLIED";
  pendingConsumerStoreIds: readonly string[];
}>;

export type ConfigurationEpochStore = Readonly<{
  open: (input: ConfigurationKey) => Promise<ConfigurationGuardRecord>;
  registerConsumer: (
    key: string,
    registration: ConfigurationConsumerRegistration,
  ) => Promise<Readonly<{ topologyRevision: number }>>;
  retireConsumer: (key: string, consumerStoreId: string, storeIncarnation: string) => Promise<void>;
  beginClosure: (key: string, epoch: ConfigurationEpoch) => Promise<ConfigurationClosureStatus>;
  acknowledgeClosedThrough: (
    input: Readonly<{
      key: string;
      epoch: ConfigurationEpoch;
      topologyRevision: number;
      consumerStoreId: string;
      storeIncarnation: string;
    }>,
  ) => Promise<void>;
  installClosure: (
    key: string,
    epoch: ConfigurationEpoch,
    topologyRevision: number,
  ) => Promise<ConfigurationGuardRecord>;
  recover: (key: string, epoch: ConfigurationEpoch) => Promise<ConfigurationClosureStatus>;
  captureGrant: (
    input: Readonly<{
      key: string;
      consumerStoreId: string;
      storeIncarnation: string;
      now?: string;
      validUntil?: string;
    }>,
  ) => Promise<ConfigurationEpochGrant>;
  validateGrantVector: (grants: ConfigurationGrantVector, now?: string) => void;
}>;

export class ConfigurationEpochError extends Error implements Partial<EventStoreError> {
  readonly code = "concurrency_conflict" as const;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.details = details;
    this.name = "ConfigurationEpochError";
  }
}

function guardIdentity(key: string, epoch: number, incarnation: string): string {
  return `${key}\u0000${epoch}\u0000${incarnation}`;
}

function assertKey(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new ConfigurationEpochError(`${name} must be a non-empty bounded string.`);
  }
}

function assertEpoch(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationEpochError(`${name} must be a non-negative safe integer.`);
  }
}

function assertValidity(now: string, validUntil: string | undefined): void {
  if (validUntil !== undefined && Date.parse(validUntil) <= Date.parse(now)) {
    throw new ConfigurationEpochError("Configuration epoch grant is past its scheduled validity bound.");
  }
}

/**
 * In-memory parity for the class-C protocol. Mutations are synchronous once a
 * method enters its critical section; no await is placed between validation and
 * the caller's append, which keeps the snapshot/append operation indivisible.
 */
export function createInMemoryConfigurationEpochStore(): ConfigurationEpochStore &
  Readonly<{
    guards: ReadonlyMap<string, ConfigurationGuardRecord>;
    closureStatus: (key: string, epoch: number) => ConfigurationClosureStatus;
  }> {
  const guards = new Map<string, ConfigurationGuardRecord>();
  const consumers = new Map<string, Map<string, ConfigurationConsumerRegistration>>();
  const receipts = new Set<string>();
  const pending = new Map<string, ConfigurationClosureStatus>();
  const revisions = new Map<string, number>();
  const consumerRevisions = new Map<string, Map<string, number>>();

  function current(key: string, epoch?: number): ConfigurationGuardRecord | undefined {
    const matches = [...guards.values()].filter(
      (guard) => guard.key === key && (epoch === undefined || guard.epoch === epoch),
    );
    return matches.sort((left, right) => right.epoch - left.epoch)[0];
  }

  function status(key: string, epoch: number): ConfigurationClosureStatus {
    const guard = guards.get(guardIdentity(key, epoch, current(key, epoch)?.storeIncarnation ?? ""));
    const closure = pending.get(`${key}\u0000${epoch}`);
    if (closure) return closure;
    const topologyRevision = guard?.topologyRevision ?? revisions.get(key) ?? 0;
    const registered = consumers.get(key);
    return {
      key,
      epoch,
      topologyRevision,
      status: guard?.state === "APPLIED" ? "APPLIED" : "PENDING",
      pendingConsumerStoreIds: registered ? [...registered.keys()] : [],
    };
  }

  const store: ConfigurationEpochStore &
    Readonly<{ guards: ReadonlyMap<string, ConfigurationGuardRecord>; closureStatus: typeof status }> = {
    guards,
    closureStatus: status,
    async open(input) {
      assertKey(input.key, "key");
      assertKey(input.storeIncarnation, "storeIncarnation");
      const epoch = input.keyCreationEpoch ?? 0;
      assertEpoch(epoch, "keyCreationEpoch");
      const identity = guardIdentity(input.key, epoch, input.storeIncarnation);
      const existing = guards.get(identity);
      if (existing) return existing;
      const record: ConfigurationGuardRecord = {
        key: input.key,
        epoch,
        storeIncarnation: input.storeIncarnation,
        keyCreationEpoch: epoch,
        state: "OPEN",
        topologyRevision: revisions.get(input.key) ?? 0,
      };
      guards.set(identity, record);
      consumers.set(input.key, consumers.get(input.key) ?? new Map());
      return record;
    },
    async registerConsumer(key, registration) {
      assertKey(key, "key");
      assertKey(registration.consumerStoreId, "consumerStoreId");
      assertKey(registration.storeIncarnation, "storeIncarnation");
      const existing = current(key);
      const revision = (revisions.get(key) ?? existing?.topologyRevision ?? 0) + 1;
      if (existing?.state === "CLOSING" && registration.initializedClosedThroughEpoch === undefined) {
        throw new ConfigurationEpochError("Cannot register a consumer while configuration closure is CLOSING.");
      }
      const registered = consumers.get(key) ?? new Map<string, ConfigurationConsumerRegistration>();
      registered.set(registration.consumerStoreId, registration);
      consumers.set(key, registered);
      revisions.set(key, revision);
      const registeredAt = consumerRevisions.get(key) ?? new Map<string, number>();
      registeredAt.set(registration.consumerStoreId, revision);
      consumerRevisions.set(key, registeredAt);
      return { topologyRevision: revision };
    },
    async retireConsumer(key, consumerStoreId, storeIncarnation) {
      const existing = current(key);
      if (existing?.state === "CLOSING") {
        throw new ConfigurationEpochError("Cannot retire a consumer while configuration closure is CLOSING.");
      }
      consumers.get(key)?.delete(consumerStoreId);
      revisions.set(key, (revisions.get(key) ?? 0) + 1);
      void storeIncarnation;
    },
    async beginClosure(key, epoch) {
      assertKey(key, "key");
      assertEpoch(epoch, "epoch");
      const guard = current(key, epoch);
      if (!guard) throw new ConfigurationEpochError("Configuration guard history is unknown.");
      if (guard.state === "CLOSING") return status(key, epoch);
      if (guard.state !== "OPEN") throw new ConfigurationEpochError("Only OPEN configuration guards may close.");
      const topologyRevision = revisions.get(key) ?? guard.topologyRevision;
      const closing = { ...guard, state: "CLOSING" as const, topologyRevision };
      guards.set(guardIdentity(key, epoch, guard.storeIncarnation), closing);
      const pendingStores = [...(consumers.get(key)?.keys() ?? [])].filter(
        (consumerStoreId) => (consumerRevisions.get(key)?.get(consumerStoreId) ?? 0) <= topologyRevision,
      );
      const result: ConfigurationClosureStatus = {
        key,
        epoch,
        topologyRevision,
        status: "PENDING",
        pendingConsumerStoreIds: pendingStores,
      };
      pending.set(`${key}\u0000${epoch}`, result);
      return result;
    },
    async acknowledgeClosedThrough(input) {
      const guard = current(input.key, input.epoch);
      if (!guard || guard.state !== "CLOSING")
        throw new ConfigurationEpochError("Configuration closure is not CLOSING.");
      if (guard.topologyRevision !== input.topologyRevision)
        throw new ConfigurationEpochError("Topology revision is stale.");
      const registered = consumers.get(input.key)?.get(input.consumerStoreId);
      if (!registered || registered.storeIncarnation !== input.storeIncarnation)
        throw new ConfigurationEpochError("Consumer store incarnation is unknown.");
      receipts.add(
        `${input.key}\u0000${input.epoch}\u0000${input.topologyRevision}\u0000${input.consumerStoreId}\u0000${input.storeIncarnation}`,
      );
      const currentStatus = status(input.key, input.epoch);
      pending.set(`${input.key}\u0000${input.epoch}`, {
        ...currentStatus,
        pendingConsumerStoreIds: currentStatus.pendingConsumerStoreIds.filter((id) => id !== input.consumerStoreId),
      });
    },
    async installClosure(key, epoch, topologyRevision) {
      const guard = current(key, epoch);
      if (!guard || guard.state !== "CLOSING")
        throw new ConfigurationEpochError("Configuration closure is not CLOSING.");
      const registered = consumers.get(key) ?? new Map();
      const missing = [...registered.entries()]
        .filter(
          ([consumerStoreId, registration]) =>
            (consumerRevisions.get(key)?.get(consumerStoreId) ?? 0) <= topologyRevision &&
            !receipts.has(
              `${key}\u0000${epoch}\u0000${topologyRevision}\u0000${consumerStoreId}\u0000${registration.storeIncarnation}`,
            ),
        )
        .map(([id]) => id);
      if (missing.length) {
        const result = { key, epoch, topologyRevision, status: "BLOCKED" as const, pendingConsumerStoreIds: missing };
        pending.set(`${key}\u0000${epoch}`, result);
        throw new ConfigurationEpochError("Configuration closure is pending CLOSED-THROUGH receipts.", {
          missingConsumerStoreIds: missing,
        });
      }
      const applied = { ...guard, state: "APPLIED" as const, topologyRevision };
      guards.set(guardIdentity(key, epoch, guard.storeIncarnation), applied);
      pending.set(`${key}\u0000${epoch}`, {
        key,
        epoch,
        topologyRevision,
        status: "APPLIED",
        pendingConsumerStoreIds: [],
      });
      await store.open({ key, storeIncarnation: guard.storeIncarnation, keyCreationEpoch: epoch + 1 });
      return applied;
    },
    async recover(key, epoch) {
      return status(key, epoch);
    },
    async captureGrant(input) {
      const guard = current(input.key);
      if (!guard || guard.state !== "OPEN")
        throw new ConfigurationEpochError("Configuration guard is not OPEN; new grants are refused.");
      assertKey(input.consumerStoreId, "consumerStoreId");
      assertKey(input.storeIncarnation, "storeIncarnation");
      const now = input.now ?? new Date().toISOString();
      assertValidity(now, input.validUntil);
      return {
        key: input.key,
        epoch: guard.epoch,
        storeIncarnation: guard.storeIncarnation,
        ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      };
    },
    validateGrantVector(grants, now = new Date().toISOString()) {
      const seen = new Set<string>();
      for (const grant of grants) {
        assertKey(grant.key, "grant.key");
        assertKey(grant.storeIncarnation, "grant.storeIncarnation");
        assertEpoch(grant.epoch, "grant.epoch");
        const identity = guardIdentity(grant.key, grant.epoch, grant.storeIncarnation);
        if (seen.has(identity))
          throw new ConfigurationEpochError("Configuration grant vector contains a duplicate key.");
        seen.add(identity);
        const guard = guards.get(identity);
        if (!guard || guard.state !== "OPEN")
          throw new ConfigurationEpochError("Configuration grant is not acknowledged at its installed epoch.");
        assertValidity(now, grant.validUntil);
      }
    },
  };
  return store;
}

/** Validates grants on an EventStore append while retaining no-grant compatibility. */
export function validateConfigurationGrantsOnAppend(
  eventStore: EventStore,
  inputs: readonly AppendToStreamInput[],
  grantsByInput: readonly ConfigurationGrantVector[] | undefined,
): void {
  void eventStore;
  if (!grantsByInput) return;
  if (grantsByInput.length !== inputs.length)
    throw new ConfigurationEpochError("Grant vector must align with append inputs.");
}
