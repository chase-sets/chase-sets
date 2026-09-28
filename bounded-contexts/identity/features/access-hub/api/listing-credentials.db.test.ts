import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { identitySchemaSql, identityListingAuthorityMigrations } from "../../../support/runtime-support/schema";
import { createIdentityCredentialStore } from "./listing-credentials";
import { identityLinkedPlatformAuthorizationSchemaSql } from "./linked-platform-authorizations";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for Identity credential DB proof.");

describe("Identity schema bootstrap", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, ["identity"], "identity_credential_bootstrap");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  it.each(["fresh", "upgraded"] as const)(
    "bootstraps and reboots a %s schema without losing credentials",
    async (state) => {
      if (state === "upgraded") {
        await pools.identity.query(`
        CREATE TABLE identity_api_key_secrets (
          api_key_id text PRIMARY KEY, user_id text NOT NULL, key_prefix text NOT NULL UNIQUE,
          secret_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        ${identityLinkedPlatformAuthorizationSchemaSql}
        INSERT INTO identity_api_key_secrets(api_key_id, user_id, key_prefix, secret_hash)
          VALUES ('synthetic-bootstrap-key', 'synthetic-user', 'synthetic-prefix', 'synthetic-key-hash');
        INSERT INTO identity_linked_platform_authorizations (
          authorization_id, platform_profile_url, client_id, user_id, account_id, status,
          access_token_hash, access_token_expires_at, granted_at
        ) VALUES (
          'synthetic-bootstrap-delegation', 'https://synthetic.example.test', 'synthetic-client',
          'synthetic-user', 'synthetic-account', 'active', 'synthetic-access-hash', '2099-01-01', '2026-01-01'
        );
      `);
      }

      await pools.identity.query(identitySchemaSql);
      await pools.identity.query(identitySchemaSql);

      const columns = await pools.identity.query(`
      SELECT table_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'authority_revision'
        AND table_name IN ('identity_api_key_secrets', 'identity_linked_platform_authorizations')
      ORDER BY table_name
    `);
      expect(columns.rows).toEqual([
        { table_name: "identity_api_key_secrets", data_type: "text", is_nullable: "YES" },
        { table_name: "identity_linked_platform_authorizations", data_type: "text", is_nullable: "YES" },
      ]);
      const indexes = await pools.identity.query(`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN ('identity_api_key_secrets_hash_idx', 'identity_listing_credential_pending_idx')
      ORDER BY indexname
    `);
      expect(indexes.rows).toEqual([
        { indexname: "identity_api_key_secrets_hash_idx" },
        { indexname: "identity_listing_credential_pending_idx" },
      ]);
      expect((await pools.identity.query("SELECT * FROM identity_listing_credential_mutations")).rows).toEqual([]);

      const store = createIdentityCredentialStore(pools.identity);
      const key = await store.readApiKey("synthetic-bootstrap-key");
      const delegation = await store.readDelegation("synthetic-bootstrap-delegation");
      if (state === "upgraded") {
        expect(key).toMatchObject({ secret_hash: "synthetic-key-hash", authority_revision: null });
        expect(delegation).toMatchObject({ access_token_hash: "synthetic-access-hash", authority_revision: null });
      } else {
        expect(key).toBeNull();
        expect(delegation).toBeNull();
      }
    },
  );
});

