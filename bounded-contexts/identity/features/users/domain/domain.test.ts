import { describe, expect, it } from "vitest";
import { decideUser, evolveUser, initialUserState } from "./domain";
import { UserProfileFieldError } from "./errors";

function createdUserState() {
  return decideUser(initialUserState, {
    type: "CreateUser",
    userId: "usr_profile" as never,
    displayName: "North Seller",
    primaryEmail: "seller@example.com",
  }).reduce(evolveUser, initialUserState);
}

describe("user domain", () => {
  it.each(["", "   ", " \t "])("refuses a profile update whose display name is %j", (displayName) => {
    const refusal = (() => {
      try {
        decideUser(createdUserState(), { type: "UpdateUserProfile", displayName, givenName: "North" });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(refusal).toBeInstanceOf(UserProfileFieldError);
    expect(refusal).toMatchObject({ field: "displayName", code: "required" });
  });

  it("trims a profile update's names and keeps given and family names optional", () => {
    expect(decideUser(createdUserState(), { type: "UpdateUserProfile", displayName: "  South Seller " })).toEqual([
      { type: "identity.user.profile-updated", data: { displayName: "South Seller", givenName: "", familyName: "" } },
    ]);
  });

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
    const disabled = decideUser(enabledState, {
      type: "DisableAuthMethod",
      authMethod: "password",
    });
    const disabledState = disabled.reduce(evolveUser, enabledState);

    expect(enabledState.primaryEmail).toBe("seller@example.com");
    expect(enabledState.authMethods).toContain("password");
    expect(disabledState.authMethods).not.toContain("password");
    expect(
      decideUser(enabledState, {
        type: "EnableAuthMethod",
        authMethod: "password",
      }),
    ).toEqual([]);
    expect(
      decideUser(disabledState, {
        type: "DisableAuthMethod",
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
