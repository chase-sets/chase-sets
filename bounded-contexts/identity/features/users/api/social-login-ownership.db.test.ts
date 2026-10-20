import { describe, expect, it } from "vitest";
import { decideUser, evolveUser, initialUserState } from "../domain/domain";

describe("social login ownership invariants", () => {
  it("keeps a provider subject claim normalized and refuses target-provider unlink", () => {
    const created = decideUser(initialUserState, {
      type: "CreateUser",
      userId: "usr_social_ownership" as never,
      displayName: "Ownership",
      primaryEmail: "ownership@example.test",
    }).reduce(evolveUser, initialUserState);
    const withPassword = decideUser(created, { type: "EnableAuthMethod", authMethod: "password" }).reduce(
      evolveUser,
      created,
    );
    const linked = decideUser(withPassword, {
      type: "LinkSocialLogin",
      providerName: "google",
      providerSubject: " subject-1 ",
      email: "ownership@example.test",
      linkedAt: "2026-10-20T00:00:00.000Z",
    }).reduce(evolveUser, withPassword);
    expect(linked.socialLoginLinks[0]?.providerSubject).toBe("subject-1");
    expect(() =>
      decideUser(linked, {
        type: "UnlinkSocialLogin",
        providerName: "google",
        providerSubject: "subject-1",
        authenticationMethod: "google",
        authenticatedAt: "2026-10-20T00:00:00.000Z",
        now: "2026-10-20T00:05:00.000Z",
      }),
    ).toThrow("A different authentication method is required.");
  });
});
