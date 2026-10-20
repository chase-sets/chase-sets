import type { PgQueryable } from "./types";
import { assertOwnerStreamReservationShape, type OwnerStreamReservation } from "@chase-sets/event-core/owner-seal";

/**
 * Revalidates owner-local stream versions on the owner's transaction. This
 * helper never creates a missing stream row: absence is an explicit refusal.
 */
export async function assertOwnerStreamVersions(
  client: PgQueryable,
  reservations: readonly OwnerStreamReservation[],
  streamsTable = "event_store_streams",
): Promise<void> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(streamsTable)) {
    throw new Error("Owner stream table identifier is invalid.");
  }
  for (const reservation of reservations) {
    assertOwnerStreamReservationShape(reservation);
    const result = await client.query<{ current_version: number | string }>(
      `SELECT current_version FROM ${streamsTable} WHERE stream_id = $1 FOR SHARE`,
      [reservation.streamId],
    );
    const current = Number(result.rows[0]?.current_version);
    if (!Number.isSafeInteger(current) || current !== reservation.expectedVersion) {
      throw new Error(`Owner stream version changed for ${reservation.ownerContext}.`);
    }
  }
}
