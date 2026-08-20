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
  mockCreateIdentityAuthRequestClient,
  mockCreateGuestAccount,
  mockRegisterPasskeyCredential,
  mockStartInteractiveAuth,
  mockVerifyPasskeyRegistration,
} = vi.hoisted(() => ({
  mockClaimGuestAccount: vi.fn(),
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
