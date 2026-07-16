import {
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerInvitationRoutes } from "./invitation-routes";
import type { AuthApiEnv } from "./support";

const {
  mockConsumeChallenge,
  mockCreateIdentityAuthRequestClient,
  mockGetPasswordCredentialByUserId,
  mockStartInteractiveAuth,
  mockUpsertPasskeyCredential,
  mockUpsertPasswordCredential,
  mockVerifyPasskeyRegistration,
} = vi.hoisted(() => ({
  mockConsumeChallenge: vi.fn(),
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockGetPasswordCredentialByUserId: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
  mockUpsertPasskeyCredential: vi.fn(),
  mockUpsertPasswordCredential: vi.fn(),
  mockVerifyPasskeyRegistration: vi.fn(),
}));

vi.mock("../auth-support/store", () => ({
  consumeChallenge: mockConsumeChallenge,
  getPasswordCredentialByUserId: mockGetPasswordCredentialByUserId,
  upsertPasskeyCredential: mockUpsertPasskeyCredential,
  upsertPasswordCredential: mockUpsertPasswordCredential,
}));

vi.mock("../auth-support/webauthn", () => ({ verifyPasskeyRegistration: mockVerifyPasskeyRegistration }));

vi.mock("../runtime-support/services", () => ({
  startInteractiveAuth: mockStartInteractiveAuth,
}));

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

function buildApp(services: unknown) {
  return createTestApp<AuthApiEnv>({
    actor: createAnonymousTestActor(),
    context: createTestEventStoreContext(
      createInternalSystemTestActor({
        userId: "usr_test",
        accountId: "acc_test",
      }),
      {
        tenantId: "ten_test",
        trace: { traceId: "trace_invitation" },
      },
    ),
    routes: (app) => {
      registerInvitationRoutes(app, services as AuthServices);
    },
  });
}

