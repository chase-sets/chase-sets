import {
  createAccountUserTestActor,
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createTestApp,
  createTestEventStoreContext,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { AUTH_GUEST_CHECKOUT_PERMISSIONS, AUTH_GUEST_CHECKOUT_ROLE_KEY } from "../runtime-support/runtime";
import { registerGuestCheckoutRoutes } from "./guest-checkout-routes";
import type { AuthApiEnv } from "./support";

const {
  mockClaimGuestAccount,
  mockConvergeGuestAccountDisplayName,
  mockCreateIdentityAuthRequestClient,
  mockCreateGuestAccount,
  mockRegisterPasskeyCredential,
  mockStartInteractiveAuth,
  mockVerifyPasskeyRegistration,
} = vi.hoisted(() => ({
  mockClaimGuestAccount: vi.fn(),
  mockConvergeGuestAccountDisplayName: vi.fn(),
  mockCreateIdentityAuthRequestClient: vi.fn(),
  mockCreateGuestAccount: vi.fn(),
  mockRegisterPasskeyCredential: vi.fn(),
  mockStartInteractiveAuth: vi.fn(),
  mockVerifyPasskeyRegistration: vi.fn(),
}));

vi.mock("../runtime-support/services", async () => {
  const actual = await vi.importActual<typeof import("../runtime-support/services")>("../runtime-support/services");

  return {
    ...actual,
    startInteractiveAuth: mockStartInteractiveAuth,
  };
});

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

vi.mock("../auth-support/webauthn", () => ({
  verifyPasskeyRegistration: mockVerifyPasskeyRegistration,
}));

function buildApp(
  services: Partial<AuthServices> & Pick<AuthServices, "auth" | "db" | "identity">,
  actor:
    | ReturnType<typeof createAnonymousTestActor>
    | ReturnType<typeof createAccountUserTestActor> = createAnonymousTestActor(),
) {
  return createTestApp<AuthApiEnv>({
    actor,
    context: createTestEventStoreContext(createInternalSystemTestActor(), {
      tenantId: "ten_test",
      trace: {},
    }),
    routes: (app) => {
      registerGuestCheckoutRoutes(app, services as AuthServices);
    },
  });
}

function createServices(options: { existingUser?: { user_id: string } | null }) {
  return {
    db: {
      query: vi.fn(async () => ({ rows: [] })),
    },
    notificationOutbox: {
      enqueueNotification: vi.fn(async () => undefined),
    },
    auth: {
      issueOpaqueToken: vi.fn(() => "guest_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async () => options.existingUser ?? null),
    },
  } as unknown as Pick<AuthServices, "auth" | "db" | "identity" | "notificationOutbox">;
}

function createGuestActor(accountId = "acc_guest") {
  return createAccountUserTestActor({
    accountId,
    roleKey: AUTH_GUEST_CHECKOUT_ROLE_KEY,
    permissions: AUTH_GUEST_CHECKOUT_PERMISSIONS,
  });
}

function guestTokenRecord(
  overrides: Partial<{
    token_id: string;
    account_id: string;
    contact_email: string | null;
    contact_name: string | null;
    token_hash: string;
    expires_at: string;
    revoked_at: string | null;
  }> = {},
) {
  return {
    token_id: "cmd_guest",
    account_id: "acc_guest",
    contact_email: "buyer@example.com" as string | null,
    contact_name: "Buyer Example" as string | null,
    token_hash: "hashed:guest_token",
    expires_at: "2030-05-04T16:00:00.000Z",
    revoked_at: null as string | null,
    ...overrides,
  };
}

function useGuestTokenState(
  services: ReturnType<typeof createServices>,
  initialRecord: ReturnType<typeof guestTokenRecord>,
) {
  let record = { ...initialRecord };
  vi.mocked(services.db.query).mockImplementation(async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("FROM identity_guest_checkout_tokens")) {
      return { rows: [record] };
    }
    if (sql.includes("SET contact_email = $3")) {
      const isUnbound = !String(record.contact_email ?? "").trim() && !String(record.contact_name ?? "").trim();
      if (!isUnbound) {
        return { rows: [] };
      }
      record = {
        ...record,
        contact_email: String(params?.[2] ?? ""),
        contact_name: String(params?.[3] ?? ""),
      };
      return { rows: [record] };
    }
    return { rows: [] };
  });
  return { read: () => record };
}

useMockReset();

