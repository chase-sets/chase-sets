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
});
