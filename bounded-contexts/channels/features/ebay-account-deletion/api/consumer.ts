import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ConnectionEpochs } from "../../connections/api/owner-epochs";
import type { ConnectorFeedServices } from "../../connector-feed/api/runtime";
import type { EbayConnectionServices } from "../../ebay-connection/api/runtime";
import { ebayReceiptRetention } from "../domain/policy";
import { EbayReceiptError, parseEbaySubjectFingerprint } from "../domain/subject";

type Receipt = { notification_id: string; subject_fingerprint: string };
type Match = { binding_id: string; account_id: string; current_connection_id: string | null };

export function createEbayAccountDeletionConsumer(deps: {
  db: PgTransactionalPool;
  connectionEpochs: ConnectionEpochs;
  ebayConnection: Pick<EbayConnectionServices, "prepareAccountDeletionDisconnect">;
  connectorFeed: Pick<ConnectorFeedServices, "disconnectChannelConnectionInTransaction">;
  context: (accountId: string) => EventStoreContext;
}) {
  async function receipt(db: PgQueryable, notificationId: string, lock = false) {
    const result = await db.query<Receipt>(
      `SELECT notification_id,subject_fingerprint FROM channels_ebay_account_deletion_receipts receipt
      WHERE notification_id=$1 AND expires_at>statement_timestamp()
      AND NOT EXISTS (SELECT 1 FROM channels_ebay_account_deletion_completions completion
        WHERE completion.notification_id=receipt.notification_id) ${lock ? "FOR UPDATE" : ""}`,
      [notificationId],
    );
    const row = result.rows[0];
    if (row) parseEbaySubjectFingerprint(row.subject_fingerprint);
    return row;
  }
  async function matches(db: PgQueryable, fingerprint: string, lock = false) {
    return (
      await db.query<Match>(
        `SELECT binding_id,account_id,COALESCE(current_connection_id,
          (SELECT connection_id FROM channels_ebay_disconnect_records record
           WHERE record.binding_id=binding.binding_id ORDER BY disconnected_at DESC,connection_id LIMIT 1)) AS current_connection_id
        FROM channels_ebay_seller_bindings binding WHERE subject_fingerprint=$1
        ORDER BY binding_id ${lock ? "FOR UPDATE" : ""}`,
        [fingerprint],
      )
    ).rows.filter((row): row is Match & { current_connection_id: string } => row.current_connection_id !== null);
  }
  return {
    async batch(after: string | null) {
      try {
        return (
          await deps.db.query<{ notification_id: string }>(
            `SELECT notification_id FROM channels_ebay_account_deletion_receipts receipt
            WHERE ($1::text IS NULL OR notification_id>$1) AND expires_at>statement_timestamp()
            AND NOT EXISTS (SELECT 1 FROM channels_ebay_account_deletion_completions completion
              WHERE completion.notification_id=receipt.notification_id)
            ORDER BY notification_id LIMIT $2`,
            [after, ebayReceiptRetention.batchSize],
          )
        ).rows.map((row) => row.notification_id);
      } catch {
        throw new EbayReceiptError("storage-unavailable");
      }
    },
    async consume(notificationId: string) {
      const session = await deps.db.connect().catch(() => {
        throw new EbayReceiptError("storage-unavailable");
      });
      let locked = false;
      let releaseError: unknown;
      try {
        // Session admission covers bounded remote work without holding a SQL transaction.
        locked = (
          await session.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended('ebay-deletion:' || $1::text,0)) AS locked",
            [notificationId],
          )
        ).rows[0]!.locked;
        if (!locked) return 0;
        const candidate = await receipt(session, notificationId);
        if (!candidate) return 0;
        const targets = await matches(session, candidate.subject_fingerprint);
        if (!targets.length) return 0;
        for (const target of targets)
          await deps.ebayConnection.prepareAccountDeletionDisconnect({
            accountId: target.account_id,
            connectionId: target.current_connection_id,
          });
        return await deps.connectionEpochs.transaction(
          targets.map((target) => `connection/${target.current_connection_id}`),
          async (db) => {
            // Runner -> consumer -> transactional connector disconnect -> eBay custody removal.
            // After epoch admission: attempts table -> receipt -> attempts -> bindings.
            // No provider I/O is inside this boundary. Start/callback take the compatible
            // table lock first, so completion also fences unbound and already-consumed work.
            await db.query("LOCK TABLE channels_ebay_oauth_attempts IN EXCLUSIVE MODE");
            const current = await receipt(db, notificationId, true);
            if (!current) return 0;
            await db.query("DELETE FROM channels_ebay_oauth_attempts");
            const live = await matches(db, current.subject_fingerprint, true);
            // A successor not covered by this closure is retried, never written unfenced.
            if (
              live.some((row) => !targets.some((target) => target.current_connection_id === row.current_connection_id))
            )
              return 0;
            for (const target of live) {
              await deps.connectorFeed.disconnectChannelConnectionInTransaction(
                db,
                { accountId: target.account_id, connectionId: target.current_connection_id },
                deps.context(target.account_id),
                "unconfirmed",
              );
              await db.query(
                `UPDATE channels_ebay_seller_bindings SET subject_fingerprint=NULL,subject_key_id=NULL,
                iv=NULL,ciphertext=NULL,tag=NULL WHERE binding_id=$1`,
                [target.binding_id],
              );
              await db.query(
                `INSERT INTO channels_ebay_account_deletion_completions
                (notification_id,connection_id,acted_at,remote_revocation)
                VALUES ($1,$2,statement_timestamp(),'unconfirmed')`,
                [notificationId, target.current_connection_id],
              );
            }
            return live.length;
          },
        );
      } catch (error) {
        // Destroy the session on failure, including uncertain advisory-lock acquisition.
        releaseError = new EbayReceiptError("storage-unavailable");
        if (error instanceof EbayReceiptError && error.code === "unavailable") throw error;
        throw releaseError;
      } finally {
        try {
          if (locked)
            await session.query("SELECT pg_advisory_unlock(hashtextextended('ebay-deletion:' || $1::text,0))", [
              notificationId,
            ]);
        } catch {
          releaseError = new EbayReceiptError("storage-unavailable");
          throw releaseError;
        } finally {
          session.release(releaseError);
        }
      }
    },
  };
}
export type EbayAccountDeletionConsumer = ReturnType<typeof createEbayAccountDeletionConsumer>;
