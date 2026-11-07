import { createEventStoreError } from "./event-store";

export const OWNER_STREAM_MAX_PURPOSES = 8;
export const OWNER_STREAM_MAX_RESOURCES = 32;
export const OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE = 128;
export type OwnerStreamSeal = Readonly<{ version: number; storeIncarnation: string }>;
export type ReservationConsumer = Readonly<{ storeId: string; incarnation: string; requestId: string }>;
export type ReserveOwnerStreamInput = Readonly<{
  reservationId: string;
  operationId: string;
  ownerStreamId: string;
  purpose: string;
  resourceKey: string;
  consumer: ReservationConsumer;
  seal: OwnerStreamSeal;
  target: Readonly<Record<string, unknown>>;
  commandFingerprint: string;
}>;
export type OwnerStreamReservation = ReserveOwnerStreamInput &
  Readonly<{
    status: "OPEN" | "RELEASED";
    releaseStatus?: "COMMITTED" | "ABORTED";
  }>;
/** Immutable consumer-local preparation; COMMIT never consults an owner. */
export type RequestTerminalBinding = Readonly<{
  consumerStoreId: string;
  consumerIncarnation: string;
  requestId: string;
  commandFingerprint: string;
  target: Readonly<Record<string, unknown>>;
  reservations: readonly ReserveOwnerStreamInput[];
  preparationDeadline: string;
}>;
export type RequestTerminal = RequestTerminalBinding & Readonly<{ status: "OPEN" | "COMMITTED" | "ABORTED" }>;
export type InvalidationIntent = Readonly<{
  ownerStreamId: string;
  generation: number;
  status: "PENDING" | "ABORT-REQUESTED" | "APPLIED";
  affectedReservationIds: readonly string[];
}>;
export type InboundEvidenceInput = Readonly<{
  evidenceId: string;
  resourceKey: string;
  payload: Readonly<Record<string, unknown>>;
}>;
export type InboundEvidenceResult = InboundEvidenceInput & Readonly<{ status: "PENDING" | "BLOCKED" | "APPLIED" }>;
export type OwnerStreamReservationStore = Readonly<{
  reserve: (input: ReserveOwnerStreamInput) => Promise<OwnerStreamReservation>;
  getReservation: (reservationId: string) => Promise<OwnerStreamReservation | undefined>;
  beginInvalidation: (ownerStreamId: string) => Promise<InvalidationIntent>;
  driveInvalidation: (ownerStreamId: string) => Promise<InvalidationIntent>;
  openRequestTerminal: (binding: RequestTerminalBinding) => Promise<RequestTerminal>;
  abortRequestTerminal: (binding: RequestTerminalBinding) => Promise<RequestTerminal>;
  abortPreparationDeadline: (binding: RequestTerminalBinding) => Promise<RequestTerminal>;
  recordInboundEvidence: (input: InboundEvidenceInput) => Promise<InboundEvidenceResult>;
  settleInboundEvidence: (evidenceId: string) => Promise<InboundEvidenceResult>;
}>;
type MemorySnapshot = Readonly<{
  reservations: Map<string, OwnerStreamReservation>;
  terminals: Map<string, RequestTerminal>;
  invalidations: Map<string, InvalidationIntent>;
  evidence: Map<string, InboundEvidenceResult>;
}>;
export type InMemoryOwnerStreamReservationStore = OwnerStreamReservationStore &
  Readonly<{
    /** Adapter-internal CAS, called synchronously inside atomic append/restore. */
    commitRequestTerminalSync: (binding: RequestTerminalBinding) => RequestTerminal;
    snapshot: () => MemorySnapshot;
    restore: (snapshot: MemorySnapshot) => void;
  }>;
