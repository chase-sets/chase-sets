import { createEventStoreError, type EventStoreError } from "./event-store";

export const OWNER_STREAM_MAX_PURPOSES = 8;
export const OWNER_STREAM_MAX_RESOURCES = 32;
export const OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE = 128;

export type OwnerStreamSeal = Readonly<{
  version: number;
  storeIncarnation: string;
}>;

export type ReservationConsumer = Readonly<{
  storeId: string;
  requestId: string;
}>;

export type OwnerStreamReservation = Readonly<{
  reservationId: string;
  operationId: string;
  ownerStreamId: string;
  purpose: string;
  resourceKey: string;
  consumer: ReservationConsumer;
  seal: OwnerStreamSeal;
  target: Readonly<Record<string, unknown>>;
  commandFingerprint: string;
  status: "OPEN" | "RELEASED";
  releaseStatus?: "COMMITTED" | "ABORTED";
}>;

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

export type RequestTerminalBinding = Readonly<{
  consumerStoreId: string;
  requestId: string;
  reservationIds: readonly string[];
}>;

export type RequestTerminal = Readonly<{
  consumerStoreId: string;
  requestId: string;
  status: "OPEN" | "COMMITTED" | "ABORTED";
  reservationIds: readonly string[];
}>;

export type InvalidationIntent = Readonly<{
  ownerStreamId: string;
  generation: number;
  status: "PENDING" | "ABORT-REQUESTED" | "APPLIED";
  affectedReservationIds: readonly string[];
}>;

export type InboundEvidenceResult = Readonly<{
  evidenceId: string;
  resourceKey: string;
  status: "PENDING" | "BLOCKED" | "APPLIED";
}>;

export type OwnerStreamReservationStore = Readonly<{
  reserve: (input: ReserveOwnerStreamInput) => Promise<OwnerStreamReservation>;
  getReservation: (reservationId: string) => Promise<OwnerStreamReservation | undefined>;
  beginInvalidation: (ownerStreamId: string) => Promise<InvalidationIntent>;
  driveInvalidation: (ownerStreamId: string) => Promise<InvalidationIntent>;
  openRequestTerminal: (binding: RequestTerminalBinding) => Promise<RequestTerminal>;
  commitRequestTerminal: (binding: RequestTerminalBinding) => Promise<RequestTerminal>;
  abortRequestTerminal: (binding: RequestTerminalBinding) => Promise<RequestTerminal>;
  recordInboundEvidence: (
    input: Readonly<{
      evidenceId: string;
      resourceKey: string;
      payload: Readonly<Record<string, unknown>>;
    }>,
  ) => Promise<InboundEvidenceResult>;
}>;

export type InMemoryOwnerStreamReservationStore = OwnerStreamReservationStore &
  Readonly<{
    commitRequestTerminalSync: (binding: RequestTerminalBinding, status?: "COMMITTED" | "ABORTED") => RequestTerminal;
    snapshot: () => Readonly<{
      reservations: Map<string, OwnerStreamReservation>;
      terminals: Map<string, RequestTerminal>;
      invalidations: Map<string, InvalidationIntent>;
      evidence: Map<string, InboundEvidenceResult>;
    }>;
    restore: (
      snapshot: Readonly<{
        reservations: Map<string, OwnerStreamReservation>;
        terminals: Map<string, RequestTerminal>;
        invalidations: Map<string, InvalidationIntent>;
        evidence: Map<string, InboundEvidenceResult>;
      }>,
    ) => void;
  }>;

export function assertOwnerStreamReservationInput(input: ReserveOwnerStreamInput): void {
  for (const [name, value] of Object.entries({
    reservationId: input.reservationId,
    operationId: input.operationId,
    ownerStreamId: input.ownerStreamId,
    purpose: input.purpose,
    resourceKey: input.resourceKey,
    commandFingerprint: input.commandFingerprint,
    consumerStoreId: input.consumer.storeId,
    requestId: input.consumer.requestId,
    storeIncarnation: input.seal.storeIncarnation,
  })) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\u0000")) {
      throw new Error(`Owner-stream reservation ${name} is invalid.`);
    }
  }
  if (!Number.isSafeInteger(input.seal.version) || input.seal.version < 0) {
    throw new Error("Owner-stream reservation seal version is invalid.");
  }
}

function conflict(message: string, details?: Record<string, unknown>): EventStoreError {
  return createEventStoreError("concurrency_conflict", message, details);
}

function cloneReservation(input: OwnerStreamReservation): OwnerStreamReservation {
  return {
    ...input,
    consumer: { ...input.consumer },
    seal: { ...input.seal },
    target: structuredClone(input.target),
  };
}

