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
import {
  consumeAccountSelectionToken,
  consumeChallenge,
  consumeGuestCheckoutClaimToken,
  consumeMagicLinkToken,
  consumePhoneCodeToken,
  consumeSocialLoginState,
  insertAccountSelectionToken,
  insertChallenge,
  insertGuestCheckoutClaimToken,
  insertMagicLinkToken,
  insertPhoneCodeToken,
  insertSocialLoginState,
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
        consumePhoneCodeToken(pool, { phone: "+13125550101", codeHash: "hash_phone_once" }),
      ).resolves.toMatchObject({
        token_id: "cmd_phone_once",
        user_id: "usr_existing",
        phone: "+13125550101",
        code_hash: "hash_phone_once",
      });

      await expect(
        consumePhoneCodeToken(pool, { phone: "+13125550101", codeHash: "hash_phone_once" }),
      ).resolves.toBeNull();
      await expect(
        consumePhoneCodeToken(pool, { phone: "+13125550101", codeHash: "hash_missing" }),
      ).resolves.toBeNull();
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
        consumePhoneCodeToken(pool, { phone: "+13125550102", codeHash: "hash_phone_expired" }),
      ).resolves.toBeNull();
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
        consumePhoneCodeToken(pool, { phone: "+13125550103", codeHash: "hash_phone_race" }),
        consumePhoneCodeToken(pool, { phone: "+13125550103", codeHash: "hash_phone_race" }),
      ]);

      expectExactlyOneWinner(results);
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
