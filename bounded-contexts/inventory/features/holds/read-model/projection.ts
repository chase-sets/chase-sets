import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type {
  InventoryHoldPurpose,
  InventoryHoldReleaseReason,
  InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildInventoryHoldProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
        reason: string;
        notes: string | null;
      };
      const anatomy = holdAnatomyFromPlacedPayload(data);

      await db.query(
        `INSERT INTO inventory_holds (
           hold_id,
           account_id,
           item_id,
           quantity,
           reason,
           notes,
           purpose,
           source_ref,
           expires_at,
           status,
           created_at,
           updated_at,
           released_at,
           release_reason,
           last_stream_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10, NULL, NULL, $11)
         ON CONFLICT (hold_id) DO UPDATE
         SET account_id = $2,
             item_id = $3,
             quantity = $4,
             reason = $5,
             notes = $6,
             purpose = $7,
             source_ref = $8,
             expires_at = $9,
             status = 'active',
             updated_at = $10,
             released_at = NULL,
             release_reason = NULL,
             last_stream_version = $11
         WHERE inventory_holds.last_stream_version < $11`,
        [
          data.holdId,
          data.accountId,
          data.itemId,
          data.quantity,
          data.reason,
          anatomy.notes,
          anatomy.purpose,
          anatomy.sourceRef ? JSON.stringify(anatomy.sourceRef) : null,
          anatomy.expiresAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.hold.released": async (event) => {
      const { holdId, releasedAt, releaseReason } = event.data as {
        holdId: string;
        releasedAt: string;
        releaseReason?: InventoryHoldReleaseReason;
      };

      await db.query(
        `UPDATE inventory_holds
         SET status = 'released',
             updated_at = $2,
             released_at = $3,
             release_reason = $4,
             last_stream_version = $5
         WHERE hold_id = $1
           AND last_stream_version < $5`,
        [holdId, event.timing.recordedAt, releasedAt, releaseReason ?? null, event.streamVersion],
      );
    },
  };
}

type PlacedHoldPayload = Readonly<{
  reason: string;
  notes: string | null;
  purpose?: InventoryHoldPurpose;
  sourceRef?: InventoryHoldSourceRef;
  expiresAt?: string | null;
}>;

function holdAnatomyFromPlacedPayload(data: PlacedHoldPayload): Readonly<{
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt: string | null;
  notes: string | null;
}> {
  if (data.purpose) {
    return {
      purpose: data.purpose,
      sourceRef: data.sourceRef ?? null,
      expiresAt: data.expiresAt ?? null,
      notes: data.notes,
    };
  }

  if (data.reason === "Ordering commitment") {
    return {
      purpose: "order",
      sourceRef: null,
      expiresAt: null,
      notes: data.notes,
    };
  }

  return {
    purpose: "manual",
    sourceRef: null,
    expiresAt: null,
    notes: data.notes ?? data.reason,
  };
}
