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
  consumeMagicLinkToken,
  insertAccountSelectionToken,
  insertMagicLinkToken,
} from "./store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
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
    await expect(readConsumedAt("identity_magic_link_tokens", "token_hash", "hash_magic_expired")).resolves.toBeNull();
  });

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

  async function readConsumedAt(tableName: string, tokenColumn: string, tokenHash: string): Promise<string | null> {
    const result = await pool.query<{ consumed_at: string | null }>(
      `SELECT consumed_at FROM ${tableName} WHERE ${tokenColumn} = $1`,
      [tokenHash],
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
