import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { buildIdentityApi, type IdentityApiEnv } from "../api";
import { IdentityDomainError } from "../support/runtime-support/common";
import type { IdentityServices } from "../support/runtime-support/services";

const actor: ResolvedActor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["accounts.manage", "accounts.view", "memberships.manage", "memberships.view", "security.manage"],
};

function commandResult(version: number, status: string, state: Record<string, unknown> = {}) {
  return {
    version,
    state: { status, ...state },
    newEvents: [],
    storedEvents: [],
  };
}

function buildApp(services: IdentityServices, requestActor: ResolvedActor = actor) {
  const app = new Hono<IdentityApiEnv>();
  app.onError(errorHandler);
  app.use("*", async (c, next) => {
    c.set("actor", requestActor);
    c.set("context", {
      tenantId: "tnt_identity" as never,
      audit: {
        performedByUserId: requestActor.userId as never,
        forAccountId: requestActor.accountId as never,
      },
      trace: {},
    } as EventStoreContext);
    await next();
  });
  app.route("/", buildIdentityApi(services));
  return app;
}

function createServices(
  overrides: Partial<Pick<IdentityServices, "apiKeys" | "invitations" | "memberships" | "users">> = {},
) {
  return {
    db: {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("identity_account_display_name_reservations")) {
          return { rows: [{ display_name_key: params[0] }] };
        }
        if (sql.includes("FROM identity_api_key_secrets")) {
          return {
            rows: [
              {
                api_key_id: "key_existing",
                user_id: actor.userId,
                key_prefix: "key_secret_1",
                secret_hash: "hashed:key_secret_1_value",
                status: "active",
              },
            ],
          };
        }
        return { rows: [] };
      }),
    },
    auth: {
      issueOpaqueToken: vi.fn((prefix: string) => `${prefix}_secret_1_value`),
      hashSecret: vi.fn((secret: string) => `hashed:${secret}`),
      verifySecret: vi.fn((secret: string, hash: string) => hash === `hashed:${secret}`),
    },
    accounts: {
      commandHandler: vi.fn(async (input: { command: { type: string } }) => {
        const status =
          input.command.type === "SuspendAccount"
            ? "suspended"
            : input.command.type === "CloseAccount"
              ? "closed"
              : "active";
        return commandResult(11, status, { badges: ["founding-account"] });
      }),
      listAccounts: vi.fn(async () => ({ items: [], total: 0 })),
      getAccount: vi.fn(async () => null),
      getAccountForRead: vi.fn(async (accountId: string) =>
        accountId === actor.accountId
          ? {
              account_id: actor.accountId,
              account_type: "business",
              badges: [],
              display_name: "Card Vault",
              name: "Card Vault LLC",
              status: "active",
              updated_at: "2026-07-01T00:00:00.000Z",
            }
          : null,
      ),
      getAccountState: vi.fn(async () => null),
      projectors: [],
    },
    users: {
      commandHandler: vi.fn(async (input: { command: { type: string } }) => {
        const status = input.command.type === "SuspendUser" ? "suspended" : "active";
        return commandResult(21, status);
      }),
      getUserBySocialLogin: vi.fn(async () => null),
      listUsers: vi.fn(async () => ({ items: [], total: 0 })),
      getUser: vi.fn(async (userId: string) =>
        userId.startsWith("usr_")
          ? {
              user_id: userId,
              display_name: "API Key Owner",
              primary_email: "owner@example.com",
              status: "active",
            }
          : null,
      ),
      getUserByEmail: vi.fn(async () => null),
      getUserByPhone: vi.fn(async () => null),
      projectors: [],
    },
    memberships: {
      commandHandler: vi.fn(async (input: { command: { type: string } }) => {
        const status = input.command.type === "RevokeMembership" ? "revoked" : "active";
        return commandResult(31, status);
      }),
      getMembership: vi.fn(async () => ({
        membership_id: "mbr_existing",
        user_id: "usr_2",
        account_id: actor.accountId,
      })),
      getMembershipState: vi.fn(async () => null),
      listMemberships: vi.fn(async () => ({ items: [], total: 0 })),
      getActiveMembershipForUserAccount: vi.fn(async () => null),
      listMembershipsForUser: vi.fn(async () => []),
      projectors: [],
    },
    invitations: {
      commandHandler: vi.fn(async (input: { command: { type: string } }) => {
        const statusByCommand = new Map([
          ["CancelInvitation", "cancelled"],
          ["DeclineInvitation", "declined"],
          ["AcceptInvitation", "accepted"],
        ]);
        return commandResult(41, statusByCommand.get(input.command.type) ?? "pending");
      }),
      getInvitation: vi.fn(async () => ({ invitation_id: "ivt_existing", account_id: actor.accountId })),
      getInvitationForRead: vi.fn(async () => ({ invitation_id: "ivt_existing", account_id: actor.accountId })),
      getInvitationState: vi.fn(async (invitationId: string) => ({
        id: invitationId,
        accountId: actor.accountId,
        email: "invitee@example.com",
        roleKey: "owner",
        status: "pending",
        expiresAt: "2027-07-01T00:00:00.000Z",
        acceptanceTokenHash: "hashed:invite_token",
        acceptanceTokenExpiresAt: "2027-06-01T00:00:00.000Z",
        acceptanceTokenConsumedAt: null,
        acceptedByUserId: null,
      })),
      getPendingInvitationByEmail: vi.fn(async () => null),
      listInvitations: vi.fn(async () => ({ items: [], total: 0 })),
      projectors: [],
    },
    apiKeys: {
      commandHandler: vi.fn(async (input: { command: { type: string } }) =>
        commandResult(51, input.command.type === "RevokeApiKey" ? "revoked" : "active"),
      ),
      getApiKey: vi.fn(async () => ({ api_key_id: "key_existing", user_id: actor.userId })),
      listApiKeys: vi.fn(async () => ({ items: [], total: 0 })),
      projectors: [],
    },
    consents: {
      commandHandler: vi.fn(async () => ({
        version: 61,
        state: {
          id: "cns_1",
          subjectType: "user",
          userId: actor.userId,
          accountId: actor.accountId,
          policyKey: "terms-of-service",
          policyVersion: "v1",
          recordedAt: "2026-06-15T00:00:00.000Z",
        },
        newEvents: [],
        storedEvents: [],
      })),
      listConsents: vi.fn(async () => ({ items: [], total: 0 })),
      projectors: [],
    },
    policies: {
      resolvePolicy: vi.fn(async () => ({
        policyKey: "identity.terms-of-service-active-version",
        value: { version: "v1" },
        source: "fallback",
        documentId: null,
        effectiveFrom: null,
        effectiveUntil: null,
        resolvedAt: "2026-06-15T00:00:00.000Z",
      })),
    },
    shippingAddresses: {
      commandHandler: vi.fn(async () => commandResult(71, "committed")),
      verifyShippingAddress: vi.fn(
        async (address: Parameters<IdentityServices["shippingAddresses"]["verifyShippingAddress"]>[0]) => ({
          status: "accepted",
          address,
        }),
      ),
      listShippingAddresses: vi.fn(async () => []),
      getShippingAddress: vi.fn(async () => null),
      projectors: [],
    },
    projectors: [],
    ...overrides,
  } as unknown as IdentityServices;
}

