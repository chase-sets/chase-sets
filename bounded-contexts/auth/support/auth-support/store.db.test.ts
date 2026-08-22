import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { authSchemaSql } from "../runtime-support/schema";
import { createPostgresAgentWebhookOutbox } from "../ucp-support/agent-webhooks/agent-webhook-outbox";
import {
  bindGuestCheckoutContact,
  consumeAccountSelectionToken,
  consumeChallenge,
  consumeGuestCheckoutClaimToken,
  consumeMagicLinkToken,
  consumeSocialLoginState,
  getGuestCheckoutTokenByHash,
  insertAccountSelectionToken,
  insertChallenge,
  insertGuestCheckoutClaimToken,
  insertMagicLinkToken,
  insertPhoneCodeToken,
  insertSocialLoginState,
  upsertGuestCheckoutToken,
  verifyPhoneCodeToken,
} from "./store";

// phantom-SQL rule: exercised against a real Postgres sandbox
// (TEST_DATABASE_URL, see .env.sandbox.local / dev:bootstrap), never mocked.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["auth"] as const;

describeDb("auth token store persistence boundary", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(requireDatabaseBaseUrl(), contextNames, "auth_token_store");
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.auth;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ auth: pool });
    await pool.query(authSchemaSql);
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  describe("agent webhook outbox", () => {
    it("durably deduplicates an identical per-client event and order delivery", async () => {
      const outbox = createPostgresAgentWebhookOutbox({
        db: pool,
        now: () => new Date("2026-07-08T00:00:00.000Z"),
      });
      const delivery = {
        clientId: "ocl_1",
        accountId: "acc_buyer",
        callbackUrl: "https://agent.example/hooks",
        sourceEventId: "evt_1",
        eventType: "fulfillment.shipment.dispatched",
        orderId: "ord_1",
        orderStatus: "shipped",
        payloadJson: '{"type":"order.updated"}',
        idempotencyKey: "ocl_1:evt_1:ord_1",
      } as const;

      await outbox.enqueueDelivery(delivery);
      await outbox.enqueueDelivery(delivery);

      const persisted = await pool.query<{ status: string; attempt_count: number }>(
        `SELECT status, attempt_count
         FROM identity_agent_webhook_deliveries
         WHERE idempotency_key = $1`,
        [delivery.idempotencyKey],
      );
      expect(persisted.rows).toEqual([{ status: "pending", attempt_count: 0 }]);
    });
  });

  describe("magic link tokens", () => {
    it("consumes a magic link token exactly once through the stored SQL predicate", async () => {
      await insertMagicLinkToken(pool, {
        tokenId: "cmd_magic_once",
        userId: "usr_existing",
        email: "buyer@example.com",
        tokenHash: "hash_magic_once",
        deliveryToken: "delivery_magic_once",
        expiresAt: futureIso(),
      });

      await expect(consumeMagicLinkToken(pool, "hash_magic_once")).resolves.toMatchObject({
        token_id: "cmd_magic_once",
        user_id: "usr_existing",
        email: "buyer@example.com",
        token_hash: "hash_magic_once",
      });

      await expect(consumeMagicLinkToken(pool, "hash_magic_once")).resolves.toBeNull();
      await expect(consumeMagicLinkToken(pool, "hash_missing")).resolves.toBeNull();
    });

    it("rejects expired magic link tokens without consuming them", async () => {
      await insertMagicLinkToken(pool, {
        tokenId: "cmd_magic_expired",
        userId: "usr_existing",
        email: "buyer@example.com",
        tokenHash: "hash_magic_expired",
        deliveryToken: "delivery_magic_expired",
        expiresAt: pastIso(),
      });

      await expect(consumeMagicLinkToken(pool, "hash_magic_expired")).resolves.toBeNull();
      await expect(
        readConsumedAt("identity_magic_link_tokens", "token_hash", "hash_magic_expired"),
      ).resolves.toBeNull();
    });

    it("lets exactly one concurrent consumer win a magic link token race", async () => {
      await insertMagicLinkToken(pool, {
        tokenId: "cmd_magic_race",
        userId: "usr_existing",
        email: "buyer@example.com",
        tokenHash: "hash_magic_race",
        deliveryToken: "delivery_magic_race",
        expiresAt: futureIso(),
      });

      const results = await Promise.all([
        consumeMagicLinkToken(pool, "hash_magic_race"),
        consumeMagicLinkToken(pool, "hash_magic_race"),
      ]);

      expectExactlyOneWinner(results);
    });
  });

  describe("phone code tokens", () => {
    it("invalidates a phone code after five failed verification attempts", async () => {
      await insertPhoneCodeToken(pool, {
        tokenId: "cmd_phone_attempt_cap",
        userId: "usr_existing",
        phone: "+13125550100",
        codeHash: "hash_phone_correct",
        deliveryCode: "123456",
        expiresAt: futureIso(),
      });

      for (let attempt = 1; attempt < 5; attempt += 1) {
        await expect(
          verifyPhoneCodeToken(pool, {
            tokenId: "cmd_phone_attempt_cap",
            phone: "+13125550100",
            codeHash: `hash_phone_wrong_${attempt}`,
            maxFailedAttempts: 5,
          }),
        ).resolves.toEqual({ status: "rejected", invalidated: false });
      }

      await expect(
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_attempt_cap",
          phone: "+13125550100",
          codeHash: "hash_phone_wrong_5",
          maxFailedAttempts: 5,
        }),
      ).resolves.toEqual({ status: "rejected", invalidated: true });

      await expect(
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_attempt_cap",
          phone: "+13125550100",
          codeHash: "hash_phone_correct",
          maxFailedAttempts: 5,
        }),
      ).resolves.toEqual({ status: "rejected", invalidated: false });

      const stored = await pool.query<{
        failed_attempt_count: number;
        invalidated_at: string | null;
        delivery_code: string | null;
      }>(
        `SELECT failed_attempt_count, invalidated_at, delivery_code
         FROM identity_phone_code_tokens
         WHERE token_id = $1`,
        ["cmd_phone_attempt_cap"],
      );
      expect(stored.rows[0]).toMatchObject({
        failed_attempt_count: 5,
        invalidated_at: expect.any(Date),
        delivery_code: null,
      });
    });

    it("consumes a phone code token exactly once through the stored SQL predicate", async () => {
      await insertPhoneCodeToken(pool, {
        tokenId: "cmd_phone_once",
        userId: "usr_existing",
        phone: "+13125550101",
        codeHash: "hash_phone_once",
        deliveryCode: "123456",
        expiresAt: futureIso(),
      });

      await expect(
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_once",
          phone: "+13125550101",
          codeHash: "hash_phone_once",
          maxFailedAttempts: 5,
        }),
      ).resolves.toMatchObject({
        status: "verified",
        token: {
          token_id: "cmd_phone_once",
          user_id: "usr_existing",
          phone: "+13125550101",
          code_hash: "hash_phone_once",
        },
      });

      await expect(
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_once",
          phone: "+13125550101",
          codeHash: "hash_phone_once",
          maxFailedAttempts: 5,
        }),
      ).resolves.toEqual({ status: "rejected", invalidated: false });
      await expect(
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_once",
          phone: "+13125550101",
          codeHash: "hash_missing",
          maxFailedAttempts: 5,
        }),
      ).resolves.toEqual({ status: "rejected", invalidated: false });
    });

    it("rejects expired phone code tokens without consuming them", async () => {
      await insertPhoneCodeToken(pool, {
        tokenId: "cmd_phone_expired",
        userId: "usr_existing",
        phone: "+13125550102",
        codeHash: "hash_phone_expired",
        deliveryCode: "654321",
        expiresAt: pastIso(),
      });

      await expect(
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_expired",
          phone: "+13125550102",
          codeHash: "hash_phone_expired",
          maxFailedAttempts: 5,
        }),
      ).resolves.toEqual({ status: "rejected", invalidated: false });
      await expect(readConsumedAt("identity_phone_code_tokens", "code_hash", "hash_phone_expired")).resolves.toBeNull();
    });

    it("lets exactly one concurrent consumer win a phone code token race", async () => {
      await insertPhoneCodeToken(pool, {
        tokenId: "cmd_phone_race",
        userId: "usr_existing",
        phone: "+13125550103",
        codeHash: "hash_phone_race",
        deliveryCode: "111222",
        expiresAt: futureIso(),
      });

      const results = await Promise.all([
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_race",
          phone: "+13125550103",
          codeHash: "hash_phone_race",
          maxFailedAttempts: 5,
        }),
        verifyPhoneCodeToken(pool, {
          tokenId: "cmd_phone_race",
          phone: "+13125550103",
          codeHash: "hash_phone_race",
          maxFailedAttempts: 5,
        }),
      ]);

      expect(results.filter((result) => result.status === "verified")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    });
  });

  describe("auth challenges (passkey / sign-in challenges)", () => {
    it("consumes a challenge exactly once through the stored SQL predicate", async () => {
      await insertChallenge(pool, {
        challengeId: "cmd_challenge_once",
        purpose: "passkey-register",
        email: "owner@example.com",
        userId: null,
        challengeValue: "challenge_once",
        expiresAt: futureIso(),
      });

      await expect(
        consumeChallenge(pool, {
          challengeId: "cmd_challenge_once",
          purpose: "passkey-register",
          challengeValue: "challenge_once",
        }),
      ).resolves.toMatchObject({
        challenge_id: "cmd_challenge_once",
        purpose: "passkey-register",
        challenge_value: "challenge_once",
      });

      await expect(
        consumeChallenge(pool, {
          challengeId: "cmd_challenge_once",
          purpose: "passkey-register",
          challengeValue: "challenge_once",
        }),
      ).resolves.toBeNull();
      await expect(
        consumeChallenge(pool, {
          challengeId: "cmd_challenge_missing",
          purpose: "passkey-register",
          challengeValue: "challenge_once",
        }),
      ).resolves.toBeNull();
    });

    it("rejects expired challenges without consuming them", async () => {
      await insertChallenge(pool, {
        challengeId: "cmd_challenge_expired",
        purpose: "passkey-sign-in",
        email: "owner@example.com",
        userId: "usr_owner",
        challengeValue: "challenge_expired",
        expiresAt: pastIso(),
      });

      await expect(
        consumeChallenge(pool, {
          challengeId: "cmd_challenge_expired",
          purpose: "passkey-sign-in",
          challengeValue: "challenge_expired",
        }),
      ).resolves.toBeNull();
      await expect(
        readConsumedAt("identity_auth_challenges", "challenge_id", "cmd_challenge_expired"),
      ).resolves.toBeNull();
    });

    it("lets exactly one concurrent consumer win a challenge race", async () => {
      await insertChallenge(pool, {
        challengeId: "cmd_challenge_race",
        purpose: "passkey-sign-in",
        email: "owner@example.com",
        userId: "usr_owner",
        challengeValue: "challenge_race",
        expiresAt: futureIso(),
      });

      const consumeParams = {
        challengeId: "cmd_challenge_race",
        purpose: "passkey-sign-in",
        challengeValue: "challenge_race",
      } as const;
      const results = await Promise.all([consumeChallenge(pool, consumeParams), consumeChallenge(pool, consumeParams)]);

      expectExactlyOneWinner(results);
    });
  });

  describe("social login states", () => {
    it("consumes a social login state exactly once through the stored SQL predicate", async () => {
      await insertSocialLoginState(pool, {
        stateHash: "hash_social_once",
        providerName: "google",
        journey: "sign-in",
        returnTo: "/account",
        expiresAt: futureIso(),
      });

      await expect(
        consumeSocialLoginState(pool, { stateHash: "hash_social_once", providerName: "google" }),
      ).resolves.toMatchObject({
        state_hash: "hash_social_once",
        provider_name: "google",
        journey: "sign-in",
        return_to: "/account",
      });

      await expect(
        consumeSocialLoginState(pool, { stateHash: "hash_social_once", providerName: "google" }),
      ).resolves.toBeNull();
      await expect(
        consumeSocialLoginState(pool, { stateHash: "hash_missing", providerName: "google" }),
      ).resolves.toBeNull();
    });

    it("rejects expired social login states without consuming them", async () => {
      await insertSocialLoginState(pool, {
        stateHash: "hash_social_expired",
        providerName: "google",
        journey: "sign-in",
        returnTo: "/account",
        expiresAt: pastIso(),
      });

      await expect(
        consumeSocialLoginState(pool, { stateHash: "hash_social_expired", providerName: "google" }),
      ).resolves.toBeNull();
      await expect(
        readConsumedAt("identity_social_login_states", "state_hash", "hash_social_expired"),
      ).resolves.toBeNull();
    });

    it("lets exactly one concurrent consumer win a social login state race", async () => {
      await insertSocialLoginState(pool, {
        stateHash: "hash_social_race",
        providerName: "google",
        journey: "sign-in",
        returnTo: "/account",
        expiresAt: futureIso(),
      });

      const consumeParams = { stateHash: "hash_social_race", providerName: "google" } as const;
      const results = await Promise.all([
        consumeSocialLoginState(pool, consumeParams),
        consumeSocialLoginState(pool, consumeParams),
      ]);

      expectExactlyOneWinner(results);
    });
  });

  describe("account-selection continuation tokens", () => {
    it("consumes an account-selection continuation token exactly once through the stored SQL predicate", async () => {
      await insertAccountSelectionToken(pool, {
        tokenId: "cmd_account_select_once",
        userId: "usr_existing",
        authenticationMethod: "magic-link",
        tokenHash: "hash_account_select_once",
        expiresAt: futureIso(),
      });

      await expect(consumeAccountSelectionToken(pool, "hash_account_select_once")).resolves.toMatchObject({
        token_id: "cmd_account_select_once",
        user_id: "usr_existing",
        authentication_method: "magic-link",
        token_hash: "hash_account_select_once",
      });

      await expect(consumeAccountSelectionToken(pool, "hash_account_select_once")).resolves.toBeNull();
      await expect(consumeAccountSelectionToken(pool, "hash_missing")).resolves.toBeNull();
    });

    it("rejects expired account-selection tokens without consuming them", async () => {
      await insertAccountSelectionToken(pool, {
        tokenId: "cmd_account_select_expired",
        userId: "usr_existing",
        authenticationMethod: "password",
        tokenHash: "hash_account_select_expired",
        expiresAt: pastIso(),
      });

      await expect(consumeAccountSelectionToken(pool, "hash_account_select_expired")).resolves.toBeNull();
      await expect(
        readConsumedAt("identity_account_selection_tokens", "token_hash", "hash_account_select_expired"),
      ).resolves.toBeNull();
    });

    it("lets exactly one concurrent consumer win an account-selection token race", async () => {
      await insertAccountSelectionToken(pool, {
        tokenId: "cmd_account_select_race",
        userId: "usr_existing",
        authenticationMethod: "password",
        tokenHash: "hash_account_select_race",
        expiresAt: futureIso(),
      });

      const results = await Promise.all([
        consumeAccountSelectionToken(pool, "hash_account_select_race"),
        consumeAccountSelectionToken(pool, "hash_account_select_race"),
      ]);

      expectExactlyOneWinner(results);
    });
  });

  describe("guest checkout tokens", () => {
    it("persists and reads nullable guest checkout contact", async () => {
      await upsertGuestCheckoutToken(pool, {
        tokenId: "cmd_guest_without_contact",
        accountId: "acc_guest_without_contact",
        contactEmail: null,
        contactName: null,
        tokenHash: "hash_guest_without_contact",
        expiresAt: futureIso(),
      });

      await expect(getGuestCheckoutTokenByHash(pool, "hash_guest_without_contact")).resolves.toMatchObject({
        token_id: "cmd_guest_without_contact",
        account_id: "acc_guest_without_contact",
        contact_email: null,
        contact_name: null,
      });

      await upsertGuestCheckoutToken(pool, {
        tokenId: "cmd_guest_legacy_empty_contact",
        accountId: "acc_guest_legacy_empty_contact",
        contactEmail: "",
        contactName: "   ",
        tokenHash: "hash_guest_legacy_empty_contact",
        expiresAt: futureIso(),
      });
      await expect(
        bindGuestCheckoutContact(pool, {
          tokenHash: "hash_guest_legacy_empty_contact",
          accountId: "acc_guest_legacy_empty_contact",
          contactEmail: "bound@example.com",
          contactName: "Bound Buyer",
        }),
      ).resolves.toMatchObject({
        contact_email: "bound@example.com",
        contact_name: "Bound Buyer",
      });
    });

    it("converges populated guest checkout tokens from NOT NULL contact to nullable contact", async () => {
      await resetMultiContextTestSchemas({ auth: pool });
      await pool.query(`CREATE TABLE identity_guest_checkout_tokens (
        token_id text PRIMARY KEY,
        account_id text NOT NULL,
        contact_email text NOT NULL,
        contact_name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
      await pool.query(
        `INSERT INTO identity_guest_checkout_tokens (
          token_id, account_id, contact_email, contact_name, token_hash, expires_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "cmd_guest_legacy",
          "acc_guest_legacy",
          "Legacy.Buyer@Example.com",
          " Legacy Buyer ",
          "hash_guest_legacy",
          "2030-01-02T03:04:05.000Z",
          "2025-02-03T04:05:06.000Z",
          "2025-02-04T05:06:07.000Z",
        ],
      );
      const digestBefore = await legacyGuestCheckoutRowDigest();

      // The boot-schema extractor only recognizes exported *SchemaSql template literals.
      // authSchemaSql is an exported array join, so this populated real-PostgreSQL case is the convergence proof.
      await pool.query(authSchemaSql);

      const columns = await pool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'identity_guest_checkout_tokens'
           AND column_name IN ('contact_email', 'contact_name')
         ORDER BY column_name`,
      );
      expect(columns.rows).toEqual([
        { column_name: "contact_email", is_nullable: "YES" },
        { column_name: "contact_name", is_nullable: "YES" },
      ]);
      await expect(legacyGuestCheckoutRowDigest()).resolves.toBe(digestBefore);

      await upsertGuestCheckoutToken(pool, {
        tokenId: "cmd_guest_converged_null",
        accountId: "acc_guest_converged_null",
        contactEmail: null,
        contactName: null,
        tokenHash: "hash_guest_converged_null",
        expiresAt: futureIso(),
      });
      await expect(getGuestCheckoutTokenByHash(pool, "hash_guest_converged_null")).resolves.toMatchObject({
        contact_email: null,
        contact_name: null,
      });
    });

    it("serializes competing first Guest Contact binds", async () => {
      await upsertGuestCheckoutToken(pool, {
        tokenId: "cmd_guest_contact_race",
        accountId: "acc_guest_contact_race",
        contactEmail: null,
        contactName: null,
        tokenHash: "hash_guest_contact_race",
        expiresAt: futureIso(),
      });

      const results = await Promise.all([
        bindGuestCheckoutContact(pool, {
          tokenHash: "hash_guest_contact_race",
          accountId: "acc_guest_contact_race",
          contactEmail: "first@example.com",
          contactName: "First Buyer",
        }),
        bindGuestCheckoutContact(pool, {
          tokenHash: "hash_guest_contact_race",
          accountId: "acc_guest_contact_race",
          contactEmail: "second@example.com",
          contactName: "Second Buyer",
        }),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.find((result) => result !== null);
      await expect(getGuestCheckoutTokenByHash(pool, "hash_guest_contact_race")).resolves.toMatchObject({
        contact_email: winner?.contact_email,
        contact_name: winner?.contact_name,
      });
    });
  });

  describe("guest checkout claim tokens", () => {
    it("consumes a guest checkout claim token exactly once through the stored SQL predicate", async () => {
      await insertGuestCheckoutClaimToken(pool, {
        tokenId: "cmd_guest_claim_once",
        accountId: "acc_guest",
        paymentId: "pay_1",
        email: "buyer@example.com",
        displayName: "Buyer Example",
        tokenHash: "hash_guest_claim_once",
        continuationHash: "hash_guest_claim_once_continuation",
        expiresAt: futureIso(),
      });
      const consumeParams = {
        tokenHash: "hash_guest_claim_once",
        accountId: "acc_guest",
        paymentId: "pay_1",
        email: "buyer@example.com",
      } as const;

      await expect(consumeGuestCheckoutClaimToken(pool, consumeParams)).resolves.toMatchObject({
        token_id: "cmd_guest_claim_once",
        account_id: "acc_guest",
        payment_id: "pay_1",
        email: "buyer@example.com",
      });

      await expect(consumeGuestCheckoutClaimToken(pool, consumeParams)).resolves.toBeNull();
      await expect(
        consumeGuestCheckoutClaimToken(pool, { ...consumeParams, tokenHash: "hash_missing" }),
      ).resolves.toBeNull();
    });

    it("rejects expired guest checkout claim tokens without consuming them", async () => {
      await insertGuestCheckoutClaimToken(pool, {
        tokenId: "cmd_guest_claim_expired",
        accountId: "acc_guest",
        paymentId: "pay_2",
        email: "buyer@example.com",
        displayName: "Buyer Example",
        tokenHash: "hash_guest_claim_expired",
        continuationHash: "hash_guest_claim_expired_continuation",
        expiresAt: pastIso(),
      });

      await expect(
        consumeGuestCheckoutClaimToken(pool, {
          tokenHash: "hash_guest_claim_expired",
          accountId: "acc_guest",
          paymentId: "pay_2",
          email: "buyer@example.com",
        }),
      ).resolves.toBeNull();
      await expect(
        readConsumedAt("identity_guest_checkout_claim_tokens", "token_hash", "hash_guest_claim_expired"),
      ).resolves.toBeNull();
    });

    it("lets exactly one concurrent consumer win a guest checkout claim token race", async () => {
      await insertGuestCheckoutClaimToken(pool, {
        tokenId: "cmd_guest_claim_race",
        accountId: "acc_guest",
        paymentId: "pay_3",
        email: "buyer@example.com",
        displayName: "Buyer Example",
        tokenHash: "hash_guest_claim_race",
        continuationHash: "hash_guest_claim_race_continuation",
        expiresAt: futureIso(),
      });
      const consumeParams = {
        tokenHash: "hash_guest_claim_race",
        accountId: "acc_guest",
        paymentId: "pay_3",
        email: "buyer@example.com",
      } as const;

      const results = await Promise.all([
        consumeGuestCheckoutClaimToken(pool, consumeParams),
        consumeGuestCheckoutClaimToken(pool, consumeParams),
      ]);

      expectExactlyOneWinner(results);
    });
  });

  async function readConsumedAt(tableName: string, tokenColumn: string, tokenValue: string): Promise<string | null> {
    const result = await pool.query<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM ${tableName} WHERE ${tokenColumn} = $1`,
      [tokenValue],
    );
    return result.rows[0]?.consumed_at ?? null;
  }

  async function legacyGuestCheckoutRowDigest(): Promise<string> {
    const result = await pool.query<{ digest: string }>(
      `SELECT md5(row_to_json(token_row)::text) AS digest
       FROM identity_guest_checkout_tokens AS token_row
       WHERE token_id = 'cmd_guest_legacy'`,
    );
    const digest = result.rows[0]?.digest;
    if (!digest) {
      throw new Error("Expected the populated legacy guest checkout token row.");
    }
    return digest;
  }
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for auth token store DB tests.");
  }

  return databaseBaseUrl;
}

function futureIso(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function pastIso(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

/**
 * Asserts a `Promise.all` double-consume race resolved with exactly one
 * non-null winner -- the invariant the stored `consumed_at IS NULL` SQL
 * predicate exists to guarantee under concurrent single-use token redemption.
 */
function expectExactlyOneWinner(results: readonly (object | null)[]): void {
  const winners = results.filter((result): result is object => result !== null);
  expect(winners).toHaveLength(1);
}
