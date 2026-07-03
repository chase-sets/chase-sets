import { describe, expect, it } from "vitest";
import { decideApiKey, evolveApiKey, initialApiKeyState } from "./domain";

describe("api key domain", () => {
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
