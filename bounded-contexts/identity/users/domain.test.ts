import { describe, expect, it } from "vitest";
import { decideUser, evolveUser, initialUserState } from "./domain";

describe("user domain", () => {
  it("adds and verifies contact methods and auth methods", () => {
    const created = decideUser(initialUserState, {
      type: "CreateUser",
      userId: "usr_test" as never,
      displayName: "North Seller",
      primaryEmail: "seller@example.com",
    });
    const createdState = created.reduce(evolveUser, initialUserState);
    const enabled = decideUser(createdState, {
      type: "EnableAuthMethod",
      authMethod: "password",
    });
    const enabledState = enabled.reduce(evolveUser, createdState);

    expect(enabledState.primaryEmail).toBe("seller@example.com");
    expect(enabledState.authMethods).toContain("password");
  });
});
