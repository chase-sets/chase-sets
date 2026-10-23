/** A configuration source and final consumer are distinct store incarnations. */
export type ConfigurationConsumer = Readonly<{ storeId: string; incarnation: string }>;
export type ConfigurationEpochGrant = Readonly<{
  key: string;
  sourceIncarnation: string;
  keyCreationEpoch: number;
  epoch: number;
  consumer: ConfigurationConsumer;
  topologyRevision: number;
  validUntil?: string;
}>;
export type ConfigurationGrantVector = readonly ConfigurationEpochGrant[];
export type ConfigurationEpochRecord =
  | Readonly<{ kind: "CREATED"; sourceIncarnation: string; keyCreationEpoch: number }>
  | Readonly<{ kind: "REGISTERED"; consumer: ConfigurationConsumer }>
  | Readonly<{ kind: "RETIRED"; consumer: ConfigurationConsumer }>
  | Readonly<{ kind: "CLOSING"; epoch: number; topologyRevision: number }>
  | Readonly<{ kind: "RECEIPT"; epoch: number; topologyRevision: number; consumer: ConfigurationConsumer }>
  | Readonly<{ kind: "BLOCKED"; reason: string }>
  | Readonly<{ kind: "APPLIED"; epoch: number; topologyRevision: number }>;
export type ConfigurationClosureStatus = Readonly<{
  key: string;
  epoch: number;
  topologyRevision: number;
  status: "OPEN" | "PENDING" | "BLOCKED";
  pendingConsumers: readonly ConfigurationConsumer[];
  reason?: string;
}>;
export type ConfigurationEpochHistory = Readonly<{
  sourceIncarnation: string;
  keyCreationEpoch: number;
  epoch: number;
  topologyRevision: number;
  consumers: readonly ConfigurationConsumer[];
  receipts: readonly ConfigurationConsumer[];
  state: "OPEN" | "CLOSING";
  blockedReason?: string;
}>;
export class ConfigurationEpochError extends Error {
  readonly code = "concurrency_conflict";
  constructor(message: string) {
    super(`Configuration epoch: ${message}`);
    this.name = "ConfigurationEpochError";
  }
}
export function assertConfigurationText(value: string): void {
  if (typeof value !== "string" || !value.length || value.length > 512 || value.includes("\u0000"))
    throw new ConfigurationEpochError("invalid key or incarnation");
}
export function assertConfigurationEpoch(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw new ConfigurationEpochError("invalid epoch or topology revision");
}
export function sameConfigurationConsumer(left: ConfigurationConsumer, right: ConfigurationConsumer): boolean {
  return left.storeId === right.storeId && left.incarnation === right.incarnation;
}
function assertConsumer(consumer: ConfigurationConsumer): void {
  if (!consumer) throw new ConfigurationEpochError("missing consumer");
  assertConfigurationText(consumer.storeId);
  assertConfigurationText(consumer.incarnation);
}

/** Replays the complete canonical journal. Never accepts a cached state as authority. */
export function replayConfigurationEpoch(records: readonly ConfigurationEpochRecord[]): ConfigurationEpochHistory {
  const first = records[0];
  if (!first || first.kind !== "CREATED") throw new ConfigurationEpochError("partial or absent source history");
  assertConfigurationText(first.sourceIncarnation);
  assertConfigurationEpoch(first.keyCreationEpoch);
  let state: ConfigurationEpochHistory = {
    sourceIncarnation: first.sourceIncarnation,
    keyCreationEpoch: first.keyCreationEpoch,
    epoch: first.keyCreationEpoch,
    topologyRevision: 0,
    consumers: [],
    receipts: [],
    state: "OPEN",
  };
  for (const record of records.slice(1)) {
    if (!record || typeof record !== "object") throw new ConfigurationEpochError("corrupt history record");
    switch (record.kind) {
      case "REGISTERED": {
        assertConsumer(record.consumer);
        if (state.state !== "OPEN" || state.consumers.some((c) => c.storeId === record.consumer.storeId))
          throw new ConfigurationEpochError("registration is duplicate or CLOSING");
        state = {
          ...state,
          topologyRevision: state.topologyRevision + 1,
          consumers: [...state.consumers, record.consumer],
        };
        break;
      }
      case "RETIRED": {
        assertConsumer(record.consumer);
        if (state.state !== "OPEN" || !state.consumers.some((c) => sameConfigurationConsumer(c, record.consumer)))
          throw new ConfigurationEpochError("retirement is unknown or CLOSING");
        state = {
          ...state,
          topologyRevision: state.topologyRevision + 1,
          consumers: state.consumers.filter((c) => !sameConfigurationConsumer(c, record.consumer)),
        };
        break;
      }
      case "CLOSING": {
        if (
          state.state !== "OPEN" ||
          record.epoch !== state.epoch ||
          record.topologyRevision !== state.topologyRevision
        )
          throw new ConfigurationEpochError("invalid CLOSING transition");
        state = { ...state, state: "CLOSING", receipts: [] };
        break;
      }
      case "RECEIPT": {
        assertConsumer(record.consumer);
        if (
          state.state !== "CLOSING" ||
          record.epoch !== state.epoch ||
          record.topologyRevision !== state.topologyRevision ||
          !state.consumers.some((c) => sameConfigurationConsumer(c, record.consumer)) ||
          state.receipts.some((c) => sameConfigurationConsumer(c, record.consumer))
        )
          throw new ConfigurationEpochError("unknown, stale or duplicate receipt");
        state = { ...state, receipts: [...state.receipts, record.consumer] };
        break;
      }
      case "BLOCKED": {
        assertConfigurationText(record.reason);
        if (state.state !== "CLOSING") throw new ConfigurationEpochError("blocked outside CLOSING");
        state = { ...state, blockedReason: record.reason };
        break;
      }
      case "APPLIED": {
        if (
          state.state !== "CLOSING" ||
          record.epoch !== state.epoch ||
          record.topologyRevision !== state.topologyRevision ||
          state.receipts.length !== state.consumers.length
        )
          throw new ConfigurationEpochError("installation requires every CLOSED-THROUGH receipt");
        const { blockedReason: _reason, ...rest } = state;
        state = { ...rest, epoch: state.epoch + 1, state: "OPEN", receipts: [] };
        break;
      }
      default:
        throw new ConfigurationEpochError("unknown or duplicate creation record");
    }
  }
  assertConfigurationEpoch(state.epoch);
  assertConfigurationEpoch(state.topologyRevision);
  return state;
}

