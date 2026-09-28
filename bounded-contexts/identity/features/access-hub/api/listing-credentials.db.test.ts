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

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for Identity credential DB proof.");

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
