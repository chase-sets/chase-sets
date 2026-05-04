import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerGuestCheckoutRoutes } from "./guest-checkout-routes";
import type { AuthApiEnv } from "./support";

const { mockCreateIdentityAuthRequestClient, mockCreateGuestAccount } = vi.hoisted(
  () => ({
    mockCreateIdentityAuthRequestClient: vi.fn(),
    mockCreateGuestAccount: vi.fn(),
  }),
);

vi.mock("@chase-sets/identity/server", () => ({
  createIdentityAuthRequestClient: mockCreateIdentityAuthRequestClient,
}));

function buildApp(
  services: Partial<AuthServices> &
    Pick<AuthServices, "auth" | "db" | "identity">,
) {
  const app = new Hono<AuthApiEnv>();
  registerGuestCheckoutRoutes(app, services as AuthServices);
  return app;
}

function createServices(options: {
  existingUser?: { user_id: string } | null;
}) {
  return {
    db: {
      query: vi.fn(async () => ({ rows: [] })),
    },
    auth: {
      issueOpaqueToken: vi.fn(() => "guest_token"),
      hashSecret: vi.fn((value: string) => `hashed:${value}`),
    },
    identity: {
      normalizeEmail: vi.fn((value: string) => value.trim().toLowerCase()),
      getUserByEmail: vi.fn(async () => options.existingUser ?? null),
    },
  } as unknown as Pick<AuthServices, "auth" | "db" | "identity">;
}

afterEach(() => {
  vi.clearAllMocks();
});

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
    expect(services.identity.normalizeEmail).toHaveBeenCalledWith(
      " Jane@Example.com ",
    );
    expect(services.identity.getUserByEmail).toHaveBeenCalledWith(
      "jane@example.com",
    );
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
});
