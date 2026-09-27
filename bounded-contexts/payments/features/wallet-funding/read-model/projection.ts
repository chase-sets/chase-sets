import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  evolveWalletFunding,
  initialWalletFundingState,
  type WalletFundingEvent,
  type WalletFundingState,
} from "../domain/domain";

export const walletFundingEventTypes = [
  "payments.wallet-funding-quoted",
  "payments.wallet-funding-submission-claimed",
  "payments.wallet-funding-created",
  "payments.wallet-funding-authorized",
  "payments.wallet-funding-captured",
  "payments.wallet-funding-failed",
  "payments.wallet-funding-cancelled",
  "payments.wallet-funding-refund-operation-recorded",
  "payments.wallet-funding-refund-attention-recorded",
  "payments.wallet-funding-refunded",
  "payments.wallet-funding-dispute-recorded",
  "payments.wallet-funding-fraud-warning-recorded",
] as const;

export function buildWalletFundingProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project = async (event: TransportEvent) => {
    const fundingId = event.streamId.slice("payments.wallet-funding-".length);
    const existing = await db.query<{ state: WalletFundingState; last_stream_version: number }>(
      "SELECT state, last_stream_version FROM payments_wallet_funding_pages WHERE funding_id = $1",
      [fundingId],
    );
    const row = existing.rows[0];
    if (row && Number(row.last_stream_version) >= event.streamVersion) return;
    const state = evolveWalletFunding(
      row?.state ?? initialWalletFundingState,
      createPassthroughDomainEventCodec<WalletFundingEvent>().decode({ eventType: event.type, payload: event.data }),
    );
    if (!state.quote || !state.status) throw new Error("funding_projection_missing_quote");
    await db.query(
      `INSERT INTO payments_wallet_funding_pages (funding_id, account_id, processor_payment_reference, status, state, last_stream_version)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (funding_id) DO UPDATE SET
      processor_payment_reference = EXCLUDED.processor_payment_reference, status = EXCLUDED.status,
      state = EXCLUDED.state, last_stream_version = EXCLUDED.last_stream_version, updated_at = now()
      WHERE payments_wallet_funding_pages.last_stream_version < EXCLUDED.last_stream_version`,
      [
        fundingId,
        state.quote.accountId,
        state.processorPaymentReference,
        state.status,
        JSON.stringify(state),
        event.streamVersion,
      ],
    );
  };
  return Object.fromEntries(walletFundingEventTypes.map((type) => [type, project]));
}
