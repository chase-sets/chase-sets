import { describe, expect, it } from "vitest";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildCheckoutIdentitySellerAccountsProjectionHandlers, createSellerSlug } from "./identity-projection";

type SellerAccountRow = {
  account_id: string;
  display_name: string;
  slug: string;
  last_stream_version: number;
};

/**
 * In-memory fake `PgQueryable` that interprets the identity seller-accounts
 * projection SQL by statement shape. It applies the `last_stream_version`
 * guard so replay / out-of-order delivery converges to the newest profile.
 */
class IdentityProjectionDb implements PgQueryable {
  public readonly accounts = new Map<string, SellerAccountRow>();

  async query<Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PgQueryResult<Row>> {
    if (sql.includes("INSERT INTO checkout_seller_accounts")) {
      const accountId = String(values[0]);
      const displayName = String(values[1]);
      const slug = String(values[2]);
      const streamVersion = Number(values[3]);
      const existing = this.accounts.get(accountId);
      if (!existing || existing.last_stream_version < streamVersion) {
        this.accounts.set(accountId, {
          account_id: accountId,
          display_name: displayName,
          slug,
          last_stream_version: streamVersion,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    throw new Error(`Unexpected query: ${sql}`);
  }
}

function event(
  type: string,
  streamVersion: number,
  data: Record<string, unknown>,
  streamId = "identity.account-acc_1",
): TransportEvent {
  return buildTransportEvent(type, data, {
    id: "evt_1",
    streamId,
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: "acc_1" },
    timing: { occurredAt: "2026-06-17T00:00:00.000Z", recordedAt: "2026-06-17T00:00:00.000Z" },
  });
}

describe("checkout identity seller-accounts projection", () => {
  it("stores display name and slug on account.created", async () => {
    const db = new IdentityProjectionDb();
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(db);

    await handlers["identity.account.created"]!(
      event("identity.account.created", 1, {
        accountId: "acc_1",
        name: "Card Vault LLC",
        displayName: "Card Vault",
        accountType: "individual",
      }),
    );

    expect(db.accounts.get("acc_1")).toMatchObject({
      account_id: "acc_1",
      display_name: "Card Vault",
      slug: createSellerSlug("Card Vault", "acc_1"),
      last_stream_version: 1,
    });
  });

  it("propagates a renamed display name and slug on profile-updated", async () => {
    const db = new IdentityProjectionDb();
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(db);

    await handlers["identity.account.created"]!(
      event("identity.account.created", 1, {
        accountId: "acc_1",
        name: "Card Vault LLC",
        displayName: "Card Vault",
        accountType: "individual",
      }),
    );
    await handlers["identity.account.profile-updated"]!(
      event("identity.account.profile-updated", 2, {
        name: "Hobby Shop LLC",
        displayName: "Hobby Shop",
      }),
    );

    expect(db.accounts.get("acc_1")).toMatchObject({
      display_name: "Hobby Shop",
      slug: createSellerSlug("Hobby Shop", "acc_1"),
      last_stream_version: 2,
    });
  });

  it("resolves the account id from the stream id on profile-updated", async () => {
    const db = new IdentityProjectionDb();
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(db);

    await handlers["identity.account.profile-updated"]!(
      event(
        "identity.account.profile-updated",
        5,
        { name: "Late Seller LLC", displayName: "Late Seller" },
        "identity.account-acc_late",
      ),
    );

    expect(db.accounts.get("acc_late")).toMatchObject({
      account_id: "acc_late",
      display_name: "Late Seller",
      last_stream_version: 5,
    });
  });

  it("is idempotent under replay and ignores stale (older) profile events", async () => {
    const db = new IdentityProjectionDb();
    const handlers = buildCheckoutIdentitySellerAccountsProjectionHandlers(db);

    await handlers["identity.account.created"]!(
      event("identity.account.created", 1, {
        accountId: "acc_1",
        name: "Card Vault LLC",
        displayName: "Card Vault",
        accountType: "individual",
      }),
    );
    await handlers["identity.account.profile-updated"]!(
      event("identity.account.profile-updated", 3, { name: "New Name LLC", displayName: "New Name" }),
    );

    // Replaying the create (older stream version) must not regress the newer name.
    await handlers["identity.account.created"]!(
      event("identity.account.created", 1, {
        accountId: "acc_1",
        name: "Card Vault LLC",
        displayName: "Card Vault",
        accountType: "individual",
      }),
    );

    expect(db.accounts.get("acc_1")).toMatchObject({
      display_name: "New Name",
      last_stream_version: 3,
    });
  });

  it("slugifies diacritics and ampersands deterministically", () => {
    expect(createSellerSlug("Café & Bar", "acc_1")).toContain("cafe-and-bar-");
    // Same display name + account id always yields the same slug.
    expect(createSellerSlug("Card Vault", "acc_1")).toEqual(createSellerSlug("Card Vault", "acc_1"));
    // Different accounts disambiguate the suffix even with the same name.
    expect(createSellerSlug("Card Vault", "acc_1")).not.toEqual(createSellerSlug("Card Vault", "acc_2"));
  });
});