export function configurationClosureStatus(key: string, state: ConfigurationEpochHistory): ConfigurationClosureStatus {
  return {
    key,
    epoch: state.epoch,
    topologyRevision: state.topologyRevision,
    status: state.state === "OPEN" ? "OPEN" : state.blockedReason ? "BLOCKED" : "PENDING",
    pendingConsumers:
      state.state === "OPEN"
        ? []
        : state.consumers.filter((c) => !state.receipts.some((r) => sameConfigurationConsumer(c, r))),
    ...(state.blockedReason === undefined ? {} : { reason: state.blockedReason }),
  };
}

export function captureConfigurationGrant(
  key: string,
  state: ConfigurationEpochHistory,
  consumer: ConfigurationConsumer,
  validUntil?: string,
): ConfigurationEpochGrant {
  assertConfigurationText(key);
  assertConsumer(consumer);
  if (state.state !== "OPEN" || !state.consumers.some((c) => sameConfigurationConsumer(c, consumer)))
    throw new ConfigurationEpochError("source is CLOSING or consumer incarnation is not registered");
  if (validUntil !== undefined && !Number.isFinite(Date.parse(validUntil)))
    throw new ConfigurationEpochError("invalid validity bound");
  return {
    key,
    sourceIncarnation: state.sourceIncarnation,
    keyCreationEpoch: state.keyCreationEpoch,
    epoch: state.epoch,
    consumer,
    topologyRevision: state.topologyRevision,
    ...(validUntil === undefined ? {} : { validUntil }),
  };
}

export function assertConfigurationGrantVector(grants: ConfigurationGrantVector): readonly ConfigurationEpochGrant[] {
  if (grants.length > 32) throw new ConfigurationEpochError("at most 32 class-C keys per append");
  const seen = new Set<string>();
  for (const grant of grants) {
    assertConfigurationText(grant.key);
    assertConfigurationText(grant.sourceIncarnation);
    assertConsumer(grant.consumer);
    assertConfigurationEpoch(grant.epoch);
    assertConfigurationEpoch(grant.keyCreationEpoch);
    assertConfigurationEpoch(grant.topologyRevision);
    if (grant.epoch < grant.keyCreationEpoch || seen.has(grant.key))
      throw new ConfigurationEpochError("duplicate or invalid grant");
    if (grant.validUntil !== undefined && !Number.isFinite(Date.parse(grant.validUntil)))
      throw new ConfigurationEpochError("invalid validity bound");
    seen.add(grant.key);
  }
  return [...grants].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type ConfigurationConsumerGuard = Readonly<{
  sourceIncarnation: string;
  keyCreationEpoch: number;
  closedThroughEpoch: number;
  topologyRevision: number;
}>;
/** Synchronous consumer-local terminal validation; absence never synthesizes guard rows. */
export function assertConfigurationGrantCurrent(
  grant: ConfigurationEpochGrant,
  consumer: ConfigurationConsumer,
  guard: ConfigurationConsumerGuard | undefined,
  consumerClock: string,
): void {
  if (!sameConfigurationConsumer(grant.consumer, consumer))
    throw new ConfigurationEpochError("old consumer incarnation");
  const now = Date.parse(consumerClock);
  if (!Number.isFinite(now) || (grant.validUntil !== undefined && Date.parse(grant.validUntil) <= now))
    throw new ConfigurationEpochError("invalid consumer clock or expired validity bound");
  if (!guard) {
    if (grant.epoch !== grant.keyCreationEpoch)
      throw new ConfigurationEpochError("absent history at non-creation epoch");
    return;
  }
  if (
    guard.sourceIncarnation !== grant.sourceIncarnation ||
    guard.keyCreationEpoch !== grant.keyCreationEpoch ||
    guard.closedThroughEpoch < guard.keyCreationEpoch ||
    guard.closedThroughEpoch + 1 !== grant.epoch ||
    guard.topologyRevision < 0 ||
    guard.topologyRevision > grant.topologyRevision
  )
    throw new ConfigurationEpochError("closed-through, partial or stale source history");
}
