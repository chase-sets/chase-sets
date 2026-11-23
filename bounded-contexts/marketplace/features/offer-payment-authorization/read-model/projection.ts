import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  authorizationEvent,
  authorizationRecordSchema,
  authorizationSnapshotSchema,
  authorizationStream,
} from "../domain/contracts";
import { initialAuthorization } from "../domain/domain";

export const authorizationProjectionName = "marketplace.offer-payment-authorization-projection";

export function buildAuthorizationProjection(db: PgQueryable): ProjectorHandlerMap {
  const handler: ProjectorHandlerMap[string] = async (event, context) => {
    const { buyerAccountId, snapshot } = authorizationRecordSchema.parse(event.data);
    const { source } = snapshot;
    // Every lifecycle fact and its standing fact append together, in that order.
    const version = event.streamVersion + (event.type === authorizationEvent.previewed ? 0 : 1);
    await (context?.db ?? db).query(
      `INSERT INTO marketplace_offer_payment_authorizations (
        account_id, state, generation, use_balance, instrument_id, instrument_category, consent_version, latest_held_order_id, stream_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (account_id) DO UPDATE SET
        state = EXCLUDED.state, generation = EXCLUDED.generation, use_balance = EXCLUDED.use_balance,
        instrument_id = EXCLUDED.instrument_id, instrument_category = EXCLUDED.instrument_category,
        consent_version = EXCLUDED.consent_version, latest_held_order_id = EXCLUDED.latest_held_order_id,
        stream_version = EXCLUDED.stream_version
      WHERE marketplace_offer_payment_authorizations.stream_version < EXCLUDED.stream_version`,
      [
        buyerAccountId,
        snapshot.state,
        snapshot.generation,
        source?.useBalance ?? false,
        source?.instrumentId ?? null,
        source?.category ?? null,
        snapshot.consentVersion,
        snapshot.latestHeldOrderId,
        version,
      ],
    );
  };
  return Object.fromEntries(
    Object.values(authorizationEvent)
      .filter((type) => type !== authorizationEvent.changed)
      .map((type) => [type, handler]),
  );
}

export async function readAuthorizationProjection(db: PgQueryable, accountId: string) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT state, generation, use_balance, instrument_id, instrument_category, consent_version, latest_held_order_id, stream_version
       FROM marketplace_offer_payment_authorizations WHERE account_id = $1`,
    [accountId],
  );
  const snapshot = row
    ? authorizationSnapshotSchema.parse({
        state: row.state,
        generation: row.generation,
        source:
          row.use_balance || row.instrument_id
            ? { useBalance: row.use_balance, instrumentId: row.instrument_id, category: row.instrument_category }
            : null,
        consentVersion: row.consent_version,
        latestHeldOrderId: row.latest_held_order_id,
      })
    : initialAuthorization.snapshot;
  return { authorizationId: authorizationStream(accountId), version: Number(row?.stream_version ?? 0), ...snapshot };
}
