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
import { registerGuestCheckoutRoutes } from "./guest-checkout-routes";
import type { AuthApiEnv } from "./support";

const { mockClaimGuestAccount, mockCreateIdentityAuthRequestClient, mockCreateGuestAccount, mockStartInteractiveAuth } =
  vi.hoisted(() => ({
    mockClaimGuestAccount: vi.fn(),
    mockCreateIdentityAuthRequestClient: vi.fn(),
    mockCreateGuestAccount: vi.fn(),
    mockStartInteractiveAuth: vi.fn(),
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

function createGuestActor() {
  return createAccountUserTestActor({
    accountId: "acc_guest",
    roleKey: "guest-buyer",
    permissions: ["guest-checkout.manage"],
  });
}

useMockReset();

describe("guest checkout auth routes", () => {
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

  it("creates a guest checkout token for an unknown email", async () => {
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
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        accountId: "acc_guest",
        guestToken: "guest_token",
      }),
    );
    expect(mockCreateGuestAccount).toHaveBeenCalledWith({
      email: "jane@example.com",
      displayName: "Jane Smith",
    });
    expect(services.db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_guest_checkout_tokens"),
      expect.arrayContaining(["acc_guest", "jane@example.com", "Jane Smith"]),
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