describe("guest checkout auth routes", () => {
  it("starts contact-less guest checkout for absent empty and whitespace email", async () => {
    for (const body of [{}, { email: "" }, { email: "   ", displayName: "Ignored Name" }]) {
      const services = createServices({ existingUser: null });
      mockCreateGuestAccount.mockResolvedValue({ accountId: "acc_guest" });
      mockCreateIdentityAuthRequestClient.mockReturnValue({
        createGuestAccount: mockCreateGuestAccount,
      });
      const app = buildApp(services);

      const response = await app.request("/guest-checkout/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        accountId: "acc_guest",
        guestToken: "guest_token",
        expiresAt: expect.any(String),
      });
      expect(mockCreateGuestAccount).toHaveBeenLastCalledWith({ email: "", displayName: "Guest" });
      expect(services.identity.getUserByEmail).not.toHaveBeenCalled();
      const insertParams = vi.mocked(services.db.query).mock.calls[0]?.[1];
      expect(insertParams?.[2]).toBeNull();
      expect(insertParams?.[3]).toBeNull();
      vi.clearAllMocks();
    }
  });

  it("rejects guest checkout when the email already belongs to a user", async () => {
    const services = createServices({ existingUser: { user_id: "usr_existing" } });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createGuestAccount: mockCreateGuestAccount,
    });
    const app = buildApp(services);

    const response = await app.request("/guest-checkout/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Jane Smith",
        email: " Jane@Example.com ",
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "account_sign_in_required",
        message: "Sign in to continue checkout with this email.",
      },
    });
    expect(services.identity.normalizeEmail).toHaveBeenCalledWith(" Jane@Example.com ");
    expect(services.identity.getUserByEmail).toHaveBeenCalledWith("jane@example.com");
    expect(mockCreateIdentityAuthRequestClient).not.toHaveBeenCalled();
    expect(mockCreateGuestAccount).not.toHaveBeenCalled();
  });

  it("preserves contact-full guest checkout", async () => {
    const services = createServices({ existingUser: null });
    mockCreateGuestAccount.mockResolvedValue({ accountId: "acc_guest" });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      createGuestAccount: mockCreateGuestAccount,
    });
    const app = buildApp(services);

    const response = await app.request("/guest-checkout/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Jane Smith",
        email: "jane@example.com",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_guest",
      guestToken: "guest_token",
      expiresAt: expect.any(String),
    });
    expect(mockCreateGuestAccount).toHaveBeenCalledWith({
      email: "jane@example.com",
      displayName: "Jane Smith",
    });
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_guest_checkout_tokens"),
      expect.arrayContaining(["acc_guest", "jane@example.com", "Jane Smith"]),
    );
  });

  it("binds Guest Contact once with collision and limiter contracts", async () => {
    const services = createServices({ existingUser: null });
    useGuestTokenState(
      services,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_bind" }),
    );
    mockConvergeGuestAccountDisplayName.mockResolvedValue({
      accountId: "acc_guest_bind",
      displayName: "Buyer Example",
      converged: true,
      snapshots: [],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });
    const app = buildApp(services, createGuestActor("acc_guest_bind"));

    const response = await app.request("/guest-checkout/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: "chase_sets_guest_checkout=guest_token",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ email: " Buyer@Example.com ", displayName: " Buyer Example " }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_guest_bind",
      contactEmail: "buyer@example.com",
      contactName: "Buyer Example",
    });
    expect(services.identity.getUserByEmail).toHaveBeenCalledWith("buyer@example.com");
    expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("SET contact_email = $3"), [
      "hashed:guest_token",
      "acc_guest_bind",
      "buyer@example.com",
      "Buyer Example",
    ]);

    const collisionServices = createServices({ existingUser: { user_id: "usr_existing" } });
    useGuestTokenState(
      collisionServices,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_collision" }),
    );
    const collisionApp = buildApp(collisionServices, createGuestActor("acc_guest_collision"));
    const collisionResponse = await collisionApp.request("/guest-checkout/contact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: "chase_sets_guest_checkout=guest_token",
        "x-forwarded-for": "203.0.113.11",
      },
      body: JSON.stringify({ email: "member@example.com", displayName: "Member" }),
    });
    expect(collisionResponse.status).toBe(409);
    await expect(collisionResponse.json()).resolves.toEqual({
      error: {
        code: "account_sign_in_required",
        message: "Sign in to continue checkout with this email.",
      },
    });
    expect(collisionServices.db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET contact_email = $3"),
      expect.anything(),
    );

    const limitedServices = createServices({ existingUser: null });
    useGuestTokenState(
      limitedServices,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_limited" }),
    );
    const limitedApp = buildApp(limitedServices, createGuestActor("acc_guest_limited"));
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const limitedResponse = await limitedApp.request("/guest-checkout/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: "chase_sets_guest_checkout=guest_token",
          "x-forwarded-for": `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ email: "", displayName: "" }),
      });
      statuses.push(limitedResponse.status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("keeps identical contact idempotent and locks changed email or name", async () => {
    const services = createServices({ existingUser: null });
    useGuestTokenState(
      services,
      guestTokenRecord({
        account_id: "acc_guest_locked",
        contact_email: "buyer@example.com",
        contact_name: "Buyer Example",
      }),
    );
    mockConvergeGuestAccountDisplayName.mockResolvedValue({
      accountId: "acc_guest_locked",
      displayName: "Buyer Example",
      converged: false,
      snapshots: [],
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });
    const app = buildApp(services, createGuestActor("acc_guest_locked"));
    const bind = (body: Record<string, string>, ip: string) =>
      app.request("/guest-checkout/contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          cookie: "chase_sets_guest_checkout=guest_token",
          "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
      });

    const identical = await bind({ email: " BUYER@example.com ", displayName: " Buyer Example " }, "203.0.113.20");
    expect(identical.status).toBe(200);
    await expect(identical.json()).resolves.toEqual({
      accountId: "acc_guest_locked",
      contactEmail: "buyer@example.com",
      contactName: "Buyer Example",
    });

    for (const [body, ip] of [
      [{ email: "other@example.com", displayName: "Buyer Example" }, "203.0.113.21"],
      [{ email: "buyer@example.com", displayName: "Different Name" }, "203.0.113.22"],
    ] as const) {
      const locked = await bind(body, ip);
      expect(locked.status).toBe(409);
      await expect(locked.json()).resolves.toEqual({
        error: {
          code: "guest_contact_locked",
          message: "Guest contact cannot be changed after it is set.",
        },
      });
    }
    expect(services.identity.getUserByEmail).not.toHaveBeenCalled();
    expect(services.db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET contact_email = $3"),
      expect.anything(),
    );
    expect(services.db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET revoked_at = now()"),
      expect.anything(),
    );
  });

  it("revokes the guest checkout token when checkout is exited", async () => {
    const services = createServices({ existingUser: null });
    const app = buildApp(services);

    const response = await app.request("/guest-checkout/exit", {
      method: "POST",
      headers: {
        cookie: "chase_sets_guest_checkout=guest_token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "guest-checkout-ended" });
    expect(services.auth.hashSecret).toHaveBeenCalledWith("guest_token");
    expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE identity_guest_checkout_tokens"), [
      "hashed:guest_token",
    ]);
  });

  describe("guards only email-dependent guest claim routes", () => {
    it("guards claim-link request before claim-token persistence for unbound contact", async () => {
      const services = createServices({ existingUser: null });
      useGuestTokenState(services, guestTokenRecord({ contact_email: null, contact_name: null }));
      const app = buildApp(services, createGuestActor());

      const response = await app.request("/guest-checkout/claim-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: "chase_sets_guest_checkout=guest_token" },
        body: JSON.stringify({ paymentId: "pay_unbound" }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "guest_contact_required",
          message: "Email and name are required to continue guest checkout.",
        },
      });
      expect(services.db.query).not.toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO identity_guest_checkout_claim_tokens"),
        expect.anything(),
      );
      expect(services.notificationOutbox.enqueueNotification).not.toHaveBeenCalled();
    });

    it("guards magic-link claim before claim-token consumption for legacy empty contact", async () => {
      const services = createServices({ existingUser: null });
      useGuestTokenState(services, guestTokenRecord({ contact_email: "  ", contact_name: "" }));
      const app = buildApp(services, createGuestActor());

      const response = await app.request("/guest-checkout/claim-with-magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: "chase_sets_guest_checkout=guest_token" },
        body: JSON.stringify({ paymentId: "pay_unbound", token: "claim_token" }),
      });

      expect(response.status).toBe(400);
      expect(services.db.query).not.toHaveBeenCalledWith(
        expect.stringContaining("UPDATE identity_guest_checkout_claim_tokens"),
        expect.anything(),
      );
      expect(mockClaimGuestAccount).not.toHaveBeenCalled();
    });

    it("guards passkey claim before destructive challenge consumption for unbound contact", async () => {
      const services = createServices({ existingUser: null });
      useGuestTokenState(services, guestTokenRecord({ contact_email: "", contact_name: " " }));
      const app = buildApp(services, createGuestActor());

      const response = await app.request("/guest-checkout/claim-with-passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: "chase_sets_guest_checkout=guest_token" },
        body: JSON.stringify({ challengeId: "chl_unbound", challenge: "challenge" }),
      });

      expect(response.status).toBe(400);
      expect(services.db.query).not.toHaveBeenCalledWith(
        expect.stringContaining("UPDATE identity_challenges"),
        expect.anything(),
      );
      expect(mockCreateIdentityAuthRequestClient).not.toHaveBeenCalled();
    });

    it("returns nullable claim-context contact for legacy whitespace contact", async () => {
      const services = createServices({ existingUser: null });
      useGuestTokenState(services, guestTokenRecord({ contact_email: " \t ", contact_name: "" }));
      const app = buildApp(services, createGuestActor());

      const response = await app.request("/guest-checkout/claim-context", {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: "chase_sets_guest_checkout=guest_token" },
        body: JSON.stringify({ paymentId: "pay_unbound" }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        accountId: "acc_guest",
        paymentId: "pay_unbound",
        contactEmail: null,
        contactName: null,
      });
    });

    it("leaves continuation unguarded and preserves invalid continuation behavior", async () => {
      const services = createServices({ existingUser: null });
      const app = buildApp(services);

      const response = await app.request("/guest-checkout/claim-with-continuation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: "pay_invalid", continuation: "invalid" }),
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Claim link is invalid or expired." });
      expect(services.db.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE identity_guest_checkout_claim_tokens"),
        ["hashed:invalid", "pay_invalid"],
      );
    });
  });

  it("requests an emailed guest claim continuation without putting the continuation in the response", async () => {
    const services = createServices({ existingUser: null });
    vi.mocked(services.auth.issueOpaqueToken)
      .mockReturnValueOnce("claim_token")
      .mockReturnValueOnce("continuation_token");
    vi.mocked(services.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM identity_guest_checkout_tokens")) {
        return {
          rows: [
            {
              token_id: "cmd_guest",
              account_id: "acc_guest",
              contact_email: "buyer@example.com",
              contact_name: "Buyer Example",
              token_hash: "hashed:guest_token",
              expires_at: "2026-05-04T16:00:00.000Z",
              revoked_at: null,
            },
          ],
        };
      }

      return { rows: [] };
    });
    const app = buildApp(services, createGuestActor());

    const response = await app.request("/guest-checkout/claim-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: "chase_sets_guest_checkout=guest_token",
      },
      body: JSON.stringify({
        paymentId: "pay_guest_1",
        origin: "https://marketplace.chasesets.com",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      tokenId: expect.stringMatching(/^cmd_/),
      token: "claim_token",
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("continuation_token");
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_guest_checkout_claim_tokens"),
      expect.arrayContaining([
        "acc_guest",
        "pay_guest_1",
        "buyer@example.com",
        "Buyer Example",
        "hashed:claim_token",
        "hashed:continuation_token",
      ]),
    );
    expect(services.notificationOutbox.enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "auth.guest-checkout-claim-link.requested",
          templateData: {
            claimLink:
              "https://marketplace.chasesets.com/checkout/payments/pay_guest_1?claimContinuation=continuation_token",
          },
        }),
      }),
    );
  });

  it("retains original claim identity after guest_contact_locked and revokes on claim", async () => {
    const services = createServices({ existingUser: { user_id: "usr_existing" } });
    const tokenRecord = guestTokenRecord({
      account_id: "acc_guest_original_claim",
      contact_email: "original@example.com",
      contact_name: "Original Buyer",
    });
    let claimRecord: ReturnType<typeof guestTokenRecord> | null = null;
    vi.mocked(services.auth.issueOpaqueToken)
      .mockReturnValueOnce("claim_token")
      .mockReturnValueOnce("continuation_token");
    vi.mocked(services.db.query).mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM identity_guest_checkout_tokens")) {
        return { rows: [tokenRecord] };
      }
      if (sql.includes("INSERT INTO identity_guest_checkout_claim_tokens")) {
        claimRecord = guestTokenRecord({
          token_id: String(params?.[0]),
          account_id: String(params?.[1]),
          contact_email: String(params?.[3]),
          contact_name: String(params?.[4]),
          token_hash: String(params?.[5]),
        });
        return { rows: [] };
      }
      if (sql.includes("UPDATE identity_guest_checkout_claim_tokens")) {
        return {
          rows: claimRecord
            ? [
                {
                  token_id: claimRecord.token_id,
                  account_id: claimRecord.account_id,
                  payment_id: "pay_original",
                  email: claimRecord.contact_email,
                  display_name: claimRecord.contact_name,
                  expires_at: claimRecord.expires_at,
                  consumed_at: new Date().toISOString(),
                },
              ]
            : [],
        };
      }
      return { rows: [] };
    });
    mockClaimGuestAccount.mockResolvedValue({ membershipId: "mem_guest" });
    mockCreateIdentityAuthRequestClient.mockReturnValue({ claimGuestAccount: mockClaimGuestAccount });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_existing",
      sessionId: "ses_original",
      sessionToken: "session_token",
      session: { session_id: "ses_original", expires_at: "2030-05-04T16:00:00.000Z" },
      memberships: [],
    });
    const app = buildApp(services, createGuestActor("acc_guest_original_claim"));
    const headers = {
      "Content-Type": "application/json",
      cookie: "chase_sets_guest_checkout=guest_token",
    };

    const claimLink = await app.request("/guest-checkout/claim-link/request", {
      method: "POST",
      headers,
      body: JSON.stringify({ paymentId: "pay_original" }),
    });
    expect(claimLink.status).toBe(200);

    const locked = await app.request("/guest-checkout/contact", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "redirect@example.com", displayName: "Redirected Buyer" }),
    });
    expect(locked.status).toBe(409);
    await expect(locked.json()).resolves.toMatchObject({ error: { code: "guest_contact_locked" } });
    expect(services.db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET contact_email = $3"),
      expect.anything(),
    );
    expect(services.db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET revoked_at = now()"),
      expect.anything(),
    );

    const claimed = await app.request("/guest-checkout/claim-with-magic-link", {
      method: "POST",
      headers,
      body: JSON.stringify({ paymentId: "pay_original", token: "claim_token" }),
    });
    expect(claimed.status).toBe(200);
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE identity_guest_checkout_claim_tokens"),
      ["hashed:claim_token", "acc_guest_original_claim", "pay_original", "original@example.com"],
    );
    expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("SET revoked_at = now()"), [
      "hashed:guest_token",
    ]);
  });

  it("preserves guest-token revocation after a successful passkey claim", async () => {
    const services = createServices({ existingUser: { user_id: "usr_passkey" } });
    vi.mocked(services.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes("FROM identity_guest_checkout_tokens")) {
        return { rows: [guestTokenRecord({ account_id: "acc_guest_passkey" })] };
      }
      if (sql.includes("UPDATE identity_auth_challenges")) {
        return {
          rows: [
            {
              challenge_id: "chl_guest_passkey",
              purpose: "passkey-register",
              email: "buyer@example.com",
              user_id: null,
              challenge_value: "passkey-challenge",
              expires_at: "2030-05-04T16:00:00.000Z",
              consumed_at: new Date().toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });
    mockVerifyPasskeyRegistration.mockResolvedValue({
      externalCredentialId: "external_credential",
      publicKey: "public_key",
      signCount: 0,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    });
    mockRegisterPasskeyCredential.mockResolvedValue({ credentialId: "crd_registered" });
    mockClaimGuestAccount.mockResolvedValue({ membershipId: "mem_guest" });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      registerPasskeyCredential: mockRegisterPasskeyCredential,
      claimGuestAccount: mockClaimGuestAccount,
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_passkey",
      sessionId: "ses_passkey",
      sessionToken: "session_token",
      session: { session_id: "ses_passkey", expires_at: "2030-05-04T16:00:00.000Z" },
      memberships: [],
    });
    const app = buildApp(services, createGuestActor("acc_guest_passkey"));

    const response = await app.request("/guest-checkout/claim-with-passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "chase_sets_guest_checkout=guest_token" },
      body: JSON.stringify({
        challengeId: "chl_guest_passkey",
        challenge: "passkey-challenge",
        webauthnResponse: { id: "external_credential" },
      }),
    });

    expect(response.status).toBe(200);
    expect(mockRegisterPasskeyCredential).toHaveBeenCalledWith({
      userId: "usr_passkey",
      credentialId: expect.stringMatching(/^crd_/),
    });
    expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("SET revoked_at = now()"), [
      "hashed:guest_token",
    ]);
  });

  it("consumes a guest claim continuation without requiring the guest checkout cookie", async () => {
    const services = createServices({ existingUser: { user_id: "usr_existing" } });
    vi.mocked(services.db.query).mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE identity_guest_checkout_claim_tokens")) {
        return {
          rows: [
            {
              token_id: "cmd_claim",
              account_id: "acc_guest",
              payment_id: "pay_guest_1",
              email: "buyer@example.com",
              display_name: "Buyer Example",
              expires_at: "2026-05-04T16:00:00.000Z",
              consumed_at: null,
            },
          ],
        };
      }

      return { rows: [] };
    });
    mockClaimGuestAccount.mockResolvedValue({ membershipId: "mem_guest" });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      claimGuestAccount: mockClaimGuestAccount,
    });
    mockStartInteractiveAuth.mockResolvedValue({
      type: "session-started",
      userId: "usr_existing",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1", expires_at: "2026-05-04T16:00:00.000Z" },
      memberships: [],
    });
    const app = buildApp(services);

    const response = await app.request("/guest-checkout/claim-with-continuation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentId: "pay_guest_1",
        continuation: "continuation_token",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      type: "session-started",
      sessionToken: "session_token",
    });
    expect(services.auth.hashSecret).toHaveBeenCalledWith("continuation_token");
    expect(mockClaimGuestAccount).toHaveBeenCalledWith({
      accountId: "acc_guest",
      userId: "usr_existing",
      roleKey: "owner",
    });
    expect(services.db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE identity_guest_checkout_tokens"), [
      "acc_guest",
    ]);
  });
});

/**
 * The guest checkout token state a concurrent-bind race loser sees: the token
 * is unbound when this request reads it, its own bind writes nothing because
 * another request won, and the re-read shows that winner's contact.
 */
function useRaceLostTokenState(
  services: ReturnType<typeof createServices>,
  winner: Readonly<{ accountId: string; contactEmail: string; contactName: string }>,
) {
  let reads = 0;
  vi.mocked(services.db.query).mockImplementation(async (sql: string) => {
    if (sql.includes("FROM identity_guest_checkout_tokens")) {
      reads += 1;
      return {
        rows: [
          guestTokenRecord({
            account_id: winner.accountId,
            contact_email: reads === 1 ? null : winner.contactEmail,
            contact_name: reads === 1 ? null : winner.contactName,
          }),
        ],
      };
    }
    if (sql.includes("SET contact_email = $3")) {
      return { rows: [] };
    }
    return { rows: [] };
  });
}

function bindContact(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
  ip: string,
  cookie = "chase_sets_guest_checkout=guest_token",
) {
  return app.request("/guest-checkout/contact", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie,
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function convergenceResult(accountId: string, displayName: string, converged = true) {
  return {
    accountId,
    displayName,
    converged,
    snapshots: [{ aggregate: "account", id: accountId, version: converged ? 2 : 1, status: "active" }],
  };
}

const CONTACT_EMAIL = "buyer@example.com";
const CONTACT_NAME = "Buyer Example";

describe("guest checkout display-name convergence", () => {
  it("converges the placeholder Account name after the first contact bind", async () => {
    const services = createServices({ existingUser: null });
    const token = useGuestTokenState(
      services,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_ac1" }),
    );
    mockConvergeGuestAccountDisplayName.mockResolvedValue(convergenceResult("acc_guest_ac1", CONTACT_NAME));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });
    const app = buildApp(services, createGuestActor("acc_guest_ac1"));

    const response = await bindContact(
      app,
      { email: " Buyer@Example.com ", displayName: `  ${CONTACT_NAME}  ` },
      "203.0.113.40",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_guest_ac1",
      contactEmail: CONTACT_EMAIL,
      contactName: CONTACT_NAME,
    });
    expect(token.read()).toEqual(expect.objectContaining({ contact_email: CONTACT_EMAIL, contact_name: CONTACT_NAME }));

    // Exactly one invocation, for the token's own Account, carrying the exact
    // trimmed bound contact name. That it appends exactly one
    // `identity.account.profile-updated` with an unchanged empty legal name and
    // takes exactly one reservation row -- and creates no User and no
    // Membership -- is proven where those writes happen, in
    // `bounded-contexts/identity/tests/internal-auth-routes.test.ts`.
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(1);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledWith({
      accountId: "acc_guest_ac1",
      displayName: CONTACT_NAME,
    });
    expect(mockCreateGuestAccount).not.toHaveBeenCalled();
    expect(mockClaimGuestAccount).not.toHaveBeenCalled();
  });

  it("drives display-name convergence from every contact success branch", async () => {
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });

    // Branch one: the first successful bind.
    const firstBind = createServices({ existingUser: null });
    useGuestTokenState(
      firstBind,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_branch_first" }),
    );
    mockConvergeGuestAccountDisplayName.mockResolvedValue(convergenceResult("acc_branch_first", CONTACT_NAME));
    const firstResponse = await bindContact(
      buildApp(firstBind, createGuestActor("acc_branch_first")),
      { email: CONTACT_EMAIL, displayName: CONTACT_NAME },
      "203.0.113.41",
    );
    expect(firstResponse.status).toBe(200);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(1);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenLastCalledWith({
      accountId: "acc_branch_first",
      displayName: CONTACT_NAME,
    });

    // Branch two: the identical resubmission, which returns before any write.
    // Against an already-converged Account this is a no-op that still reaches
    // Identity, and still answers 200 with the bound contact echoed.
    const resubmission = createServices({ existingUser: null });
    useGuestTokenState(
      resubmission,
      guestTokenRecord({
        account_id: "acc_branch_resubmit",
        contact_email: CONTACT_EMAIL,
        contact_name: CONTACT_NAME,
      }),
    );
    mockConvergeGuestAccountDisplayName.mockResolvedValue(
      convergenceResult("acc_branch_resubmit", CONTACT_NAME, false),
    );
    const resubmitResponse = await bindContact(
      buildApp(resubmission, createGuestActor("acc_branch_resubmit")),
      { email: CONTACT_EMAIL, displayName: CONTACT_NAME },
      "203.0.113.42",
    );
    expect(resubmitResponse.status).toBe(200);
    await expect(resubmitResponse.json()).resolves.toEqual({
      accountId: "acc_branch_resubmit",
      contactEmail: CONTACT_EMAIL,
      contactName: CONTACT_NAME,
    });
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(2);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenLastCalledWith({
      accountId: "acc_branch_resubmit",
      displayName: CONTACT_NAME,
    });
    expect(resubmission.db.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET contact_email = $3"),
      expect.anything(),
    );

    // Branch three: the concurrent-bind race loser whose re-read matches.
    const raceLoser = createServices({ existingUser: null });
    useRaceLostTokenState(raceLoser, {
      accountId: "acc_branch_race",
      contactEmail: CONTACT_EMAIL,
      contactName: CONTACT_NAME,
    });
    mockConvergeGuestAccountDisplayName.mockResolvedValue(convergenceResult("acc_branch_race", CONTACT_NAME, false));
    const raceResponse = await bindContact(
      buildApp(raceLoser, createGuestActor("acc_branch_race")),
      { email: CONTACT_EMAIL, displayName: CONTACT_NAME },
      "203.0.113.43",
    );
    expect(raceResponse.status).toBe(200);
    await expect(raceResponse.json()).resolves.toEqual({
      accountId: "acc_branch_race",
      contactEmail: CONTACT_EMAIL,
      contactName: CONTACT_NAME,
    });
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(3);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenLastCalledWith({
      accountId: "acc_branch_race",
      displayName: CONTACT_NAME,
    });
  });

  it("converges only to the winning contact under concurrent binds with different names", async () => {
    const services = createServices({ existingUser: null });
    const token = useGuestTokenState(
      services,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_concurrent" }),
    );
    mockConvergeGuestAccountDisplayName.mockImplementation(async (params: { displayName: string }) =>
      convergenceResult("acc_guest_concurrent", params.displayName),
    );
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });
    const app = buildApp(services, createGuestActor("acc_guest_concurrent"));

    const [winner, loser] = await Promise.all([
      bindContact(app, { email: CONTACT_EMAIL, displayName: "Winning Buyer" }, "203.0.113.44"),
      bindContact(app, { email: CONTACT_EMAIL, displayName: "Losing Buyer" }, "203.0.113.45"),
    ]);

    const statuses = [winner.status, loser.status].sort();
    expect(statuses).toEqual([200, 409]);
    const locked = winner.status === 409 ? winner : loser;
    await expect(locked.json()).resolves.toEqual({
      error: {
        code: "guest_contact_locked",
        message: "Guest contact cannot be changed after it is set.",
      },
    });

    // Exactly one bound contact, exactly one convergence, and it is the
    // winner's name -- the Account is never renamed twice and never renamed to
    // the loser's name.
    expect(token.read().contact_name).toBe("Winning Buyer");
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(1);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledWith({
      accountId: "acc_guest_concurrent",
      displayName: "Winning Buyer",
    });
    expect(mockConvergeGuestAccountDisplayName).not.toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Losing Buyer" }),
    );
  });

  it("ignores a request-body account id and converges only the token's own Account", async () => {
    const services = createServices({ existingUser: null });
    useGuestTokenState(services, guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_a" }));
    mockConvergeGuestAccountDisplayName.mockResolvedValue(convergenceResult("acc_a", CONTACT_NAME));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });
    const app = buildApp(services, createGuestActor("acc_a"));

    const response = await bindContact(
      app,
      { email: CONTACT_EMAIL, displayName: CONTACT_NAME, accountId: "acc_b" },
      "203.0.113.46",
    );

    // The shipped mechanic is that the field is ignored, not rejected: no new
    // route branch, no body authority field, no rejection path.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accountId: "acc_a",
      contactEmail: CONTACT_EMAIL,
      contactName: CONTACT_NAME,
    });
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(1);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledWith({
      accountId: "acc_a",
      displayName: CONTACT_NAME,
    });
    expect(mockConvergeGuestAccountDisplayName).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc_b" }),
    );
  });

  it("resumes convergence after a post-bind Identity failure", async () => {
    const { createIdentityAuthRequestClient } =
      await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");
    const services = createServices({ existingUser: null });
    const token = useGuestTokenState(
      services,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_resume" }),
    );
    const app = buildApp(services, createGuestActor("acc_guest_resume"));

    // The real Auth-to-Identity client over a stubbed transport, so the failure
    // is classified from the rejection the shipped client actually produces
    // rather than from a hand-rolled stand-in.
    const requests: Array<Readonly<{ url: string; body: string }>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: String(init?.body ?? "") });
      return requests.length === 1
        ? new Response(JSON.stringify({ error: { code: "identity_unavailable" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : new Response(JSON.stringify(convergenceResult("acc_guest_resume", CONTACT_NAME)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }) as typeof globalThis.fetch;
    mockCreateIdentityAuthRequestClient.mockImplementation((request: Request) =>
      createIdentityAuthRequestClient(request),
    );

    try {
      const failed = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.47");

      expect(failed.status).toBe(503);
      await expect(failed.json()).resolves.toEqual({
        error: {
          code: "guest_display_name_update_unavailable",
          message: "Guest contact was saved, but the account name could not be updated. Try again.",
        },
      });
      // The contact is bound and stays bound: the failure is downstream of it.
      expect(token.read()).toEqual(
        expect.objectContaining({ contact_email: CONTACT_EMAIL, contact_name: CONTACT_NAME }),
      );

      const resumed = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.48");

      expect(resumed.status).toBe(200);
      await expect(resumed.json()).resolves.toEqual({
        accountId: "acc_guest_resume",
        contactEmail: CONTACT_EMAIL,
        contactName: CONTACT_NAME,
      });
    } finally {
      globalThis.fetch = realFetch;
      mockCreateIdentityAuthRequestClient.mockReset();
    }

    // Two identical calls over the real client boundary, at the token's own
    // Account, and the contact was never rebound.
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(
        "http://localhost/api/identity/internal/auth/guest-accounts/acc_guest_resume/display-name",
      );
      expect(request.body).toBe(JSON.stringify({ displayName: CONTACT_NAME }));
    }
    expect(
      vi.mocked(services.db.query).mock.calls.filter(([sql]) => String(sql).includes("SET contact_email = $3")),
    ).toHaveLength(1);
  });

  it("treats a lost Identity response as an idempotent retry", async () => {
    const { createIdentityAuthRequestClient } =
      await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");
    const services = createServices({ existingUser: null });
    useGuestTokenState(
      services,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_lost" }),
    );
    const app = buildApp(services, createGuestActor("acc_guest_lost"));

    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      if (bodies.length === 1) {
        // Committed in Identity; the response never made it back to Auth.
        throw new TypeError("fetch failed");
      }
      return new Response(
        // Identity's replay: no second event, so `converged` is false.
        JSON.stringify(convergenceResult("acc_guest_lost", CONTACT_NAME, false)),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    mockCreateIdentityAuthRequestClient.mockImplementation((request: Request) =>
      createIdentityAuthRequestClient(request),
    );

    try {
      const lost = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.49");
      expect(lost.status).toBe(503);

      const retried = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.50");
      expect(retried.status).toBe(200);
      await expect(retried.json()).resolves.toEqual({
        accountId: "acc_guest_lost",
        contactEmail: CONTACT_EMAIL,
        contactName: CONTACT_NAME,
      });
    } finally {
      globalThis.fetch = realFetch;
      mockCreateIdentityAuthRequestClient.mockReset();
    }

    expect(bodies).toEqual([
      JSON.stringify({ displayName: CONTACT_NAME }),
      JSON.stringify({ displayName: CONTACT_NAME }),
    ]);
  });

  it("refuses contact binding after the guest Account is claimed", async () => {
    const services = createServices({ existingUser: null });
    // The claim revoked the token, and `getGuestCheckoutTokenByHash` filters
    // revoked and expired rows, so the route never resolves a guest context.
    vi.mocked(services.db.query).mockImplementation(async () => ({ rows: [] }));
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });
    const app = buildApp(services, createGuestActor("acc_guest_claimed"));

    const response = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.51");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Guest checkout token required." });
    expect(mockConvergeGuestAccountDisplayName).not.toHaveBeenCalled();
  });

  it("renames only the requesting guest Account when a claim races the convergence", async () => {
    const services = createServices({ existingUser: null });
    const token = useGuestTokenState(
      services,
      guestTokenRecord({ contact_email: null, contact_name: null, account_id: "acc_guest_race_claim" }),
    );
    const app = buildApp(services, createGuestActor("acc_guest_race_claim"));

    // The claim lands after the contact route read the token and before the
    // Identity append: the token is revoked mid-convergence.
    mockConvergeGuestAccountDisplayName.mockImplementation(async (params: { accountId: string }) => {
      vi.mocked(services.db.query).mockImplementation(async () => ({ rows: [] }));
      return convergenceResult(params.accountId, CONTACT_NAME);
    });
    mockCreateIdentityAuthRequestClient.mockReturnValue({
      convergeGuestAccountDisplayName: mockConvergeGuestAccountDisplayName,
    });

    const raced = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.52");

    expect(raced.status).toBe(200);
    expect(token.read()).toEqual(
      expect.objectContaining({ account_id: "acc_guest_race_claim", contact_name: CONTACT_NAME }),
    );
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(1);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledWith({
      accountId: "acc_guest_race_claim",
      displayName: CONTACT_NAME,
    });

    // And once the claim has landed, no further convergence can run at all.
    const afterClaim = await bindContact(app, { email: CONTACT_EMAIL, displayName: CONTACT_NAME }, "203.0.113.53");
    expect(afterClaim.status).toBe(401);
    expect(mockConvergeGuestAccountDisplayName).toHaveBeenCalledTimes(1);
  });
});
