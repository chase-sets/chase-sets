import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createLinkedPlatformAuthorizationStore } from "./linked-platform-authorizations";

describe("agent-grant-revocation-authority private token owner lookup", () => {
  it.each(["synthetic-access-hash", "synthetic-refresh-hash"])(
    "keeps expired revoked %s recoverable without restoring token admission",
    async (tokenHash) => {
      const query = vi.fn(async (sql: string) => ({
        rows: sql.includes("status = 'active'")
          ? []
          : [
              {
                authorization_id: "grant_a",
                account_id: "acc_a",
                user_id: "usr_a",
                client_id: "client_a",
                platform_profile_url: "https://synthetic.example/profile",
                scopes: ["dev.ucp.shopping.order:read"],
                status: "revoked",
                access_token_hash: "synthetic-access-hash",
                refresh_token_hash: "synthetic-refresh-hash",
                access_token_expires_at: "2020-01-01T00:00:00.000Z",
                refresh_token_expires_at: "2020-01-01T00:00:00.000Z",
                granted_at: "2020-01-01T00:00:00.000Z",
                revoked_at: "2026-10-12T00:00:00.000Z",
                updated_at: "2026-10-12T00:00:00.000Z",
              },
            ],
        rowCount: 1,
      }));
      const store = createLinkedPlatformAuthorizationStore({ query, connect: vi.fn() } as PgTransactionalPool);
      expect(await store.resolveAccessToken(tokenHash)).toBeNull();
      expect(await store.resolveToken(tokenHash)).toBeNull();
      expect(await store.resolveRevocationToken(tokenHash)).toMatchObject({
        authorization_id: "grant_a",
        account_id: "acc_a",
        status: "revoked",
      });
      const sql = query.mock.calls.at(-1)![0];
      expect(sql).toContain("access_token_hash = $1 OR refresh_token_hash = $1");
      expect(sql).not.toContain("status = 'active'");
      expect(store.revokeToken).toBeTypeOf("function");
      expect(store.revokeAuthorization).toBeTypeOf("function");
    },
  );
});

describe("operator grant absolute expiry", () => {
  const row = {
    authorization_id: "grant_operator",
    account_id: "acc_operator",
    user_id: "usr_operator",
    client_id: "client_operator",
    platform_profile_url: "https://synthetic.example/profile",
    scopes: ["catalog:read", "operations:write"],
    status: "active",
    access_token_hash: "access_hash",
    refresh_token_hash: "refresh_hash",
    access_token_expires_at: "2026-01-07T01:00:00.000Z",
    refresh_token_expires_at: "2026-01-08T00:00:00.000Z",
    absolute_expires_at: "2026-01-08T00:00:00.000Z",
    granted_at: "2026-01-01T00:00:00.000Z",
    last_refreshed_at: null,
    refresh_token_rotated_at: null,
    revoked_at: null,
    revocation_reason: null,
    updated_at: "2026-01-07T00:00:00.000Z",
  };

  it("caps initial mixed-scope grant lifetimes at the supplied absolute expiry", async () => {
    const calls: Array<[string, readonly unknown[]]> = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push([sql, params]);
      return { rows: [row], rowCount: 1 };
    });
    const store = createLinkedPlatformAuthorizationStore({ query, connect: vi.fn() } as PgTransactionalPool);
    await store.grant({
      authorizationId: row.authorization_id,
      platformProfileUrl: row.platform_profile_url,
      clientId: row.client_id,
      userId: row.user_id,
      accountId: row.account_id,
      scopes: row.scopes,
      accessTokenHash: row.access_token_hash,
      refreshTokenHash: row.refresh_token_hash,
      accessTokenExpiresAt: "2026-01-01T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-01-31T00:00:00.000Z",
      absoluteExpiresAt: row.absolute_expires_at,
      grantedAt: row.granted_at,
    });
    const sql = calls[0]![0];
    expect(sql).toContain("LEAST($9::timestamptz, COALESCE($11::timestamptz, $9::timestamptz))");
    expect(sql).toContain("LEAST($10::timestamptz, COALESCE($11::timestamptz, $10::timestamptz))");
    expect(calls[0]![1]![10]).toBe(row.absolute_expires_at);
  });

  it("caps day-six refresh rotation and rejects bearer or refresh tokens after day seven", async () => {
    const query = vi.fn(async (sql: string, _params: readonly unknown[] = []) => ({ rows: [row], rowCount: 1 }));
    const store = createLinkedPlatformAuthorizationStore({ query, connect: vi.fn() } as PgTransactionalPool);
    await store.rotateRefreshToken({
      refreshTokenHash: row.refresh_token_hash,
      newAccessTokenHash: "rotated_access_hash",
      newRefreshTokenHash: "rotated_refresh_hash",
      accessTokenExpiresAt: "2026-01-07T01:00:00.000Z",
      refreshTokenExpiresAt: "2026-02-06T00:00:00.000Z",
      refreshedAt: "2026-01-07T00:00:00.000Z",
    });
    const rotateSql = query.mock.calls[0]![0] as string;
    expect(rotateSql).toContain("LEAST($4::timestamptz, COALESCE(absolute_expires_at, $4::timestamptz))");
    expect(rotateSql).toContain("LEAST($5::timestamptz, COALESCE(absolute_expires_at, $5::timestamptz))");

    query.mockImplementation(async (sql: string) => ({
      rows:
        sql.includes("access_token_expires_at > now()") || sql.includes("refresh_token_expires_at > now()")
          ? []
          : [row],
      rowCount: 0,
    }));
    await expect(store.resolveAccessToken(row.access_token_hash)).resolves.toBeNull();
    await expect(store.resolveToken(row.refresh_token_hash)).resolves.toBeNull();
    await expect(
      store.rotateRefreshToken({
        refreshTokenHash: row.refresh_token_hash,
        newAccessTokenHash: "expired_access_hash",
        newRefreshTokenHash: "expired_refresh_hash",
        accessTokenExpiresAt: "2026-01-08T01:00:00.000Z",
        refreshTokenExpiresAt: "2026-02-07T00:00:00.000Z",
        refreshedAt: "2026-01-08T00:00:00.001Z",
      }),
    ).resolves.toBeNull();
  });
});
