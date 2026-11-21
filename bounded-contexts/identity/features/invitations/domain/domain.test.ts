import { timingSafeEqual } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decideInvitation,
  evolveInvitation,
  initialInvitationState,
  validateInvitationAcceptanceToken,
} from "./domain";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

const tokenHash = "a".repeat(64);

describe("invitation domain", () => {
  describe("token validation", () => {
    const verifiedAt = "2026-03-30T00:00:00.000Z";
    const state = {
      ...initialInvitationState,
      id: "ivt_test" as never,
      status: "pending" as const,
      expiresAt: "2026-04-01T00:00:00.000Z",
      acceptanceTokenHash: tokenHash,
      acceptanceTokenExpiresAt: "2026-03-31T00:00:00.000Z",
    };

    it.each([true, false])("compares two 32-byte token digests in constant time (matches: %s)", (matches) => {
      const candidate = matches ? tokenHash : "b".repeat(64);
      vi.mocked(timingSafeEqual).mockClear();
      const validate = () => validateInvitationAcceptanceToken(state, candidate, verifiedAt);

      if (matches) expect(validate).not.toThrow();
      else expect(validate).toThrow("Invitation acceptance token is invalid.");
      expect(timingSafeEqual).toHaveBeenCalledExactlyOnceWith(
        Buffer.from(tokenHash, "hex"),
        Buffer.from(candidate, "hex"),
      );
    });

    it.each(["a".repeat(62), "g".repeat(64)])("rejects a malformed stored token digest", (stored) => {
      vi.mocked(timingSafeEqual).mockClear();

      expect(() =>
        validateInvitationAcceptanceToken({ ...state, acceptanceTokenHash: stored }, tokenHash, verifiedAt),
      ).toThrow("Invitation acceptance token is invalid.");
      expect(timingSafeEqual).not.toHaveBeenCalled();
    });
  });

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
      tokenHash,
      expiresAt: "2026-03-31T00:00:00.000Z",
    });
    const issuedState = issued.reduce(evolveInvitation, createdState);
    const accepted = decideInvitation(issuedState, {
      type: "AcceptInvitation",
      userId: "usr_test" as never,
      acceptanceTokenHash: tokenHash,
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
        acceptanceTokenHash: tokenHash,
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
      tokenHash,
      expiresAt: "2026-03-29T00:00:00.000Z",
    });
    const issuedState = issued.reduce(evolveInvitation, createdState);

    expect(() =>
      decideInvitation(issuedState, {
        type: "AcceptInvitation",
        userId: "usr_test" as never,
        acceptanceTokenHash: tokenHash,
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
      tokenHash,
      expiresAt: "2026-04-01T00:00:00.000Z",
    });
    const issuedState = issued.reduce(evolveInvitation, createdState);

    expect(issuedState.status).toBe("pending");
    expect(() =>
      decideInvitation(issuedState, {
        type: "AcceptInvitation",
        userId: "usr_test" as never,
        acceptanceTokenHash: tokenHash,
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
