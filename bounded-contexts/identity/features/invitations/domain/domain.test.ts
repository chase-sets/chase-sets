import { describe, expect, it } from "vitest";
import { decideInvitation, evolveInvitation, initialInvitationState } from "./domain";

describe("invitation domain", () => {
  it("accepts an invitation with a single-use acceptance token", () => {
    const created = decideInvitation(initialInvitationState, {
      type: "CreateInvitation",
      invitationId: "ivt_test" as never,
      accountId: "acc_test" as never,
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-04-01T00:00:00.000Z",
      assignmentAuthority: { type: "system" },
    });
    const createdState = created.reduce(evolveInvitation, initialInvitationState);
    const issued = decideInvitation(createdState, {
      type: "IssueInvitationAcceptanceToken",
      tokenHash: "hashed:invite_token",
      expiresAt: "2026-03-31T00:00:00.000Z",
    });
    const issuedState = issued.reduce(evolveInvitation, createdState);
    const accepted = decideInvitation(issuedState, {
      type: "AcceptInvitation",
      userId: "usr_test" as never,
      acceptanceTokenHash: "hashed:invite_token",
      acceptedAt: "2026-03-30T00:00:00.000Z",
    });
    const acceptedState = accepted.reduce(evolveInvitation, issuedState);

    expect(acceptedState.status).toBe("accepted");
    expect(acceptedState.acceptedByUserId).toBe("usr_test");
    expect(acceptedState.acceptanceTokenConsumedAt).toBe("2026-03-30T00:00:00.000Z");
    expect(() =>
      decideInvitation(acceptedState, {
        type: "AcceptInvitation",
        userId: "usr_test" as never,
        acceptanceTokenHash: "hashed:invite_token",
        acceptedAt: "2026-03-30T00:01:00.000Z",
      }),
    ).toThrow("Only pending invitations can change.");
  });

  it("rejects acceptance by invitation id alone", () => {
    const created = decideInvitation(initialInvitationState, {
      type: "CreateInvitation",
      invitationId: "ivt_test" as never,
      accountId: "acc_test" as never,
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-04-01T00:00:00.000Z",
      assignmentAuthority: { type: "system" },
    });
    const createdState = created.reduce(evolveInvitation, initialInvitationState);

    expect(() =>
      decideInvitation(createdState, {
        type: "AcceptInvitation",
        userId: "usr_test" as never,
        acceptanceTokenHash: "",
        acceptedAt: "2026-03-30T00:00:00.000Z",
      }),
    ).toThrow("Invitation acceptance token is required.");
  });

  it("rejects expired acceptance tokens", () => {
    const created = decideInvitation(initialInvitationState, {
      type: "CreateInvitation",
      invitationId: "ivt_test" as never,
      accountId: "acc_test" as never,
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-04-01T00:00:00.000Z",
      assignmentAuthority: { type: "system" },
    });
    const createdState = created.reduce(evolveInvitation, initialInvitationState);
    const issued = decideInvitation(createdState, {
      type: "IssueInvitationAcceptanceToken",
      tokenHash: "hashed:invite_token",
      expiresAt: "2026-03-29T00:00:00.000Z",
    });
    const issuedState = issued.reduce(evolveInvitation, createdState);

    expect(() =>
      decideInvitation(issuedState, {
        type: "AcceptInvitation",
        userId: "usr_test" as never,
        acceptanceTokenHash: "hashed:invite_token",
        acceptedAt: "2026-03-30T00:00:00.000Z",
      }),
    ).toThrow("Invitation acceptance token is expired.");
  });

  it("rejects an expired invitation even when the expiry sweeper has not run", () => {
    const created = decideInvitation(initialInvitationState, {
      type: "CreateInvitation",
      invitationId: "ivt_test" as never,
      accountId: "acc_test" as never,
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-04-01T00:00:00.000Z",
      assignmentAuthority: { type: "system" },
    });
    const createdState = created.reduce(evolveInvitation, initialInvitationState);
    const issued = decideInvitation(createdState, {
      type: "IssueInvitationAcceptanceToken",
      tokenHash: "hashed:invite_token",
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    const issuedState = issued.reduce(evolveInvitation, createdState);

    expect(issuedState.status).toBe("pending");
    expect(() =>
      decideInvitation(issuedState, {
        type: "AcceptInvitation",
        userId: "usr_test" as never,
        acceptanceTokenHash: "hashed:invite_token",
        acceptedAt: "2026-04-01T00:00:00.000Z",
      }),
    ).toThrow("Invitation is expired.");
  });

  it("rejects platform-admin invitations outside platform bootstrap", () => {
    expect(() =>
      decideInvitation(initialInvitationState, {
        type: "CreateInvitation",
        invitationId: "ivt_test" as never,
        accountId: "acc_test" as never,
        email: "seller@example.com",
        roleKey: "platform-admin",
        expiresAt: "2026-04-01T00:00:00.000Z",
        assignmentAuthority: { type: "actor", roleKey: "owner" },
      }),
    ).toThrow("Platform-admin can only be assigned by platform bootstrap.");
  });

  it("rejects invitations above the actor role", () => {
    expect(() =>
      decideInvitation(initialInvitationState, {
        type: "CreateInvitation",
        invitationId: "ivt_test" as never,
        accountId: "acc_test" as never,
        email: "seller@example.com",
        roleKey: "owner",
        expiresAt: "2026-04-01T00:00:00.000Z",
        assignmentAuthority: { type: "actor", roleKey: "manager" },
      }),
    ).toThrow("Cannot assign a role above the actor's role.");
  });
});