function createServices() {
  mockGetPasswordCredentialByUserId.mockResolvedValue(null);
  return {
    db: {
      query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })),
    },
    auth: {
      issueOpaqueToken: vi.fn(() => "invite_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
      verifySecret: vi.fn((value: string, hash: string) => hash === `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getInvitation: vi.fn(async (_invitationId: string) => ({
        invitation_id: "ivt_1",
        account_id: "acc_invited",
        email: "seller@example.com",
        role_key: "viewer",
        status: "pending",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        accepted_by_user_id: null,
        invited_by_user_id: "usr_inviter",
        account_display_name: "Competitive Cards",
        invited_by_display_name: "Avery Collector",
        updated_at: new Date().toISOString(),
      })),
      getUser: vi.fn(async () => ({ user_id: "usr_new" })),
      getUserByEmail: vi.fn(async (_email: string): Promise<{ user_id: string } | null> => null),
    },
    notificationOutbox: {
      enqueueNotification: vi.fn(async (_input: { message: { templateData: Record<string, unknown> } }) => undefined),
    },
  };
}

function createIdentityMutations() {
  return {
    issueInvitationAcceptanceToken: vi.fn(async () => ({
      invitationId: "ivt_1",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      snapshots: [],
    })),
    verifyInvitationAcceptanceToken: vi.fn(async () => ({
      invitationId: "ivt_1",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    createPersonalIdentity: vi.fn(async () => ({
      userId: "usr_new",
      accountId: "acc_personal",
      membershipId: "mbr_personal",
      snapshots: [],
    })),
    acceptInvitationForUser: vi.fn(async () => ({
      membershipId: "mbr_invited",
      snapshots: [],
    })),
    verifyEmailContactMethod: vi.fn(async () => ({
      ok: true,
      userId: "usr_new",
      snapshots: [],
    })),
    enablePasswordCredential: vi.fn(async () => ({
      ok: true,
      userId: "usr_new",
      snapshots: [],
    })),
    registerPasskeyCredential: vi.fn(async () => ({
      ok: true,
      userId: "usr_new",
      snapshots: [],
    })),
  };
}

useMockReset();

describe("invitation auth routes", () => {
  it("emails an invitation acceptance token without returning the bearer token", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        landingPath: "/accept-invitation",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      invitationId: "ivt_1",
      expiresAt: expect.any(String),
    });
    expect(body).not.toHaveProperty("token");
    expect(identityMutations.issueInvitationAcceptanceToken).toHaveBeenCalledWith(
      expect.objectContaining({
        invitationId: "ivt_1",
        tokenHash: "hashed:invite_token",
      }),
    );
    expect(services.notificationOutbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "auth.invitation-acceptance-link.requested",
          channels: [
            expect.objectContaining({
              channel: "email",
              to: [{ email: "seller@example.com" }],
            }),
          ],
          templateData: {
            invitationLink: expect.stringContaining("token=invite_token"),
            accountName: "Competitive Cards",
            roleLabel: "Viewer",
          },
        }),
      }),
    );
    const message = services.notificationOutbox.enqueueNotification.mock.calls[0]?.[0].message;
    expect(String(message?.templateData.invitationLink)).toContain("invitationId=ivt_1");
  });

  it("completes the invite, email link, acceptance, and invited-account session journey", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    identityMutations.issueInvitationAcceptanceToken.mockResolvedValue({
      invitationId: "ivt_journey",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      snapshots: [],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_journey",
      sessionToken: "session_token",
      session: { session_id: "ses_journey", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const emailResponse = await app.request("https://marketplace.test/invitations/acceptance-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.80" },
      body: JSON.stringify({ invitationId: "ivt_journey" }),
    });
    expect(emailResponse.status).toBe(200);
    const message = services.notificationOutbox.enqueueNotification.mock.calls[0]?.[0].message;
    const invitationLink = new URL(String(message?.templateData.invitationLink));

    const acceptanceResponse = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.80" },
      body: JSON.stringify({
        invitationId: invitationLink.searchParams.get("invitationId"),
        token: invitationLink.searchParams.get("token"),
        password: "correct horse battery staple",
      }),
    });

    expect(invitationLink.pathname).toBe("/invite/ivt_journey");
    expect(acceptanceResponse.status).toBe(200);
    await expect(acceptanceResponse.json()).resolves.toMatchObject({
      type: "session-started",
      invitationId: "ivt_journey",
      membershipId: "mbr_invited",
    });
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        accountId: "acc_invited",
        membershipsOverride: [expect.objectContaining({ roleKey: "viewer" })],
      }),
    );
  });

  it("inspects a valid pending invitation for the recipient page", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: "ivt_1", token: "invite_token" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "pending",
      invitationId: "ivt_1",
      email: "seller@example.com",
      accountName: "Competitive Cards",
      invitedByName: "Avery Collector",
      roleLabel: "Viewer",
    });
    expect(identityMutations.verifyInvitationAcceptanceToken).toHaveBeenCalledWith({
      invitationId: "ivt_1",
      acceptanceTokenHash: "hashed:invite_token",
    });
  });

  it.each([
    ["accepted", "accepted"],
    ["cancelled", "revoked"],
    ["expired", "expired"],
  ] as const)("reports %s invitations as %s", async (storedStatus, publicStatus) => {
    const services = createServices();
    services.identity.getInvitation.mockResolvedValue({
      ...(await services.identity.getInvitation("ivt_1"))!,
      status: storedStatus,
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(createIdentityMutations());
    const response = await buildApp(services).request("/invitations/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId: "ivt_1", token: "invite_token" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: publicStatus });
  });

  it("rejects invitation id alone without provisioning a user or issuing a session", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        password: "correct horse battery staple",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invitation acceptance token is invalid or expired.",
    });
    expect(identityMutations.verifyInvitationAcceptanceToken).not.toHaveBeenCalled();
    expect(identityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(identityMutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mockUpsertPasswordCredential).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rejects invalid invitation tokens before provisioning a user", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    identityMutations.verifyInvitationAcceptanceToken.mockRejectedValue({ status: 403 });
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        token: "wrong_token",
        password: "correct horse battery staple",
      }),
    });

    expect(response.status).toBe(401);
    expect(identityMutations.verifyInvitationAcceptanceToken).toHaveBeenCalledWith({
      invitationId: "ivt_1",
      acceptanceTokenHash: "hashed:wrong_token",
    });
    expect(identityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(identityMutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mockUpsertPasswordCredential).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("rejects an expired invitation even when token verification succeeds", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    identityMutations.verifyInvitationAcceptanceToken.mockResolvedValue({
      invitationId: "ivt_1",
      accountId: "acc_invited",
      email: "seller@example.com",
      roleKey: "viewer",
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    const app = buildApp(services);

    const response = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: "ivt_1",
        token: "invite_token",
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invitation acceptance token is invalid or expired.",
    });
    expect(identityMutations.createPersonalIdentity).not.toHaveBeenCalled();
    expect(identityMutations.acceptInvitationForUser).not.toHaveBeenCalled();
    expect(identityMutations.verifyEmailContactMethod).not.toHaveBeenCalled();
    expect(mockStartInteractiveAuth).not.toHaveBeenCalled();
  });

  it("verifies an existing user's password before consuming the invitation", async () => {
    const services = createServices();
    services.identity.getUserByEmail.mockResolvedValue({ user_id: "usr_existing" });
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockGetPasswordCredentialByUserId.mockResolvedValue({
      credential_id: "crd_existing",
      user_id: "usr_existing",
      secret_hash: "hashed:existing password",
    });

    const response = await buildApp(services).request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.91" },
      body: JSON.stringify({
        invitationId: "ivt_existing_password",
        token: "invite_token",
        password: "wrong password",
      }),
    });

    expect(response.status).toBe(401);
    expect(identityMutations.acceptInvitationForUser).not.toHaveBeenCalled();
    expect(identityMutations.enablePasswordCredential).not.toHaveBeenCalled();
    expect(mockUpsertPasswordCredential).not.toHaveBeenCalled();
  });

  it("accepts a valid emailed token once and rejects replay", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });
    const app = buildApp(services);

    const first = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.101" },
      body: JSON.stringify({
        invitationId: "ivt_valid_once",
        token: "invite_token",
        password: "correct horse battery staple",
      }),
    });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
      invitationId: "ivt_valid_once",
      membershipId: "mbr_invited",
    });
    expect(identityMutations.verifyInvitationAcceptanceToken).toHaveBeenCalledWith({
      invitationId: "ivt_valid_once",
      acceptanceTokenHash: "hashed:invite_token",
    });
    expect(identityMutations.acceptInvitationForUser).toHaveBeenCalledWith({
      invitationId: "ivt_valid_once",
      userId: "usr_new",
      acceptanceTokenHash: "hashed:invite_token",
    });
    expect(identityMutations.verifyEmailContactMethod).toHaveBeenCalledWith({
      userId: "usr_new",
      email: "seller@example.com",
    });
    expect(identityMutations.enablePasswordCredential.mock.invocationCallOrder[0]).toBeGreaterThan(
      identityMutations.acceptInvitationForUser.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockUpsertPasswordCredential).toHaveBeenCalledWith(
      services.db,
      expect.objectContaining({
        userId: "usr_new",
        secretHash: "hashed:correct horse battery staple",
      }),
    );
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({
        userId: "usr_new",
        accountId: "acc_invited",
        authenticationMethod: "password",
        membershipsOverride: [
          expect.objectContaining({
            membershipId: "mbr_invited",
            accountId: "acc_invited",
            roleKey: "viewer",
            status: "active",
          }),
        ],
      }),
    );

    identityMutations.verifyInvitationAcceptanceToken.mockRejectedValueOnce({ status: 403 });
    const second = await app.request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.101" },
      body: JSON.stringify({
        invitationId: "ivt_valid_once",
        token: "invite_token",
      }),
    });

    expect(second.status).toBe(401);
  });

  it("registers a passkey while accepting and authenticates into the invited account", async () => {
    const services = createServices();
    const identityMutations = createIdentityMutations();
    mockCreateIdentityAuthRequestClient.mockReturnValue(identityMutations);
    mockConsumeChallenge.mockResolvedValue({ email: "seller@example.com", challenge_value: "challenge" });
    mockVerifyPasskeyRegistration.mockResolvedValue({
      externalCredentialId: "external_credential",
      publicKey: "public_key",
      signCount: 0,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_new",
      sessionId: "ses_passkey",
      sessionToken: "session_token",
      session: { session_id: "ses_passkey", expires_at: new Date(Date.now() + 60_000).toISOString() },
      memberships: [],
    });

    const response = await buildApp(services).request("/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.44" },
      body: JSON.stringify({
        invitationId: "ivt_passkey",
        token: "invite_token",
        challengeId: "cmd_challenge",
        challenge: "challenge",
        webauthnResponse: "response",
      }),
    });

    expect(response.status).toBe(200);
    expect(identityMutations.registerPasskeyCredential).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "usr_new" }),
    );
    expect(mockUpsertPasskeyCredential).toHaveBeenCalledWith(
      services.db,
      expect.objectContaining({ userId: "usr_new", externalCredentialId: "external_credential" }),
    );
    expect(mockStartInteractiveAuth).toHaveBeenCalledWith(
      services,
      expect.objectContaining({ accountId: "acc_invited", authenticationMethod: "passkey" }),
    );
  });
});