function conflict(message: string): never {
  throw createEventStoreError("concurrency_conflict", message);
}
function assertText(value: string, name: string): void {
  if (typeof value !== "string" || !value.length || value.length > 512 || value.includes("\u0000"))
    conflict(`Owner-stream reservation ${name} is invalid.`);
}
/** PostgreSQL jsonb can reorder keys, so identity is canonical JSON. */
export function reservationIdentity(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(reservationIdentity).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${reservationIdentity((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return conflict("Reservation identity must contain only JSON values.");
}
export function assertOwnerStreamReservationInput(input: ReserveOwnerStreamInput): void {
  for (const [name, value] of Object.entries({
    reservationId: input.reservationId,
    operationId: input.operationId,
    ownerStreamId: input.ownerStreamId,
    purpose: input.purpose,
    resourceKey: input.resourceKey,
    commandFingerprint: input.commandFingerprint,
    consumerStoreId: input.consumer.storeId,
    consumerIncarnation: input.consumer.incarnation,
    requestId: input.consumer.requestId,
    storeIncarnation: input.seal.storeIncarnation,
  }))
    assertText(value, name);
  if (!Number.isSafeInteger(input.seal.version) || input.seal.version < 0)
    conflict("Reservation seal version is invalid.");
  reservationIdentity(input.target);
}
export function assertRequestTerminalBinding(b: RequestTerminalBinding): void {
  assertText(b.consumerStoreId, "consumerStoreId");
  assertText(b.consumerIncarnation, "consumerIncarnation");
  assertText(b.requestId, "requestId");
  assertText(b.commandFingerprint, "commandFingerprint");
  if (!Number.isFinite(Date.parse(b.preparationDeadline))) conflict("Preparation deadline is invalid.");
  if (!b.reservations.length || new Set(b.reservations.map((r) => r.reservationId)).size !== b.reservations.length)
    conflict("Request terminal reservation manifest is incomplete or duplicated.");
  for (const r of b.reservations) {
    assertOwnerStreamReservationInput(r);
    if (
      r.consumer.storeId !== b.consumerStoreId ||
      r.consumer.incarnation !== b.consumerIncarnation ||
      r.consumer.requestId !== b.requestId ||
      r.commandFingerprint !== b.commandFingerprint ||
      reservationIdentity(r.target) !== reservationIdentity(b.target)
    )
      conflict("Request terminal reservation identity does not match.");
  }
}
export function sameRequestTerminalBinding(a: RequestTerminalBinding, b: RequestTerminalBinding): boolean {
  const identity = (v: RequestTerminalBinding) => ({
    consumerStoreId: v.consumerStoreId,
    consumerIncarnation: v.consumerIncarnation,
    requestId: v.requestId,
    commandFingerprint: v.commandFingerprint,
    target: v.target,
    preparationDeadline: v.preparationDeadline,
    reservations: v.reservations,
  });
  return reservationIdentity(identity(a)) === reservationIdentity(identity(b));
}
export function reservationInput(r: ReserveOwnerStreamInput): ReserveOwnerStreamInput {
  return {
    reservationId: r.reservationId,
    operationId: r.operationId,
    ownerStreamId: r.ownerStreamId,
    purpose: r.purpose,
    resourceKey: r.resourceKey,
    consumer: r.consumer,
    seal: r.seal,
    target: r.target,
    commandFingerprint: r.commandFingerprint,
  };
}
export function terminalOwnsReservation(t: RequestTerminal, r: ReserveOwnerStreamInput): boolean {
  assertRequestTerminalBinding(t);
  return t.reservations.some((v) => reservationIdentity(v) === reservationIdentity(reservationInput(r)));
}
export type MemoryReservationConfig = Readonly<{
  consumer: Readonly<{ storeId: string; incarnation: string }>;
  readOwnerSeal: (ownerStreamId: string) => OwnerStreamSeal;
  applyInvalidation: (intent: InvalidationIntent) => undefined;
  applyInboundEvidence: (evidence: InboundEvidenceInput) => undefined;
  now?: () => number;
}>;

export function createInMemoryOwnerStreamReservationStore(
  config: MemoryReservationConfig,
): InMemoryOwnerStreamReservationStore {
  const reservations = new Map<string, OwnerStreamReservation>();
  const terminals = new Map<string, RequestTerminal>();
  const invalidations = new Map<string, InvalidationIntent>();
  const evidence = new Map<string, InboundEvidenceResult>();
  const now = config.now ?? Date.now;
  const key = (b: RequestTerminalBinding) => JSON.stringify([b.consumerStoreId, b.requestId]);
  const validate = (b: RequestTerminalBinding) => {
    assertRequestTerminalBinding(b);
    if (b.consumerStoreId !== config.consumer.storeId || b.consumerIncarnation !== config.consumer.incarnation)
      conflict("Request terminal consumer incarnation does not match.");
  };
  const transition = (b: RequestTerminalBinding, status: "COMMITTED" | "ABORTED"): RequestTerminal => {
    validate(b);
    let prior = terminals.get(key(b));
    if (!prior && status === "ABORTED") {
      prior = { ...structuredClone(b), status: "OPEN" };
      terminals.set(key(b), prior);
    }
    if (!prior || !sameRequestTerminalBinding(prior, b)) conflict("Request terminal identity does not match.");
    if (prior.status !== "OPEN") {
      if (status === "ABORTED") return structuredClone(prior);
      conflict("Request terminal is already final.");
    }
    const next: RequestTerminal = { ...prior, status };
    terminals.set(key(b), next);
    return structuredClone(next);
  };
  const begin = (ownerStreamId: string): InvalidationIntent => {
    const prior = invalidations.get(ownerStreamId);
    if (prior && prior.status !== "APPLIED") return structuredClone(prior);
    const next: InvalidationIntent = {
      ownerStreamId,
      generation: (prior?.generation ?? 0) + 1,
      status: "PENDING",
      affectedReservationIds: [...reservations.values()]
        .filter((r) => r.ownerStreamId === ownerStreamId && r.status === "OPEN")
        .map((r) => r.reservationId),
    };
    invalidations.set(ownerStreamId, next);
    return structuredClone(next);
  };
  const drive = (ownerStreamId: string): InvalidationIntent => {
    const intent = invalidations.get(ownerStreamId);
    if (!intent) return conflict("Owner-stream invalidation has not been opened.");
    if (intent.status === "APPLIED") return structuredClone(intent);
    invalidations.set(ownerStreamId, { ...intent, status: "ABORT-REQUESTED" });
    for (const id of intent.affectedReservationIds) {
      const r = reservations.get(id);
      if (!r) conflict("Original reservation is missing.");
      if (r.status === "RELEASED") continue;
      const terminal = [...terminals.values()].find((t) => terminalOwnsReservation(t, r));
      if (!terminal) continue;
      const final = terminal.status === "OPEN" ? transition(terminal, "ABORTED") : terminal;
      if (final.status !== "OPEN") reservations.set(id, { ...r, status: "RELEASED", releaseStatus: final.status });
    }
    if (intent.affectedReservationIds.some((id) => reservations.get(id)?.status !== "RELEASED"))
      return structuredClone(invalidations.get(ownerStreamId)!);
    config.applyInvalidation(intent);
    const next: InvalidationIntent = { ...intent, status: "APPLIED" };
    invalidations.set(ownerStreamId, next);
    return structuredClone(next);
  };
  return {
    async reserve(input) {
      assertOwnerStreamReservationInput(input);
      const prior = reservations.get(input.reservationId);
      if (prior) {
        if (reservationIdentity(reservationInput(prior)) !== reservationIdentity(input))
          conflict("Reservation identity was reused.");
        return structuredClone(prior);
      }
      if (reservationIdentity(config.readOwnerSeal(input.ownerStreamId)) !== reservationIdentity(input.seal))
        conflict("Owner-stream seal is not current.");
      const intent = invalidations.get(input.ownerStreamId);
      if (intent && intent.status !== "APPLIED") conflict("Owner stream invalidation is pending.");
      if ([...evidence.values()].some((e) => e.resourceKey === input.resourceKey && e.status !== "APPLIED"))
        conflict("Inbound evidence settlement is pending.");
      const open = [...reservations.values()].filter((r) => r.status === "OPEN");
      const operation = open.filter((r) => r.operationId === input.operationId);
      const purposes = new Set(operation.map((r) => r.purpose));
      const resources = new Set(operation.map((r) => r.resourceKey));
      if (!purposes.has(input.purpose) && purposes.size >= OWNER_STREAM_MAX_PURPOSES)
        conflict("Owner-stream reservation purpose bound exceeded.");
      if (!resources.has(input.resourceKey) && resources.size >= OWNER_STREAM_MAX_RESOURCES)
        conflict("Owner-stream reservation resource bound exceeded.");
      if (open.filter((r) => r.resourceKey === input.resourceKey).length >= OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE)
        conflict("Owner-stream reservation live-grant bound exceeded.");
      const result: OwnerStreamReservation = { ...structuredClone(input), status: "OPEN" };
      reservations.set(input.reservationId, result);
      return structuredClone(result);
    },
    async getReservation(id) {
      const r = reservations.get(id);
      return r ? structuredClone(r) : undefined;
    },
    async beginInvalidation(id) {
      return begin(id);
    },
    async driveInvalidation(id) {
      return drive(id);
    },
    async openRequestTerminal(b) {
      validate(b);
      const prior = terminals.get(key(b));
      if (prior) {
        if (!sameRequestTerminalBinding(prior, b)) conflict("Request terminal identity was reused.");
        return structuredClone(prior);
      }
      for (const r of b.reservations) {
        const grant = reservations.get(r.reservationId);
        if (
          !grant ||
          grant.status !== "OPEN" ||
          reservationIdentity(reservationInput(grant)) !== reservationIdentity(r)
        )
          conflict("Request preparation is incomplete.");
      }
      const result: RequestTerminal = { ...structuredClone(b), status: "OPEN" };
      terminals.set(key(b), result);
      return structuredClone(result);
    },
    async abortRequestTerminal(b) {
      return transition(b, "ABORTED");
    },
    async abortPreparationDeadline(b) {
      validate(b);
      const t = terminals.get(key(b));
      if (t && !sameRequestTerminalBinding(t, b)) conflict("Request terminal identity does not match.");
      if (now() >= Date.parse(b.preparationDeadline) && (!t || t.status === "OPEN")) return transition(b, "ABORTED");
      if (!t) return conflict("Request terminal is not open.");
      return structuredClone(t);
    },
    async recordInboundEvidence(input) {
      assertText(input.evidenceId, "evidenceId");
      assertText(input.resourceKey, "resourceKey");
      reservationIdentity(input.payload);
      const prior = evidence.get(input.evidenceId);
      if (prior) {
        if (
          prior.resourceKey !== input.resourceKey ||
          reservationIdentity(prior.payload) !== reservationIdentity(input.payload)
        )
          conflict("Inbound evidence identity was reused.");
        return structuredClone(prior);
      }
      const result: InboundEvidenceResult = { ...structuredClone(input), status: "PENDING" };
      evidence.set(input.evidenceId, result);
      return structuredClone(result);
    },
    async settleInboundEvidence(id) {
      const prior = evidence.get(id);
      if (!prior) return conflict("Inbound evidence is missing.");
      if (prior.status === "APPLIED") return structuredClone(prior);
      const owners = new Set(
        [...reservations.values()]
          .filter((r) => r.resourceKey === prior.resourceKey && r.status === "OPEN")
          .map((r) => r.ownerStreamId),
      );
      for (const owner of owners) {
        begin(owner);
        drive(owner);
      }
      if ([...reservations.values()].some((r) => r.resourceKey === prior.resourceKey && r.status === "OPEN")) {
        const blocked: InboundEvidenceResult = { ...prior, status: "BLOCKED" };
        evidence.set(id, blocked);
        return structuredClone(blocked);
      }
      config.applyInboundEvidence(prior);
      const applied: InboundEvidenceResult = { ...prior, status: "APPLIED" };
      evidence.set(id, applied);
      return structuredClone(applied);
    },
    commitRequestTerminalSync(b) {
      return transition(b, "COMMITTED");
    },
    snapshot() {
      return structuredClone({ reservations, terminals, invalidations, evidence });
    },
    restore(snapshot) {
      for (const [target, source] of [
        [reservations, snapshot.reservations],
        [terminals, snapshot.terminals],
        [invalidations, snapshot.invalidations],
        [evidence, snapshot.evidence],
      ] as const) {
        target.clear();
        for (const [k, value] of source) (target as Map<string, unknown>).set(k, structuredClone(value));
      }
    },
  };
}
