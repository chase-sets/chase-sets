import type { EventStoreContext } from "./storage";

/** A private owner's captured stream revision and fail-closed revalidation. */
export type OwnerStreamReservation = Readonly<{
  ownerContext: string;
  streamId: string;
  expectedVersion: number;
  assertCurrent: () => Promise<void>;
}>;

export type OwnerStreamSeal = Readonly<{
  ownerContext: string;
  streamId: string;
  version: number;
  context: EventStoreContext;
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
}
