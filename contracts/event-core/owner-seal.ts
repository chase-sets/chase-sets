import type { EventStoreContext } from "./storage";

/** A private owner's captured stream revision and fail-closed revalidation. */
export type OwnerStreamReservation = Readonly<{
  ownerContext: string;
  streamId: string;
  expectedVersion: number;
  assertCurrent: () => Promise<void>;
  /** The durable owner-local seal captured with the reservation. */
  seal?: OwnerStreamSeal;
}>;

export type OwnerStreamSeal = Readonly<{
  ownerContext: string;
  streamId: string;
  version: number;
  context: EventStoreContext;
}>;

/**
 * A reservation promoted into the Marketplace append boundary.  The owner
 * callback is intentionally opaque to Event Core: each bounded context owns
 * its state read and can fail closed for missing, corrupt, or unknown state.
 */
export type OwnerStreamCommitParticipant = Readonly<{
  ownerContext: string;
  streamId: string;
  expectedVersion: number;
  seal: OwnerStreamSeal;
  assertCurrent: () => Promise<void>;
}>;

export function assertOwnerStreamReservationShape(value: OwnerStreamReservation): void {
  if (
    !value.ownerContext ||
    !value.streamId ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    typeof value.assertCurrent !== "function"
  ) {
    throw new Error("Owner stream reservation is invalid.");
  }
  if (value.seal !== undefined) {
    assertOwnerStreamSealShape(value.seal);
    if (
      value.seal.ownerContext !== value.ownerContext ||
      value.seal.streamId !== value.streamId ||
      value.seal.version !== value.expectedVersion
    ) {
      throw new Error("Owner stream reservation seal does not match its capture.");
    }
  }
}

export function assertOwnerStreamSealShape(value: OwnerStreamSeal): void {
  if (
    !value.ownerContext ||
    !value.streamId ||
    !Number.isSafeInteger(value.version) ||
    value.version < 0 ||
    !value.context ||
    typeof value.context !== "object" ||
    !value.context.tenantId ||
    !value.context.audit ||
    !value.context.audit.performedByUserId ||
    !value.context.audit.forAccountId
  ) {
    throw new Error("Owner stream seal is invalid.");
  }
}

export function toOwnerStreamCommitParticipant(reservation: OwnerStreamReservation): OwnerStreamCommitParticipant {
  assertOwnerStreamReservationShape(reservation);
  if (!reservation.seal) {
    throw new Error(`Owner stream seal is missing for ${reservation.ownerContext}.`);
  }
  assertOwnerStreamSealShape(reservation.seal);
  return reservation as OwnerStreamCommitParticipant;
}

export function assertOwnerStreamCommitParticipantShape(value: OwnerStreamCommitParticipant): void {
  assertOwnerStreamReservationShape(value);
  if (!value.seal) {
    throw new Error(`Owner stream seal is missing for ${value.ownerContext}.`);
  }
}

export async function assertOwnerStreamCommitParticipants(
  participants: readonly OwnerStreamCommitParticipant[],
  expectedContext?: EventStoreContext,
): Promise<void> {
  const consumedStreams = new Set<string>();
  for (const participant of participants) {
    assertOwnerStreamCommitParticipantShape(participant);
    const streamKey = `${participant.ownerContext}\u0000${participant.streamId}`;
    if (consumedStreams.has(streamKey)) {
      throw new Error(`Owner stream seal is duplicated for ${participant.ownerContext}.`);
    }
    consumedStreams.add(streamKey);
    if (
      expectedContext &&
      (participant.seal.context.tenantId !== expectedContext.tenantId ||
        participant.seal.context.audit.forAccountId !== expectedContext.audit.forAccountId ||
        participant.seal.context.audit.performedByUserId !== expectedContext.audit.performedByUserId)
    ) {
      throw new Error(`Owner stream seal context is unknown for ${participant.ownerContext}.`);
    }
    await participant.assertCurrent();
  }
}
