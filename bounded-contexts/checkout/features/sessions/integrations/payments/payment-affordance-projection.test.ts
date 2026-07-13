import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutPaymentAffordanceProjectionHandlers } from "./payment-affordance-projection";

type AffordanceRow = {
  account_id: string;
  instrument_id: string;
  payment_method_category: string;
  display_label: string;
  confirmation_experience: string;
  readiness: string;
  checkout_eligible: boolean;
  is_default: boolean;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  published_at: string;
  last_stream_version: number;
};

class PaymentAffordanceProjectionDb implements PgQueryable {
  public readonly accountVersions = new Map<string, number>();
  public readonly rows = new Map<string, AffordanceRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_payment_affordance_account_snapshots")) {
      const accountId = String(values[0]);
      const streamVersion = Number(values[2]);
      const existingVersion = this.accountVersions.get(accountId) ?? 0;
      if (existingVersion < streamVersion) {
        this.accountVersions.set(accountId, streamVersion);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("DELETE FROM checkout_payment_affordance_pages")) {
      const accountId = String(values[0]);
      for (const [key, row] of this.rows) {
        if (row.account_id === accountId) {
          this.rows.delete(key);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("INSERT INTO checkout_payment_affordance_pages")) {
      const accountId = String(values[0]);
      const instrumentId = String(values[1]);
      const streamVersion = Number(values[12]);
      const key = `${accountId}:${instrumentId}`;
      const existing = this.rows.get(key);
      if (!existing || existing.last_stream_version < streamVersion) {
        this.rows.set(key, {
          account_id: accountId,
          instrument_id: instrumentId,
          payment_method_category: String(values[2]),
          display_label: String(values[3]),
          confirmation_experience: String(values[4]),
          readiness: String(values[5]),
          checkout_eligible: Boolean(values[6]),
          is_default: Boolean(values[7]),
          removed_at: values[8] === null ? null : String(values[8]),
          created_at: String(values[9]),
          updated_at: String(values[10]),
          published_at: String(values[11]),
          last_stream_version: streamVersion,
        });
      }
      return { rows: [], rowCount: existing ? 0 : 1 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(streamVersion: number, data: Record<string, unknown>): TransportEvent {
  return buildTransportEvent("payments.checkout-affordances-published", data, {
    id: `evt_${streamVersion}`,
    streamId: "payments.checkout-affordances-acc_buyer",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
    timing: { occurredAt: "2026-06-29T00:00:00.000Z", recordedAt: "2026-06-29T00:00:00.000Z" },
  });
}

describe("checkout payment affordance projection", () => {
  it("replaces the account saved-instrument snapshot and ignores stale replays", async () => {
    const db = new PaymentAffordanceProjectionDb();
    const handlers = buildCheckoutPaymentAffordanceProjectionHandlers(db);

    await handlers["payments.checkout-affordances-published"]!(
      event(1, {
        accountId: "acc_buyer",
        publishedAt: "2026-06-29T00:00:00.000Z",
        savedCheckoutInstruments: [
          {
            instrumentId: "sci_card_1",
            paymentMethodCategory: "card",
            displayLabel: "Visa ending in 4242",
            confirmationExperience: "trusted-payment-step",
            readiness: "ready",
            checkoutEligible: true,
            isDefault: true,
            removedAt: null,
            createdAt: "2026-06-28T00:00:00.000Z",
            updatedAt: "2026-06-29T00:00:00.000Z",
          },
        ],
      }),
    );

    await handlers["payments.checkout-affordances-published"]!(
      event(2, {
        accountId: "acc_buyer",
        publishedAt: "2026-06-29T00:02:00.000Z",
        savedCheckoutInstruments: [
          {
            instrumentId: "sci_bank_1",
            paymentMethodCategory: "bank-account",
            displayLabel: "Bank ending in 6789",
            confirmationExperience: "off-session-token",
            readiness: "ready",
            checkoutEligible: true,
            isDefault: true,
            removedAt: null,
            createdAt: "2026-06-29T00:01:00.000Z",
            updatedAt: "2026-06-29T00:02:00.000Z",
          },
        ],
      }),
    );

    await handlers["payments.checkout-affordances-published"]!(
      event(1, {
        accountId: "acc_buyer",
        publishedAt: "2026-06-29T00:00:00.000Z",
        savedCheckoutInstruments: [
          {
            instrumentId: "sci_card_1",
            paymentMethodCategory: "card",
            displayLabel: "Visa ending in 4242",
            confirmationExperience: "trusted-payment-step",
            readiness: "ready",
            checkoutEligible: true,
            isDefault: true,
            removedAt: null,
            createdAt: "2026-06-28T00:00:00.000Z",
            updatedAt: "2026-06-29T00:00:00.000Z",
          },
        ],
      }),
    );

    expect([...db.rows.values()]).toEqual([
      expect.objectContaining({
        account_id: "acc_buyer",
        instrument_id: "sci_bank_1",
        payment_method_category: "bank-account",
        display_label: "Bank ending in 6789",
        checkout_eligible: true,
        is_default: true,
        last_stream_version: 2,
      }),
    ]);
  });
});