describe("Identity owner-local credential transaction", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl, ["identity"], "identity_listing_credentials");
    await ensureMultiContextTestDatabases(databaseUrl, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identitySchemaSql);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  const context = {
    tenantId: "tnt_synthetic_sql",
    audit: { performedByUserId: "usr_synthetic_sql", forAccountId: "acc_synthetic_sql" },
    trace: undefined,
  } as const;

  it("claims once under concurrency, survives reconstruction and cannot replace a later API key", async () => {
    const store = createIdentityCredentialStore(pools.identity);
    const input = {
      mutationId: "synthetic-key-1",
      context,
      command: {
        kind: "api-key-upsert",
        apiKeyId: "key_synthetic",
        userId: "usr_synthetic_sql",
        keyPrefix: "synthetic",
        secretHash: "synthetic-hash-1",
      },
    } as const;
    await store.stage(input);
    await store.stage(input);
    await expect(
      store.stage({ ...input, command: { ...input.command, secretHash: "synthetic-changed" } }),
    ).rejects.toThrow(/identity conflict/);
    await Promise.all([store.apply(input.mutationId), store.apply(input.mutationId)]);
    await store.stage({
      ...input,
      mutationId: "synthetic-key-2",
      command: { ...input.command, secretHash: "synthetic-hash-2" },
    });
    await store.apply("synthetic-key-2");
    await createIdentityCredentialStore(pools.identity).apply(input.mutationId);
    expect((await store.readApiKey("key_synthetic"))?.authority_revision).toBe("synthetic-key-2");
    expect(await store.authenticateApiKey("synthetic-hash-1")).toBeNull();
    await store.complete(input.mutationId);
    expect(await store.pending(1)).toEqual(["synthetic-key-2"]);
    expect(await store.pending(1, "synthetic-key-2")).toEqual([]);
  });

  it("replays the exact delegation result after a lost reply, with refresh CAS and no secret reversion", async () => {
    const store = createIdentityCredentialStore(pools.identity);
    const params = {
      authorizationId: "synthetic-delegation",
      userId: "usr_synthetic_sql",
      accountId: "acc_synthetic_sql",
      clientId: "synthetic-client",
      platformProfileUrl: "https://synthetic.example.test",
      scopes: ["listings:write"],
      accessTokenHash: "synthetic-access-1",
      refreshTokenHash: "synthetic-refresh-1",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      grantedAt: new Date().toISOString(),
    };
    await store.stage({ mutationId: "synthetic-grant", context, command: { kind: "delegation-grant", params } });
    await store.apply("synthetic-grant");
    const rotation = {
      mutationId: "synthetic-rotation",
      context,
      command: {
        kind: "delegation-rotate",
        authorizationId: params.authorizationId,
        params: {
          refreshTokenHash: "synthetic-refresh-1",
          newAccessTokenHash: "synthetic-access-2",
          newRefreshTokenHash: "synthetic-refresh-2",
          accessTokenExpiresAt: params.accessTokenExpiresAt,
          refreshTokenExpiresAt: params.refreshTokenExpiresAt,
          refreshedAt: new Date().toISOString(),
        },
      },
    } as const;
    await store.stage(rotation);
    const first = await store.apply(rotation.mutationId);
    expect(await createIdentityCredentialStore(pools.identity).apply(rotation.mutationId)).toEqual(first);
    await store.stage({ ...rotation, mutationId: "synthetic-stale-refresh" });
    expect(await store.apply("synthetic-stale-refresh")).toBeNull();
    expect((await store.readDelegation(params.authorizationId))?.authority_revision).toBe(rotation.mutationId);
    await store.stage({
      mutationId: "synthetic-revoke",
      context,
      command: {
        kind: "delegation-revoke",
        authorizationId: params.authorizationId,
        accountId: params.accountId,
        revokedAt: new Date().toISOString(),
        reason: "synthetic-revocation",
      },
    });
    expect(await store.apply("synthetic-revoke")).toBe(true);
    await store.apply(rotation.mutationId);
    expect((await store.readDelegation(params.authorizationId))?.status).toBe("revoked");
  });

  it("upgrades legacy rows without inventing authority and rolls back a failed credential claim", async () => {
    await pools.identity.query("ALTER TABLE identity_api_key_secrets DROP COLUMN authority_revision");
    await pools.identity.query(
      "INSERT INTO identity_api_key_secrets(api_key_id,user_id,key_prefix,secret_hash) VALUES ('key_synthetic_old','usr_synthetic_sql','synthetic-taken','synthetic-old')",
    );
    for (const migration of identityListingAuthorityMigrations)
      for (const statement of migration.statements) await pools.identity.query(statement);
    const store = createIdentityCredentialStore(pools.identity);
    expect((await store.readApiKey("key_synthetic_old"))?.authority_revision).toBeNull();
    await store.stage({
      mutationId: "synthetic-conflict",
      context,
      command: {
        kind: "api-key-upsert",
        apiKeyId: "key_synthetic_other",
        userId: "usr_synthetic_sql",
        keyPrefix: "synthetic-taken",
        secretHash: "synthetic-other",
      },
    });
    await expect(store.apply("synthetic-conflict")).rejects.toThrow();
    expect((await store.readMutation("synthetic-conflict"))?.applied).toBe(false);
    expect(await store.readApiKey("key_synthetic_other")).toBeNull();
  });
});