async function requestJson(app: Hono<IdentityApiEnv>, path: string, init: RequestInit = {}) {
  const response = await app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

describe("Identity API mutation snapshots", () => {
  it("returns command-local snapshots for internal Auth mutation routes", async () => {
    const services = createServices();
    const app = buildApp(services);

    const guestAccount = await requestJson(app, "/internal/auth/guest-accounts", {
      method: "POST",
      body: JSON.stringify({ email: "guest@example.com", displayName: "Guest Buyer" }),
    });
    expect(guestAccount.response.status).toBe(201);
    expect(guestAccount.body).toEqual(
      expect.objectContaining({
        accountId: expect.stringMatching(/^acc_/),
        snapshots: [
          expect.objectContaining({
            aggregate: "account",
            version: 11,
            status: "active",
          }),
        ],
      }),
    );

    const user = await requestJson(app, "/internal/auth/users", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com", displayName: "Owner" }),
    });
    expect(user.response.status).toBe(201);
    expect(user.body).toEqual(
      expect.objectContaining({
        userId: expect.stringMatching(/^usr_/),
        snapshots: [expect.objectContaining({ aggregate: "user", version: 21, status: "active" })],
      }),
    );

    const claim = await requestJson(app, "/internal/auth/guest-accounts/acc_guest/claim", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_1", roleKey: "owner" }),
    });
    expect(claim.response.status).toBe(201);
    expect(claim.body).toEqual(
      expect.objectContaining({
        membershipId: expect.stringMatching(/^mbr_/),
        snapshots: [expect.objectContaining({ aggregate: "membership", version: 31, status: "active" })],
      }),
    );

    const personalIdentity = await requestJson(app, "/internal/auth/personal-identities", {
      method: "POST",
      body: JSON.stringify({
        email: "new@example.com",
        displayName: "New Person",
        // The active version is resolved server-side (see `services.policies`
        // mock above); the client-supplied version here is intentionally
        // stale to prove the server ignores it for the canonical key.
        consents: [{ policyKey: "terms-of-service", policyVersion: "stale-client-supplied-version" }],
      }),
    });
    expect(personalIdentity.response.status).toBe(201);
    expect(personalIdentity.body.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aggregate: "account", version: 11, status: "active" }),
        expect.objectContaining({ aggregate: "membership", version: 31, status: "active" }),
        expect.objectContaining({ aggregate: "consent", version: 61, status: "recorded" }),
        expect.objectContaining({ aggregate: "user", version: 21, status: "active" }),
      ]),
    );
    expect(services.consents.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          policyKey: "terms-of-service",
          policyVersion: "v1",
        }),
      }),
    );

    for (const path of [
      "/internal/auth/users/usr_1/sms-code",
      "/internal/auth/users/usr_1/password-credential",
      "/internal/auth/users/usr_1/passkey-credential",
      "/internal/auth/users/usr_1/social-login-link",
    ]) {
      const credential = await requestJson(app, path, {
        method: "POST",
        body: JSON.stringify({
          credentialId: "crd_1",
          providerName: "google",
          providerSubject: "google-subject",
          email: "owner@example.com",
        }),
      });
      expect(credential.response.status).toBe(200);
      expect(credential.body).toEqual(
        expect.objectContaining({
          ok: true,
          userId: "usr_1",
          snapshots: [expect.objectContaining({ aggregate: "user", id: "usr_1", version: 21, status: "active" })],
        }),
      );
    }

    const acceptedInvitation = await requestJson(app, "/internal/auth/invitations/ivt_1/accept", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_1", acceptanceTokenHash: "hashed:invite_token" }),
    });
    expect(acceptedInvitation.response.status).toBe(200);
    expect(acceptedInvitation.body.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ aggregate: "membership", version: 31, status: "active" }),
        expect.objectContaining({ aggregate: "invitation", id: "ivt_1", version: 41, status: "accepted" }),
      ]),
    );
  });

  it("returns id, version, and status receipts for account, user, membership, invitation, and shipping-address routes", async () => {
    const app = buildApp(createServices(), { ...actor, roleKey: "platform-admin" });

    const accountCases = [
      {
        method: "POST",
        path: "/accounts",
        body: { accountId: "acc_2", name: "Store", accountType: "business" },
        status: 201,
        expected: { id: "acc_2", version: 11, status: "active" },
      },
      {
        method: "PUT",
        path: "/accounts/acc_1",
        body: { name: "Updated", displayName: "Updated" },
        status: 200,
        expected: { id: "acc_1", version: 11, status: "active" },
      },
      {
        method: "POST",
        path: "/accounts/acc_1/suspend",
        status: 200,
        expected: { id: "acc_1", version: 11, status: "suspended" },
      },
      {
        method: "POST",
        path: "/accounts/acc_1/reactivate",
        status: 200,
        expected: { id: "acc_1", version: 11, status: "active" },
      },
      {
        method: "POST",
        path: "/accounts/acc_1/close",
        status: 200,
        expected: { id: "acc_1", version: 11, status: "closed" },
      },
      {
        method: "POST",
        path: "/accounts/acc_1/badges",
        body: { badgeKey: "founding-account" },
        status: 200,
        expected: { id: "acc_1", version: 11, status: "active", badges: ["founding-account"] },
      },
      {
        method: "DELETE",
        path: "/accounts/acc_1/badges/founding-account",
        status: 200,
        expected: { id: "acc_1", version: 11, status: "active", badges: ["founding-account"] },
      },
    ] as const;
    for (const testCase of accountCases) {
      const { response, body } = await requestJson(app, testCase.path, {
        method: testCase.method,
        body: JSON.stringify("body" in testCase ? testCase.body : {}),
      });
      expect(response.status).toBe(testCase.status);
      expect(body).toMatchObject(testCase.expected);
    }

    const userCases = [
      {
        method: "POST",
        path: "/users",
        body: { userId: "usr_2", displayName: "User", primaryEmail: "user@example.com" },
        status: 201,
        expected: { id: "usr_2", version: 21, status: "active" },
      },
      {
        method: "PUT",
        path: "/users/usr_1",
        body: { displayName: "Updated" },
        status: 200,
        expected: { id: "usr_1", version: 21, status: "active" },
      },
      {
        method: "POST",
        path: "/users/usr_1/contact-methods",
        body: { contactMethodId: "ctm_1", contactMethodType: "email", value: "owner@example.com" },
        status: 200,
        expected: { id: "usr_1", version: 21, status: "active" },
      },
      {
        method: "POST",
        path: "/users/usr_1/contact-methods/ctm_1/verify",
        status: 200,
        expected: { id: "usr_1", version: 21, status: "active" },
      },
      {
        method: "POST",
        path: "/users/usr_1/auth-methods",
        body: { authMethod: "password" },
        status: 200,
        expected: { id: "usr_1", version: 21, status: "active" },
      },
      {
        method: "DELETE",
        path: "/users/usr_1/auth-methods/password",
        status: 200,
        expected: { id: "usr_1", version: 21, status: "active" },
      },
      {
        method: "POST",
        path: "/users/usr_1/suspend",
        status: 200,
        expected: { id: "usr_1", version: 21, status: "suspended" },
      },
      {
        method: "POST",
        path: "/users/usr_1/reactivate",
        status: 200,
        expected: { id: "usr_1", version: 21, status: "active" },
      },
    ] as const;
    for (const testCase of userCases) {
      const { response, body } = await requestJson(app, testCase.path, {
        method: testCase.method,
        body: JSON.stringify("body" in testCase ? testCase.body : {}),
      });
      expect(response.status).toBe(testCase.status);
      expect(body).toMatchObject(testCase.expected);
    }

    const membershipCases = [
      {
        method: "POST",
        path: "/memberships",
        body: { membershipId: "mbr_2", userId: "usr_2", accountId: "acc_1", roleKey: "viewer" },
        status: 201,
        expected: { id: "mbr_2", version: 31, status: "active" },
      },
      {
        method: "PUT",
        path: "/memberships/mbr_existing/role",
        body: { roleKey: "manager" },
        status: 200,
        expected: { id: "mbr_existing", version: 31, status: "active" },
      },
      {
        method: "POST",
        path: "/memberships/mbr_existing/revoke",
        status: 200,
        expected: { id: "mbr_existing", version: 31, status: "revoked" },
      },
      {
        method: "POST",
        path: "/memberships/mbr_existing/reinstate",
        status: 200,
        expected: { id: "mbr_existing", version: 31, status: "active" },
      },
    ] as const;
    for (const testCase of membershipCases) {
      const { response, body } = await requestJson(app, testCase.path, {
        method: testCase.method,
        body: JSON.stringify("body" in testCase ? testCase.body : {}),
      });
      expect(response.status).toBe(testCase.status);
      expect(body).toMatchObject(testCase.expected);
    }

    const invitationCases = [
      {
        method: "POST",
        path: "/invitations",
        body: {
          invitationId: "ivt_2",
          accountId: "acc_1",
          email: "invitee@example.com",
          roleKey: "viewer",
          expiresAt: "2026-07-01T00:00:00.000Z",
        },
        status: 201,
        expected: { id: "ivt_2", version: 41, status: "pending" },
      },
      {
        method: "POST",
        path: "/invitations/ivt_existing/resend",
        body: { expiresAt: "2026-07-02T00:00:00.000Z" },
        status: 200,
        expected: { id: "ivt_existing", version: 41, status: "pending" },
      },
      {
        method: "POST",
        path: "/invitations/ivt_existing/cancel",
        status: 200,
        expected: { id: "ivt_existing", version: 41, status: "cancelled" },
      },
      {
        method: "POST",
        path: "/invitations/ivt_existing/decline",
        status: 200,
        expected: { id: "ivt_existing", version: 41, status: "declined" },
      },
    ] as const;
    for (const testCase of invitationCases) {
      const { response, body } = await requestJson(app, testCase.path, {
        method: testCase.method,
        body: JSON.stringify("body" in testCase ? testCase.body : {}),
      });
      expect(response.status).toBe(testCase.status);
      expect(body).toMatchObject(testCase.expected);
    }

    const addressBody = {
      name: "Alex Collector",
      line1: "100 Main St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    };
    const shippingCases = [
      {
        method: "POST",
        path: "/accounts/acc_1/shipping-addresses",
        body: addressBody,
        status: 201,
        expected: { version: 71, status: "added" },
      },
      {
        method: "PUT",
        path: "/accounts/acc_1/shipping-addresses/adr_1",
        body: addressBody,
        status: 200,
        expected: { id: "adr_1", version: 71, status: "updated" },
      },
      {
        method: "POST",
        path: "/accounts/acc_1/shipping-addresses/adr_1/default",
        status: 200,
        expected: { id: "adr_1", version: 71, status: "default-set" },
      },
      {
        method: "POST",
        path: "/accounts/acc_1/shipping-addresses/adr_1/archive",
        status: 200,
        expected: { id: "adr_1", version: 71, status: "archived" },
      },
    ] as const;
    for (const testCase of shippingCases) {
      const { response, body } = await requestJson(app, testCase.path, {
        method: testCase.method,
        body: JSON.stringify("body" in testCase ? testCase.body : {}),
      });
      expect(response.status).toBe(testCase.status);
      expect(body).toMatchObject(testCase.expected);
    }
  });

  it("rejects unknown role keys before issuing membership or invitation commands", async () => {
    const services = createServices();
    const app = buildApp(services, { ...actor, roleKey: "platform-admin" });
    const expectedError = {
      error: {
        code: "validation_failed",
        message: expect.stringContaining("owner, manager, fulfillment, viewer"),
      },
    };

    const membershipGrant = await requestJson(app, "/memberships", {
      method: "POST",
      body: JSON.stringify({ membershipId: "mbr_bad", userId: "usr_2", accountId: "acc_1", roleKey: "onwer" }),
    });
    expect(membershipGrant.response.status).toBe(400);
    expect(membershipGrant.body).toMatchObject(expectedError);

    const membershipRoleChange = await requestJson(app, "/memberships/mbr_existing/role", {
      method: "PUT",
      body: JSON.stringify({ roleKey: "onwer" }),
    });
    expect(membershipRoleChange.response.status).toBe(400);
    expect(membershipRoleChange.body).toMatchObject(expectedError);

    const invitationCreate = await requestJson(app, "/invitations", {
      method: "POST",
      body: JSON.stringify({
        invitationId: "ivt_bad",
        accountId: "acc_1",
        email: "invitee@example.com",
        roleKey: "onwer",
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
    });
    expect(invitationCreate.response.status).toBe(400);
    expect(invitationCreate.body).toMatchObject(expectedError);

    const guestClaim = await requestJson(app, "/internal/auth/guest-accounts/acc_guest/claim", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_1", roleKey: "onwer" }),
    });
    expect(guestClaim.response.status).toBe(400);
    expect(guestClaim.body).toMatchObject(expectedError);

    expect(services.memberships.commandHandler).not.toHaveBeenCalled();
    expect(services.invitations.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects marketplace attempts to assign platform-admin through membership and invitation writes", async () => {
    const services = createServices();
    const app = buildApp(services, { ...actor, roleKey: "owner" });

    const membershipGrant = await requestJson(app, "/memberships", {
      method: "POST",
      body: JSON.stringify({
        membershipId: "mbr_platform",
        userId: "usr_2",
        accountId: "acc_1",
        roleKey: "platform-admin",
      }),
    });
    expect(membershipGrant.response.status).toBe(400);
    expect(membershipGrant.body).toMatchObject({ error: { code: "validation_failed" } });

    const membershipRoleChange = await requestJson(app, "/memberships/mbr_existing/role", {
      method: "PUT",
      body: JSON.stringify({ roleKey: "platform-admin" }),
    });
    expect(membershipRoleChange.response.status).toBe(400);
    expect(membershipRoleChange.body).toMatchObject({ error: { code: "validation_failed" } });

    const invitationCreate = await requestJson(app, "/invitations", {
      method: "POST",
      body: JSON.stringify({
        invitationId: "ivt_platform",
        accountId: "acc_1",
        email: "invitee@example.com",
        roleKey: "platform-admin",
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
    });
    expect(invitationCreate.response.status).toBe(400);
    expect(invitationCreate.body).toMatchObject({ error: { code: "validation_failed" } });

    expect(services.memberships.commandHandler).not.toHaveBeenCalled();
    expect(services.invitations.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects attempts to assign roles above the marketplace actor role", async () => {
    const services = createServices();
    const app = buildApp(services, { ...actor, roleKey: "manager" });

    const membershipGrant = await requestJson(app, "/memberships", {
      method: "POST",
      body: JSON.stringify({ membershipId: "mbr_owner", userId: "usr_2", accountId: "acc_1", roleKey: "owner" }),
    });
    expect(membershipGrant.response.status).toBe(403);
    expect(membershipGrant.body).toMatchObject({ error: { code: "authorization_forbidden" } });

    const membershipRoleChange = await requestJson(app, "/memberships/mbr_existing/role", {
      method: "PUT",
      body: JSON.stringify({ roleKey: "owner" }),
    });
    expect(membershipRoleChange.response.status).toBe(403);
    expect(membershipRoleChange.body).toMatchObject({ error: { code: "authorization_forbidden" } });

    const invitationCreate = await requestJson(app, "/invitations", {
      method: "POST",
      body: JSON.stringify({
        invitationId: "ivt_owner",
        accountId: "acc_1",
        email: "invitee@example.com",
        roleKey: "owner",
        expiresAt: "2026-07-01T00:00:00.000Z",
      }),
    });
    expect(invitationCreate.response.status).toBe(403);
    expect(invitationCreate.body).toMatchObject({ error: { code: "authorization_forbidden" } });

    expect(services.memberships.commandHandler).not.toHaveBeenCalled();
    expect(services.invitations.commandHandler).not.toHaveBeenCalled();
  });

  it("derives internal invitation accept role from the invitation aggregate", async () => {
    const services = createServices();
    const app = buildApp(services);

    const invitationAccept = await requestJson(app, "/internal/auth/invitations/ivt_1/accept", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_1", acceptanceTokenHash: "hashed:invite_token" }),
    });

    expect(invitationAccept.response.status).toBe(200);
    expect(services.memberships.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "GrantMembership",
          accountId: "acc_1",
          roleKey: "owner",
        }),
      }),
    );
  });

  it("rejects internal invitation accept when a stored invitation attempts platform-admin", async () => {
    const baseServices = createServices();
    const services = createServices({
      invitations: {
        ...baseServices.invitations,
        getInvitationState: vi.fn(async (invitationId: string) => ({
          id: invitationId,
          accountId: actor.accountId,
          email: "invitee@example.com",
          roleKey: "platform-admin",
          status: "pending",
          expiresAt: "2027-07-01T00:00:00.000Z",
          acceptanceTokenHash: "hashed:invite_token",
          acceptanceTokenExpiresAt: "2027-06-01T00:00:00.000Z",
          acceptanceTokenConsumedAt: null,
          acceptedByUserId: null,
        })) as unknown as IdentityServices["invitations"]["getInvitationState"],
      },
      memberships: {
        ...baseServices.memberships,
        commandHandler: vi.fn(async () => {
          throw new IdentityDomainError("Platform-admin can only be assigned by platform bootstrap.");
        }) as unknown as IdentityServices["memberships"]["commandHandler"],
      },
    });

    const app = buildApp(services);
    const invitationAccept = await requestJson(app, "/internal/auth/invitations/ivt_1/accept", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_1", acceptanceTokenHash: "hashed:invite_token" }),
    });

    expect(invitationAccept.response.status).toBe(403);
    expect(invitationAccept.body).toMatchObject({
      error: {
        code: "authorization_forbidden",
        message: "Platform-admin can only be assigned by platform bootstrap.",
      },
    });
    expect(services.invitations.commandHandler).not.toHaveBeenCalled();
  });

  it("returns API-key secrets, lookup results, and revocation receipts from the committed command response", async () => {
    const services = createServices();
    const app = buildApp(services);

    const created = await requestJson(app, "/api-keys", {
      method: "POST",
      body: JSON.stringify({ userId: actor.userId, name: "Automation" }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^key_/),
        version: 51,
        status: "active",
        secret: "key_secret_1_value",
        keyPrefix: "key_secret_1",
      }),
    );

    const rotated = await requestJson(app, "/api-keys/key_existing/rotate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(rotated.response.status).toBe(200);
    expect(rotated.body).toMatchObject({
      id: "key_existing",
      version: 51,
      status: "active",
      secret: "key_secret_1_value",
      keyPrefix: "key_secret_1",
    });

    const listed = await requestJson(app, "/api-keys");
    expect(listed.response.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("key_secret_1_value");
    expect(JSON.stringify(listed.body)).not.toContain("secret");

    const detail = await requestJson(app, "/api-keys/key_existing");
    expect(detail.response.status).toBe(200);
    expect(detail.body).toMatchObject({ api_key_id: "key_existing", user_id: actor.userId });
    expect(JSON.stringify(detail.body)).not.toContain("key_secret_1_value");
    expect(JSON.stringify(detail.body)).not.toContain("secret");

    const resolved = await requestJson(app, "/api-keys/resolve", {
      method: "POST",
      body: JSON.stringify({ secret: "key_secret_1_value" }),
    });
    expect(resolved.response.status).toBe(200);
    expect(resolved.body).toMatchObject({
      apiKeyId: "key_existing",
      userId: actor.userId,
      keyPrefix: "key_secret_1",
      version: 51,
      status: "active",
    });

    const revoked = await requestJson(app, "/api-keys/key_existing/revoke", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(revoked.response.status).toBe(200);
    expect(revoked.body).toMatchObject({
      id: "key_existing",
      version: 51,
      status: "revoked",
    });
    expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM identity_api_key_secrets"), [
      "key_existing",
    ]);
  });

  it("rejects a revoked API-key secret after revocation invalidates the stored secret", async () => {
    let secretPresent = true;
    let apiKeyStatus: "active" | "revoked" = "active";
    const services = createServices();
    vi.mocked(services.db.query).mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("DELETE FROM identity_api_key_secrets")) {
        secretPresent = false;
        return { rows: [] };
      }
      if (sql.includes("FROM identity_api_key_secrets")) {
        return {
          rows:
            secretPresent && params[0] === "key_secret_1"
              ? [
                  {
                    api_key_id: "key_existing",
                    user_id: actor.userId,
                    key_prefix: "key_secret_1",
                    secret_hash: "hashed:key_secret_1_value",
                    status: apiKeyStatus,
                  },
                ]
              : [],
        };
      }
      return { rows: [] };
    });
    const apiKeyState = (status: "active" | "revoked") => ({
      id: "key_existing" as never,
      userId: actor.userId as never,
      name: "Automation",
      keyPrefix: "key_secret_1",
      status,
      lastUsedAt: null,
    });
    const apiKeyCommandResult = (version: number, status: "active" | "revoked") => ({
      version,
      state: apiKeyState(status),
      newEvents: [],
      storedEvents: [],
    });
    vi.mocked(services.apiKeys.commandHandler).mockImplementation(async (input) => {
      if (input.command.type === "RevokeApiKey") {
        apiKeyStatus = "revoked";
        return apiKeyCommandResult(52, "revoked");
      }
      return apiKeyCommandResult(51, apiKeyStatus);
    });
    const app = buildApp(services);

    const resolved = await requestJson(app, "/api-keys/resolve", {
      method: "POST",
      body: JSON.stringify({ secret: "key_secret_1_value" }),
    });
    expect(resolved.response.status).toBe(200);

    const revoked = await requestJson(app, "/api-keys/key_existing/revoke", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(revoked.response.status).toBe(200);

    const rejected = await requestJson(app, "/api-keys/resolve", {
      method: "POST",
      body: JSON.stringify({ secret: "key_secret_1_value" }),
    });
    expect(rejected.response.status).toBe(401);
    expect(rejected.body).toMatchObject({ error: { code: "authentication_required" } });
  });

  it("rejects a stale API-key secret row when the aggregate is already revoked", async () => {
    const services = createServices();
    vi.mocked(services.apiKeys.commandHandler).mockRejectedValue(
      new IdentityDomainError("Only active API keys can change."),
    );
    const app = buildApp(services);

    const rejected = await requestJson(app, "/api-keys/resolve", {
      method: "POST",
      body: JSON.stringify({ secret: "key_secret_1_value" }),
    });

    expect(rejected.response.status).toBe(401);
    expect(rejected.body).toMatchObject({ error: { code: "authentication_required" } });
  });

  it("keeps API-key create and rotate behind owner or platform-admin access", async () => {
    const requestActor = { ...actor, userId: "usr_requester" };
    const app = buildApp(createServices(), requestActor);

    const createForbidden = await requestJson(app, "/api-keys", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_other", name: "Automation" }),
    });
    expect(createForbidden.response.status).toBe(403);
    expect(createForbidden.body).toMatchObject({ error: { code: "authorization_forbidden" } });

    const rotateForbidden = await requestJson(app, "/api-keys/key_existing/rotate", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(rotateForbidden.response.status).toBe(403);
    expect(rotateForbidden.body).toMatchObject({ error: { code: "authorization_forbidden" } });
  });

  it("rejects malformed API-key user IDs before issuing secrets or commands", async () => {
    const services = createServices();
    const app = buildApp(services, { ...actor, roleKey: "platform-admin" });

    const created = await requestJson(app, "/api-keys", {
      method: "POST",
      body: JSON.stringify({ userId: "user_1", name: "Automation" }),
    });

    expect(created.response.status).toBe(400);
    expect(created.body).toMatchObject({
      error: {
        code: "validation_failed",
        message: "userId must start with usr_.",
      },
    });
    expect(services.auth.issueOpaqueToken).not.toHaveBeenCalled();
    expect(services.apiKeys.commandHandler).not.toHaveBeenCalled();
  });

  it("rejects unknown API-key users before issuing secrets or commands", async () => {
    const baseServices = createServices();
    const services = createServices({
      users: {
        ...baseServices.users,
        getUser: vi.fn(async () => null) as unknown as IdentityServices["users"]["getUser"],
      },
    });
    const app = buildApp(services, { ...actor, roleKey: "platform-admin" });

    const created = await requestJson(app, "/api-keys", {
      method: "POST",
      body: JSON.stringify({ userId: "usr_missing", name: "Automation" }),
    });

    expect(created.response.status).toBe(404);
    expect(created.body).toMatchObject({
      error: {
        code: "not_found",
        message: "User not found.",
      },
    });
    expect(services.auth.issueOpaqueToken).not.toHaveBeenCalled();
    expect(services.apiKeys.commandHandler).not.toHaveBeenCalled();
  });

  it("returns not found when rotating a missing API key", async () => {
    const baseServices = createServices();
    const services = createServices({
      apiKeys: {
        ...baseServices.apiKeys,
        getApiKey: vi.fn(async () => null) as unknown as IdentityServices["apiKeys"]["getApiKey"],
      },
    });
    const app = buildApp(services);

    const rotated = await requestJson(app, "/api-keys/key_missing/rotate", {
      method: "POST",
      body: JSON.stringify({}),
    });

    expect(rotated.response.status).toBe(404);
    expect(rotated.body).toMatchObject({ error: { code: "not_found" } });
  });
});
