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
    expect(
      decideUser(enabledState, {
        type: "EnableAuthMethod",
        authMethod: "password",
      }),
    ).toEqual([]);
  });

  it("links social login provider identities once per user", () => {
    const createdState = decideUser(initialUserState, {
      type: "CreateUser",
      userId: "usr_social" as never,
      displayName: "Social Buyer",
      primaryEmail: "social@example.com",
    }).reduce(evolveUser, initialUserState);

    const linked = decideUser(createdState, {
      type: "LinkSocialLogin",
      providerName: "google",
      providerSubject: "google-subject-1",
      email: "Social@Example.com",
      linkedAt: "2026-05-14T00:00:00.000Z",
    });
    const linkedState = linked.reduce(evolveUser, createdState);

    expect(linkedState.socialLoginLinks).toEqual([
      {
        providerName: "google",
        providerSubject: "google-subject-1",
        email: "social@example.com",
        linkedAt: "2026-05-14T00:00:00.000Z",
      },
    ]);
    expect(
      decideUser(linkedState, {
        type: "LinkSocialLogin",
        providerName: "google",
        providerSubject: "google-subject-1",
        email: "social@example.com",
        linkedAt: "2026-05-14T00:00:00.000Z",
      }),
    ).toEqual([]);
  });
});
