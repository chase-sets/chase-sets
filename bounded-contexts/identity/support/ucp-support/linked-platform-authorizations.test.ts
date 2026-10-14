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
                scopes: ["order:read"],
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