/** In-memory parity implementation. All state transitions are synchronous. */
export function createInMemoryOwnerStreamReservationStore(): InMemoryOwnerStreamReservationStore &
  Readonly<{
    reservations: Map<string, OwnerStreamReservation>;
    terminals: Map<string, RequestTerminal>;
    invalidations: Map<string, InvalidationIntent>;
    evidence: Map<string, InboundEvidenceResult>;
  }> {
  const reservations = new Map<string, OwnerStreamReservation>();
  const terminals = new Map<string, RequestTerminal>();
  const invalidations = new Map<string, InvalidationIntent>();
  const evidence = new Map<string, InboundEvidenceResult>();

  const terminalKey = (binding: RequestTerminalBinding) => `${binding.consumerStoreId}:${binding.requestId}`;
  const assertBinding = (binding: RequestTerminalBinding) => {
    if (!binding.consumerStoreId || !binding.requestId || binding.reservationIds.length === 0)
      throw conflict("Request terminal binding is incomplete.");
    if (new Set(binding.reservationIds).size !== binding.reservationIds.length)
      throw conflict("Request terminal binding contains duplicate reservations.");
  };
  const transition = (binding: RequestTerminalBinding, status: "COMMITTED" | "ABORTED"): RequestTerminal => {
    assertBinding(binding);
    const key = terminalKey(binding);
    const prior = terminals.get(key);
    if (!prior) throw conflict("Request terminal is not open.", { requestId: binding.requestId });
    if (prior.status !== "OPEN") {
      if (prior.status === status) return prior;
      throw conflict("Request terminal is already final.", { requestId: binding.requestId });
    }
    if (JSON.stringify(prior.reservationIds) !== JSON.stringify(binding.reservationIds))
      throw conflict("Request terminal reservation identity does not match.");
    for (const reservationId of prior.reservationIds) {
      const reservation = reservations.get(reservationId);
      if (
        !reservation ||
        reservation.consumer.storeId !== binding.consumerStoreId ||
        reservation.consumer.requestId !== binding.requestId
      )
        throw conflict("Request terminal reservation identity does not match.", { reservationId });
    }
    const terminal = { ...prior, status, reservationIds: [...prior.reservationIds] } as RequestTerminal;
    terminals.set(key, terminal);
    for (const reservationId of terminal.reservationIds) {
      const reservation = reservations.get(reservationId)!;
      reservations.set(reservationId, { ...reservation, status: "RELEASED", releaseStatus: status });
    }
    return terminal;
  };

  return {
    reservations,
    terminals,
    invalidations,
    evidence,
    async reserve(input) {
      assertOwnerStreamReservationInput(input);
      if (reservations.has(input.reservationId)) {
        const existing = reservations.get(input.reservationId)!;
        if (
          existing.operationId === input.operationId &&
          existing.ownerStreamId === input.ownerStreamId &&
          existing.purpose === input.purpose &&
          existing.resourceKey === input.resourceKey &&
          existing.consumer.storeId === input.consumer.storeId &&
          existing.consumer.requestId === input.consumer.requestId &&
          existing.seal.version === input.seal.version &&
          existing.seal.storeIncarnation === input.seal.storeIncarnation &&
          existing.commandFingerprint === input.commandFingerprint &&
          JSON.stringify(existing.target) === JSON.stringify(input.target)
        )
          return cloneReservation(existing);
        throw conflict("Reservation identity was reused with different data.", { reservationId: input.reservationId });
      }
      const invalidation = invalidations.get(input.ownerStreamId);
      if (invalidation && invalidation.status !== "APPLIED") throw conflict("Owner stream invalidation is pending.");
      const operationReservations = [...reservations.values()].filter(
        (reservation) => reservation.operationId === input.operationId && reservation.status === "OPEN",
      );
      const purposes = new Set(operationReservations.map((reservation) => reservation.purpose));
      const resources = new Set(operationReservations.map((reservation) => reservation.resourceKey));
      const liveForResource = operationReservations.filter(
        (reservation) => reservation.resourceKey === input.resourceKey,
      ).length;
      if (!purposes.has(input.purpose) && purposes.size >= OWNER_STREAM_MAX_PURPOSES)
        throw conflict("Owner-stream reservation purpose bound exceeded.");
      if (!resources.has(input.resourceKey) && resources.size >= OWNER_STREAM_MAX_RESOURCES)
        throw conflict("Owner-stream reservation resource bound exceeded.");
      if (liveForResource >= OWNER_STREAM_MAX_LIVE_GRANTS_PER_RESOURCE)
        throw conflict("Owner-stream reservation live-grant bound exceeded.");
      const reservation: OwnerStreamReservation = { ...input, status: "OPEN" };
      reservations.set(input.reservationId, reservation);
      return cloneReservation(reservation);
    },
    async getReservation(reservationId) {
      const reservation = reservations.get(reservationId);
      return reservation ? cloneReservation(reservation) : undefined;
    },
    async beginInvalidation(ownerStreamId) {
      const current = invalidations.get(ownerStreamId);
      if (current && current.status !== "APPLIED") return current;
      const generation = (current?.generation ?? 0) + 1;
      const affectedReservationIds = [...reservations.values()]
        .filter((reservation) => reservation.ownerStreamId === ownerStreamId && reservation.status === "OPEN")
        .map((reservation) => reservation.reservationId);
      const intent: InvalidationIntent = { ownerStreamId, generation, status: "PENDING", affectedReservationIds };
      invalidations.set(ownerStreamId, intent);
      return intent;
    },
    async driveInvalidation(ownerStreamId) {
      const intent = invalidations.get(ownerStreamId);
      if (!intent) throw conflict("Owner-stream invalidation has not been opened.");
      const unresolved = intent.affectedReservationIds.filter(
        (reservationId) => reservations.get(reservationId)?.status === "OPEN",
      );
      if (unresolved.length) {
        const next = { ...intent, status: "ABORT-REQUESTED" as const };
        invalidations.set(ownerStreamId, next);
        return next;
      }
      const next = { ...intent, status: "APPLIED" as const };
      invalidations.set(ownerStreamId, next);
      return next;
    },
    async openRequestTerminal(binding) {
      assertBinding(binding);
      const key = terminalKey(binding);
      const prior = terminals.get(key);
      if (prior) {
        if (JSON.stringify(prior.reservationIds) !== JSON.stringify(binding.reservationIds))
          throw conflict("Request terminal identity was reused.");
        return prior;
      }
      for (const reservationId of binding.reservationIds) {
        const reservation = reservations.get(reservationId);
        if (
          !reservation ||
          reservation.status !== "OPEN" ||
          reservation.consumer.storeId !== binding.consumerStoreId ||
          reservation.consumer.requestId !== binding.requestId
        )
          throw conflict("Reservation is not available to this request terminal.", { reservationId });
      }
      const terminal: RequestTerminal = {
        consumerStoreId: binding.consumerStoreId,
        requestId: binding.requestId,
        status: "OPEN",
        reservationIds: [...binding.reservationIds],
      };
      terminals.set(key, terminal);
      return terminal;
    },
    async commitRequestTerminal(binding) {
      return transition(binding, "COMMITTED");
    },
    async abortRequestTerminal(binding) {
      return transition(binding, "ABORTED");
    },
    async recordInboundEvidence(input) {
      if (!input.evidenceId || !input.resourceKey) throw conflict("Inbound evidence identity is incomplete.");
      const prior = evidence.get(input.evidenceId);
      if (prior) return prior;
      const hasOpenReservation = [...reservations.values()].some(
        (reservation) => reservation.resourceKey === input.resourceKey && reservation.status === "OPEN",
      );
      const result: InboundEvidenceResult = {
        evidenceId: input.evidenceId,
        resourceKey: input.resourceKey,
        status: hasOpenReservation ? "PENDING" : "APPLIED",
      };
      evidence.set(input.evidenceId, result);
      return result;
    },
    commitRequestTerminalSync(binding, status = "COMMITTED") {
      return transition(binding, status);
    },
    snapshot() {
      return {
        reservations: new Map([...reservations].map(([key, value]) => [key, cloneReservation(value)])),
        terminals: new Map(
          [...terminals].map(([key, value]) => [key, { ...value, reservationIds: [...value.reservationIds] }]),
        ),
        invalidations: new Map(
          [...invalidations].map(([key, value]) => [
            key,
            { ...value, affectedReservationIds: [...value.affectedReservationIds] },
          ]),
        ),
        evidence: new Map([...evidence].map(([key, value]) => [key, { ...value }])),
      };
    },
    restore(snapshot) {
      reservations.clear();
      for (const [key, value] of snapshot.reservations) reservations.set(key, cloneReservation(value));
      terminals.clear();
      for (const [key, value] of snapshot.terminals)
        terminals.set(key, { ...value, reservationIds: [...value.reservationIds] });
      invalidations.clear();
      for (const [key, value] of snapshot.invalidations)
        invalidations.set(key, { ...value, affectedReservationIds: [...value.affectedReservationIds] });
      evidence.clear();
      for (const [key, value] of snapshot.evidence) evidence.set(key, { ...value });
    },
  };
}
