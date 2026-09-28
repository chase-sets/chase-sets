import { describe, expect, it } from "vitest";
import { decideApiKey, evolveApiKey, initialApiKeyState, type ApiKeyListingScope } from "./domain";

describe("api key domain", () => {
  it("retains the exact Listing scope through rotation and refuses unscoped use", () => {
    const listingScope = {
      accountId: "acc_fixture",
      membershipId: "mbr_fixture",
      permissions: ["listings.manage"],
      expiresAt: "2026-09-28T23:00:00.000Z",
    } as const;
    const created = decideApiKey(initialApiKeyState, {
      type: "CreateApiKey",
      apiKeyId: "key_fixture" as never,
      userId: "usr_fixture" as never,
      name: "Fixture",
      keyPrefix: "prefix",
      listingScope,
    });
    const state = created.reduce(evolveApiKey, initialApiKeyState);
    const rotated = decideApiKey(state, { type: "RotateApiKey", keyPrefix: "next" }).reduce(evolveApiKey, state);
    expect(rotated.listingScope).toEqual(listingScope);
    expect(() => decideApiKey(rotated, { type: "RecordApiKeyUse", usedAt: "2026-09-28T22:00:00.000Z" })).toThrow(
      "scoped principal resolution",
    );
    expect(decideApiKey(rotated, { type: "RevokeApiKey" }).reduce(evolveApiKey, rotated).status).toBe("revoked");
  });

  it.each([
    { accountId: " " },
    { membershipId: "" },
    { expiresAt: "invalid" },
    { permissions: [] },
    { permissions: ["security.manage"] },
    { permissions: ["listings.manage", "security.manage"] },
  ])("rejects malformed Listing scope %j", (override) => {
    const listingScope = {
      accountId: "acc_fixture",
      membershipId: "mbr_fixture",
      permissions: ["listings.manage"],
      expiresAt: "2026-09-28T23:00:00.000Z",
      ...override,
    } as ApiKeyListingScope;
    expect(() =>
      decideApiKey(initialApiKeyState, {
        type: "CreateApiKey",
        apiKeyId: "key_fixture" as never,
        userId: "usr_fixture" as never,
        name: "Fixture",
        keyPrefix: "prefix",
        listingScope,
      }),
    ).toThrow("one account, membership, permission and expiry");
  });

  it("rotates and revokes an api key", () => {
    const created = decideApiKey(initialApiKeyState, {
      type: "CreateApiKey",
      apiKeyId: "key_test" as never,
      userId: "usr_test" as never,
      name: "Automation",
      keyPrefix: "prefix_one",
    });
    const createdState = created.reduce(evolveApiKey, initialApiKeyState);
    const rotated = decideApiKey(createdState, {
      type: "RotateApiKey",
      keyPrefix: "prefix_two",
    });
    const rotatedState = rotated.reduce(evolveApiKey, createdState);

    expect(rotatedState.keyPrefix).toBe("prefix_two");
  });

  it("rejects use recording after an api key is revoked", () => {
    const created = decideApiKey(initialApiKeyState, {
      type: "CreateApiKey",
      apiKeyId: "key_test" as never,
      userId: "usr_test" as never,
      name: "Automation",
      keyPrefix: "prefix_one",
    });
    const createdState = created.reduce(evolveApiKey, initialApiKeyState);
    const revoked = decideApiKey(createdState, { type: "RevokeApiKey" });
    const revokedState = revoked.reduce(evolveApiKey, createdState);

    expect(() =>
      decideApiKey(revokedState, {
        type: "RecordApiKeyUse",
        usedAt: "2026-07-03T00:00:00.000Z",
      }),
    ).toThrow("Only active API keys can change.");
  });
});
