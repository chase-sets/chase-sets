import { describe, expect, it, vi, afterEach } from "vitest";
import { decideUser, evolveUser, initialUserState, type UserState, type UserEvent } from "./domain";
import { socialLoginLinkKey } from "./social-login-link";

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
        state: "active",
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

describe("authenticated Social Login Link revocation", () => {
  const at = "2026-11-05T12:00:00.000Z";
  const google = {
    providerName: "google" as const,
    providerSubject: "synthetic-google",
    email: "marker@example.test",
    linkedAt: "2026-01-01T00:00:00.000Z",
  };
  const facebook = { ...google, providerName: "facebook" as const, providerSubject: "synthetic-facebook" };
  const key = socialLoginLinkKey(google.providerName, google.providerSubject);
  const state: UserState = {
    ...initialUserState,
    id: "usr_test" as never,
    authMethods: ["password", "social-login"],
    socialLoginLinks: [google],
  };
  const command = {
    type: "UnlinkSocialLogin" as const,
    linkKey: key,
    authenticationMethod: "password" as const,
    authenticatedAt: at,
  };
  afterEach(() => vi.useRealTimers());
  it("keeps provider-subject link selectors compatible with normalized legacy ownership keys", () => {
    expect(socialLoginLinkKey("google", " synthetic-google ")).toBe(
      "8c9d0d4713dc856393486aa4d091bdeca16e43c0ec01ecbdeaa770b0da5afc98",
    );
    expect(socialLoginLinkKey("facebook", google.providerSubject)).not.toBe(key);
  });
  it("treats legacy links as active, emits only the closed pair and conditional third, then stays revoked the next day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const events = decideUser(state, command);
    expect(events).toEqual([
      {
        type: "identity.user.social-login-revocation-requested",
        data: { providerName: "google", linkKey: key, requestedAt: at },
      },
      { type: "identity.user.social-login-revoked", data: { providerName: "google", linkKey: key, revokedAt: at } },
      { type: "identity.user.auth-method-disabled", data: { authMethod: "social-login" } },
    ]);
    const revoked = events.reduce(evolveUser, state);
    expect(revoked.socialLoginLinks[0]).toEqual({ ...google, state: "revoked", requestedAt: at, revokedAt: at });
    expect(revoked.authMethods).toEqual(["password"]);
    expect(evolveUser(revoked, { type: "identity.user.social-login-linked", data: google })).toEqual(revoked);
    vi.setSystemTime("2026-11-06T12:00:00.000Z");
    expect(() => decideUser(revoked, { ...command, authenticatedAt: new Date().toISOString() })).toThrow(
      "social-login-link-not-active",
    );
    expect(() => decideUser(revoked, { type: "LinkSocialLogin", ...google })).toThrow("social_login_revoked");
    const otherProvider = { ...state, socialLoginLinks: [google, facebook] };
    expect(
      decideUser(otherProvider, {
        ...command,
        authenticatedAt: new Date().toISOString(),
        authenticationMethod: "facebook",
      }),
    ).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain(google.providerSubject);
    expect(JSON.stringify(events)).not.toContain(google.email);
  });
  it.each([
    undefined,
    null,
    "",
    "malformed",
    "2026-11-05",
    "2026-02-30T00:00:00Z",
    "2026-11-05T12:00:01Z",
    "2026-11-05T11:44:59Z",
  ])("refuses invalid or non-recent authority %s", (authenticatedAt) => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    expect(() => decideUser(state, { ...command, authenticatedAt })).toThrow("recent-authentication-required");
  });
  it("isolates each method/target guard and the inactive Session bypass mutant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const twoLinks = { ...state, socialLoginLinks: [google, facebook] };
    for (const authenticationMethod of [undefined, "google"] as const)
      expect(() => decideUser(twoLinks, { ...command, authenticationMethod })).toThrow(
        "authentication-method-not-different",
      );
    const userWithInactiveMethod: UserState = {
      ...initialUserState,
      id: state.id,
      authMethods: ["social-login"],
      socialLoginLinks: [google, facebook],
    };
    expect(() => decideUser(userWithInactiveMethod, command)).toThrow("authentication-method-not-different");
    expect(decideUser(userWithInactiveMethod, { ...command, authenticationMethod: "facebook" })).toHaveLength(2);
    expect(decideUser({ ...userWithInactiveMethod, authMethods: ["password", "social-login"] }, command)).toHaveLength(
      2,
    );
    expect(() => decideUser({ ...state, authMethods: ["social-login"] }, command)).toThrow(
      "last-authentication-method",
    );
    expect(() => decideUser(state, { ...command, linkKey: "0".repeat(64) })).toThrow("social-login-link-not-active");
  });
  it("fails closed on poisoned, duplicate and out-of-order lifecycle facts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const [requested, revoked] = decideUser(state, command);
    expect(() => evolveUser(state, revoked)).toThrow();
    const pending = evolveUser(state, requested);
    expect(() => evolveUser(pending, requested)).toThrow();
    for (const patch of [
      { linkKey: "f".repeat(64) },
      { providerName: "facebook" },
      { requestedAt: "2026-11-05" },
      { requestedAt: "2026-02-30T00:00:00Z" },
      { requestedAt: "2026-01-01T99:00:00Z" },
      { extra: { marker: "poison" } },
    ])
      expect(() => evolveUser(state, { ...requested, data: { ...requested.data, ...patch } } as UserEvent)).toThrow();
    const done = evolveUser(pending, revoked);
    expect(() => evolveUser(done, revoked)).toThrow();
  });
});
