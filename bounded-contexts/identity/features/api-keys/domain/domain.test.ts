import { describe, expect, it } from "vitest";
import { decideApiKey, evolveApiKey, initialApiKeyState } from "./domain";

describe("api key domain", () => {
  it("issue-7168-ac6-api-key-secret legacy secret commands retain private verifier authority with colliding prefixes", () => {
    const created = decideApiKey(initialApiKeyState, {
      type: "CreateApiKey",
      apiKeyId: "key_test" as never,
      userId: "usr_test" as never,
      name: "Automation",
      keyPrefix: "same_prefix",
      secretHash: "a".repeat(64),
    });
    expect(created.map((event) => event.type)).toEqual([
      "identity.api-key.created",
      "identity.api-key.verifier-recorded",
    ]);
    const state = created.reduce(evolveApiKey, initialApiKeyState);
    const rotated = decideApiKey(state, {
      type: "RotateApiKey",
      keyPrefix: "same_prefix",
      secretHash: "b".repeat(64),
    }).reduce(evolveApiKey, state);
    expect(rotated.verifierHash).toBe("b".repeat(64));
    expect(() =>
      decideApiKey(rotated, {
        type: "RecordApiKeyUse",
        usedAt: "2026-07-03T00:00:00.000Z",
        keyPrefix: "same_prefix",
        secretHash: "a".repeat(64),
      }),
    ).toThrow("API key verifier is stale.");
  });
  it("issue-7168-ac6-api-key-secret rejects a stale derived verifier even when prefixes collide", () => {
    const created = decideApiKey(initialApiKeyState, {
      type: "CreateApiKey",
      apiKeyId: "key_test" as never,
      userId: "usr_test" as never,
      name: "Automation",
      keyPrefix: "same_prefix",
    }).reduce(evolveApiKey, initialApiKeyState);
    const verified = evolveApiKey(created, {
      type: "identity.api-key.verifier-recorded",
      data: { keyPrefix: "same_prefix", secretHash: "a".repeat(64) },
    });
    const rotated = decideApiKey(verified, { type: "RotateApiKey", keyPrefix: "same_prefix" }).reduce(
      evolveApiKey,
      verified,
    );
    const current = evolveApiKey(rotated, {
      type: "identity.api-key.verifier-recorded",
      data: { keyPrefix: "same_prefix", secretHash: "b".repeat(64) },
    });
    expect(() =>
      decideApiKey(current, {
        type: "RecordApiKeyUse",
        usedAt: "2026-07-03T00:00:00.000Z",
        keyPrefix: "same_prefix",
        secretHash: "a".repeat(64),
      } as never),
    ).toThrow("API key verifier is stale.");
    expect(
      decideApiKey(current, {
        type: "RecordApiKeyUse",
        usedAt: "2026-07-03T00:00:00.000Z",
        keyPrefix: "same_prefix",
        secretHash: "b".repeat(64),
      } as never),
    ).toHaveLength(1);
    expect(() =>
      decideApiKey(current, {
        type: "RecordApiKeyUse",
        usedAt: "2026-07-03T00:00:00.000Z",
        keyPrefix: "other_prefix",
        secretHash: "b".repeat(64),
      } as never),
    ).toThrow("API key verifier is stale.");
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
