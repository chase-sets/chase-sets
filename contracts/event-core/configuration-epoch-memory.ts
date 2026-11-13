import {
  ConfigurationEpochError,
  assertConfigurationGrantCurrent,
  assertConfigurationGrantVector,
  captureConfigurationGrant,
  configurationClosureStatus,
  replayConfigurationEpoch,
  sameConfigurationConsumer,
  type ConfigurationConsumer,
  type ConfigurationConsumerGuard,
  type ConfigurationEpochGrant,
  type ConfigurationEpochRecord,
  type ConfigurationGrantVector,
} from "./configuration-epoch";

/** Consumer-local synchronous guard boundary used inside the memory append critical section. */
export function createInMemoryConfigurationConsumer(
  identity: ConfigurationConsumer,
  clock = () => new Date().toISOString(),
) {
  const guards = new Map<string, ConfigurationConsumerGuard>();
  return {
    identity,
    guards,
    closeThrough(key: string, guard: ConfigurationConsumerGuard): void {
      const prior = guards.get(key);
      if (
        prior &&
        (prior.sourceIncarnation !== guard.sourceIncarnation ||
          prior.keyCreationEpoch !== guard.keyCreationEpoch ||
          prior.closedThroughEpoch > guard.closedThroughEpoch)
      )
        throw new ConfigurationEpochError("consumer history conflict");
      guards.set(key, structuredClone(guard));
    },
    validateGrantVector(grants: ConfigurationGrantVector): void {
      for (const grant of assertConfigurationGrantVector(grants)) {
        const guard = guards.get(grant.key);
        if (guard && (!Number.isSafeInteger(guard.closedThroughEpoch) || !Number.isSafeInteger(guard.topologyRevision)))
          throw new ConfigurationEpochError("corrupt consumer history");
        assertConfigurationGrantCurrent(grant, identity, guard, clock());
      }
    },
  };
}
export type InMemoryConfigurationConsumer = ReturnType<typeof createInMemoryConfigurationConsumer>;

/** Canonical journals only; no snapshot can seed owner authority. */
export function createInMemoryConfigurationEpochStore(sourceIncarnation: string) {
  const journals = new Map<string, ConfigurationEpochRecord[]>();
  const routes = new Map<string, InMemoryConfigurationConsumer>();
  function state(key: string) {
    return replayConfigurationEpoch(journals.get(key) ?? []);
  }
  function append(key: string, record: ConfigurationEpochRecord) {
    const next = [...(journals.get(key) ?? []), structuredClone(record)];
    replayConfigurationEpoch(next);
    journals.set(key, next);
  }
  return {
    journals,
    open(key: string, keyCreationEpoch = 0): void {
      if (journals.has(key)) throw new ConfigurationEpochError("key already created");
      append(key, { kind: "CREATED", sourceIncarnation, keyCreationEpoch });
    },
    registerConsumer(key: string, consumer: InMemoryConfigurationConsumer): void {
      const current = state(key);
      if (current.state !== "OPEN") throw new ConfigurationEpochError("registration waits while CLOSING");
      if (current.epoch > current.keyCreationEpoch)
        consumer.closeThrough(key, {
          sourceIncarnation,
          keyCreationEpoch: current.keyCreationEpoch,
          closedThroughEpoch: current.epoch - 1,
          topologyRevision: current.topologyRevision + 1,
        });
      append(key, { kind: "REGISTERED", consumer: consumer.identity });
      routes.set(consumer.identity.storeId, consumer);
    },
    retireConsumer(key: string, consumer: ConfigurationConsumer): void {
      const current = state(key);
      if (current.state !== "OPEN") throw new ConfigurationEpochError("retirement waits while CLOSING");
      const target = routes.get(consumer.storeId);
      if (!target || !sameConfigurationConsumer(target.identity, consumer))
        throw new ConfigurationEpochError("unknown retirement incarnation");
      target.closeThrough(key, {
        sourceIncarnation,
        keyCreationEpoch: current.keyCreationEpoch,
        closedThroughEpoch: current.epoch,
        topologyRevision: current.topologyRevision,
      });
      append(key, { kind: "RETIRED", consumer });
    },
    beginClosure(key: string) {
      const current = state(key);
      if (current.state === "OPEN")
        append(key, { kind: "CLOSING", epoch: current.epoch, topologyRevision: current.topologyRevision });
      return configurationClosureStatus(key, state(key));
    },
    captureGrant(key: string, consumer: ConfigurationConsumer, validUntil?: string): ConfigurationEpochGrant {
      return captureConfigurationGrant(key, state(key), consumer, validUntil);
    },
    driveClosure(key: string, consumers: readonly InMemoryConfigurationConsumer[]) {
      let current = state(key);
      if (current.state !== "CLOSING") throw new ConfigurationEpochError("not CLOSING");
      for (const required of current.consumers) {
        if (current.receipts.some((r) => sameConfigurationConsumer(r, required))) continue;
        const consumer = consumers.find((c) => sameConfigurationConsumer(c.identity, required));
        if (!consumer) {
          append(key, { kind: "BLOCKED", reason: `unavailable store ${required.storeId}` });
          return configurationClosureStatus(key, state(key));
        }
        consumer.closeThrough(key, {
          sourceIncarnation,
          keyCreationEpoch: current.keyCreationEpoch,
          closedThroughEpoch: current.epoch,
          topologyRevision: current.topologyRevision,
        });
        append(key, {
          kind: "RECEIPT",
          epoch: current.epoch,
          topologyRevision: current.topologyRevision,
          consumer: required,
        });
        current = state(key);
      }
      return configurationClosureStatus(key, current);
    },
    installClosure(key: string): void {
      const current = state(key);
      append(key, { kind: "APPLIED", epoch: current.epoch, topologyRevision: current.topologyRevision });
    },
    status(key: string) {
      return configurationClosureStatus(key, state(key));
    },
  };
}
