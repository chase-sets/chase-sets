import { createHash } from "node:crypto";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { recordRateLimitExceeded, resolveRateLimitRule, type RateLimitRule } from "@chase-sets/http/rate-limit";
import type { PaymentProcessorWebhookEvent } from "@chase-sets/payment-processing";

export const cardDeclineSurface = "payments.card-decline.fingerprint";
const defaults = { max: 5, windowMs: 60 * 60 * 1000 };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export type CardDeclineStore = ReturnType<typeof createCardDeclineStore>;

export function createCardDeclineStore(
  pool: PgTransactionalPool,
  options: Readonly<{ now?: () => number; rule?: RateLimitRule }> = {},
) {
  const now = options.now ?? Date.now;
  const rule = options.rule ?? resolveRateLimitRule(cardDeclineSurface, defaults);
  return {
    async check(fingerprint: string | null | undefined) {
      if (!fingerprint?.trim() || rule.disabled) return null;
      const checkedAt = now();
      const result = await pool.query<{ decline_count: number; reset_at: Date }>(
        `SELECT decline_count, reset_at FROM payments_card_decline_counters WHERE fingerprint_digest = $1`,
        [digest(fingerprint.trim())],
      );
      const bucket = result.rows[0];
      if (!bucket || bucket.reset_at.getTime() <= checkedAt || bucket.decline_count < rule.max) return null;
      return { retryAfterSeconds: Math.max(Math.ceil((bucket.reset_at.getTime() - checkedAt) / 1000), 1) };
    },
    async record(event: PaymentProcessorWebhookEvent) {
      const method = event.savedPaymentMethod;
      if (
        event.kind !== "payment-failed" ||
        method?.paymentMethodCategory !== "card" ||
        !method.paymentMethodFingerprint?.trim()
      )
        return;
      const fingerprintDigest = digest(method.paymentMethodFingerprint.trim());
      const factsDigest = digest(
        JSON.stringify([
          event.kind,
          event.processorPaymentKind,
          event.processorPaymentReference,
          event.internalPaymentId ?? null,
          event.processorStatus,
          event.failureCode,
          event.failureMessage,
          event.occurredAt,
          fingerprintDigest,
        ]),
      );
      const checkedAt = now();
      // Commit independently of the payment/inbox transaction: its retry must retain this receipt.
      const count = await withPgTransaction(pool, async (client) => {
        const receipt = await client.query<{ facts_digest: string }>(
          `INSERT INTO payments_card_decline_events (processor_name, event_id, facts_digest)
           VALUES ($1, $2, $3) ON CONFLICT (processor_name, event_id) DO NOTHING RETURNING facts_digest`,
          [event.processorName, event.eventId, factsDigest],
        );
        if (!receipt.rows.length) {
          const existing = await client.query<{ facts_digest: string }>(
            `SELECT facts_digest FROM payments_card_decline_events WHERE processor_name = $1 AND event_id = $2`,
            [event.processorName, event.eventId],
          );
          if (existing.rows[0]?.facts_digest !== factsDigest) throw new Error("Card decline event facts conflict.");
          return null;
        }
        if (rule.disabled) return null;
        const result = await client.query<{ decline_count: number }>(
          `INSERT INTO payments_card_decline_counters (fingerprint_digest, decline_count, reset_at)
           VALUES ($1, 1, $3)
           ON CONFLICT (fingerprint_digest) DO UPDATE SET
             decline_count = CASE WHEN payments_card_decline_counters.reset_at <= $2 THEN 1 ELSE payments_card_decline_counters.decline_count + 1 END,
             reset_at = CASE WHEN payments_card_decline_counters.reset_at <= $2 THEN $3 ELSE payments_card_decline_counters.reset_at END
           RETURNING decline_count`,
          [fingerprintDigest, new Date(checkedAt), new Date(checkedAt + rule.windowMs)],
        );
        // Receipts are not expired: a late provider retry must never become a new decline.
        await client.query(
          `DELETE FROM payments_card_decline_counters WHERE fingerprint_digest IN (
             SELECT fingerprint_digest FROM payments_card_decline_counters WHERE reset_at <= $1
             ORDER BY reset_at, fingerprint_digest LIMIT 100 FOR UPDATE SKIP LOCKED
           )`,
          [new Date(checkedAt)],
        );
        return result.rows[0]!.decline_count;
      });
      if (count !== null && count > rule.max) recordRateLimitExceeded(cardDeclineSurface);
    },
  };
}
