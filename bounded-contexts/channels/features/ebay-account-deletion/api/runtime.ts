import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SecretEnvelopeBytes } from "@chase-sets/platform-runtime/secret-envelope";
import type { ChannelCredentialKeyring } from "../../credentials/domain/contracts";
import { parseEbayAccountDeletionNotice } from "../domain/notice";
import { ebayReceiptRetention } from "../domain/policy";
import type { EbayReceiptMatch, EbaySubjectDataCount } from "../domain/responses";
import {
  assertEbaySubjectKeyringContinuity,
  createEbaySubjectCipher,
  EbayReceiptError,
  parseEbaySubjectFingerprint,
} from "../domain/subject";

type Existing = SecretEnvelopeBytes & { fingerprint: string; keyId: string; topic: string; eventDate: string };

export async function receiptQuery<Row>(db: PgQueryable, sql: string, values: readonly unknown[] = []) {
  try {
    return await db.query<Row>(sql, values);
  } catch {
    throw new EbayReceiptError("storage-unavailable");
  }
}

export function createEbayAccountDeletionRuntime(db: PgQueryable, keyring: ChannelCredentialKeyring | null = null) {
  keyring = keyring
    ? {
        activeKeyId: keyring.activeKeyId,
        keys: new Map([...keyring.keys].map(([id, bytes]) => [id, Buffer.from(bytes)])),
      }
    : null;
  const cipher = createEbaySubjectCipher(keyring);
  async function read(executor: PgQueryable, id: string) {
    return (
      await receiptQuery<Existing>(
        executor,
        `SELECT subject_fingerprint AS fingerprint,
      subject_key_id AS "keyId", topic, event_date AS "eventDate", subject_iv AS iv, subject_ciphertext AS ciphertext, subject_tag AS tag
      FROM channels_ebay_account_deletion_receipts WHERE notification_id = $1 FOR SHARE`,
        [id],
      )
    ).rows[0];
  }
  return {
    async recordEbayAccountDeletionReceipt(
      executor: PgQueryable,
      input: unknown,
    ): Promise<"recorded" | "duplicate" | "conflict" | "unavailable"> {
      const notice = parseEbayAccountDeletionNotice(input);
      function compare(existing: Existing) {
        cipher.assertAvailable(existing);
        cipher.open(notice.notificationId, existing);
        const fingerprint = cipher.fingerprint(
          notice.userId,
          parseEbaySubjectFingerprint(existing.fingerprint).rootKeyId,
        );
        return fingerprint === existing.fingerprint &&
          notice.topic === existing.topic &&
          notice.eventDate === existing.eventDate
          ? ("duplicate" as const)
          : ("conflict" as const);
      }
      try {
        const existing = await read(executor, notice.notificationId);
        if (existing) return compare(existing);
        if (notice.topic !== "MARKETPLACE_ACCOUNT_DELETION") throw new EbayReceiptError("invalid-notice");
        const sealed = cipher.seal(notice.notificationId, notice.userId);
        const inserted = await receiptQuery(
          executor,
          `INSERT INTO channels_ebay_account_deletion_receipts
          (notification_id,topic,event_date,publish_date,publish_attempt_count,subject_key_id,subject_fingerprint,
           subject_iv,subject_ciphertext,subject_tag,received_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,statement_timestamp(),
            statement_timestamp() + make_interval(secs => $11))
          ON CONFLICT (notification_id) DO NOTHING RETURNING notification_id`,
          [
            notice.notificationId,
            notice.topic,
            notice.eventDate,
            notice.publishDate,
            notice.publishAttemptCount,
            sealed.keyId,
            sealed.fingerprint,
            sealed.iv,
            sealed.ciphertext,
            sealed.tag,
            ebayReceiptRetention.retentionSeconds,
          ],
        );
        if (inserted.rows.length) return "recorded";
        const winner = await read(executor, notice.notificationId);
        return winner ? compare(winner) : "unavailable";
      } catch (error) {
        if (error instanceof EbayReceiptError && error.code === "unavailable") return "unavailable";
        throw error;
      }
    },
    async lookup(userId: string): Promise<readonly EbayReceiptMatch[]> {
      const fingerprint = cipher.fingerprint(userId);
      const result = await receiptQuery<{ notificationId: string; eventDate: string; expiresAt: Date }>(
        db,
        `SELECT notification_id AS "notificationId", event_date AS "eventDate", expires_at AS "expiresAt"
         FROM channels_ebay_account_deletion_receipts
         WHERE subject_fingerprint = $1 AND expires_at > statement_timestamp() ORDER BY expires_at, notification_id LIMIT 33`,
        [fingerprint],
      );
      return result.rows.map((row) => ({
        notificationId: row.notificationId,
        eventDate: row.eventDate,
        expiresAt: row.expiresAt.toISOString(),
      }));
    },
    async countSubjectData(): Promise<EbaySubjectDataCount> {
      const result = await receiptQuery<EbaySubjectDataCount>(
        db,
        `SELECT
        (SELECT count(*)::int FROM channel_connections WHERE provider_key='ebay' AND environment='production'
          AND status <> 'disconnected') AS connections,
        (SELECT count(*)::int FROM channels_connection_credentials credential
          JOIN channel_connections connection ON connection.connection_id = credential.connection_id
          AND connection.account_id = credential.account_id
          WHERE connection.provider_key='ebay' AND connection.environment='production' AND connection.status <> 'disconnected'
          AND credential.provider_key='ebay' AND credential.environment='production') AS "credentialEnvelopes"`,
      );
      return result.rows[0]!;
    },
    async assertKeyringContinuity(next: ChannelCredentialKeyring) {
      if (!keyring) throw new EbayReceiptError("unavailable");
      const references = await receiptQuery<{ fingerprint: string; keyId: string }>(
        db,
        `SELECT DISTINCT subject_fingerprint AS fingerprint, subject_key_id AS "keyId" FROM channels_ebay_account_deletion_receipts`,
      );
      assertEbaySubjectKeyringContinuity(keyring, next, references.rows);
    },
  };
}
export type EbayAccountDeletionServices = ReturnType<typeof createEbayAccountDeletionRuntime>;
