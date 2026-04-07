import { describe, expect, it, vi } from "vitest";
import { upsertPasskeyCredential } from "../../../bounded-contexts/auth/auth-support/store";

describe("auth passkey persistence", () => {
  it("updates both the primary credential table and the lookup table", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await upsertPasskeyCredential(
      {
        query,
      } as never,
      {
        credentialId: "crd_1",
        userId: "usr_1",
        externalCredentialId: "ext_1",
        label: "Primary Key",
        publicKey: "public_key_1",
      },
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("identity_passkey_credentials");
    expect(query.mock.calls[1]?.[0]).toContain("identity_passkey_lookup");
  });
});
