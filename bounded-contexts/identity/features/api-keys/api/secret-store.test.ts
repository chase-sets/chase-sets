import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { upsertApiKeySecret } from "./secret-store";

describe("issue-7168-ac6-api-key-secret", () => {
  it("locks the committed owner version before updating a legacy derived verifier", async () => {
    const query = vi.fn<PgQueryable["query"]>(async () => ({ rows: [] }));
    await upsertApiKeySecret(
      { query },
      {
        apiKeyId: "key_synthetic7168",
        userId: "usr_synthetic7168",
        keyPrefix: "same_prefix",
        secretHash: "a".repeat(64),
        expectedVersion: 4,
      },
    );
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/WITH current_owner AS MATERIALIZED/);
    expect(sql).toMatch(/current_version = \$6\s+FOR UPDATE/);
    expect(sql).toMatch(/FROM current_owner/);
    expect(values).toEqual([
      "key_synthetic7168",
      "usr_synthetic7168",
      "same_prefix",
      "a".repeat(64),
      "identity.api-key-key_synthetic7168",
      4,
    ]);
  });
});
