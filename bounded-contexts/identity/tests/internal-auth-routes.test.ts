import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import { buildIdentityApi, normalizeAccountDisplayNameKey } from "../api";
import { mintRegistrationConsentResolution } from "../features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import { decideAccount, initialAccountState } from "../features/accounts/domain/domain";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createInMemoryEventStore, type InMemoryEventStore } from "./in-memory-event-store";

// Registration reaches the aggregate writes only with a server-minted
// resolution, so these route tests resolve one the same way a caller does.
function registrationConsent() {
  return {
    resolution: mintRegistrationConsentResolution({
      requirements: [],
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    }),
    affirmed: false,
  };
}

function createServices() {
  return {
    eventStore: createInMemoryEventStore(),
    db: {
      query: vi.fn(),
    },
    accounts: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    users: {
      getUserBySocialLogin: vi.fn(async () => null),
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    memberships: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    consents: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "recorded" } })),
    },
    projectors: [],
  } as unknown as IdentityServices;
}

describe("identity internal auth routes", () => {
  it("normalizes account display names for uniqueness checks", () => {
    expect(normalizeAccountDisplayNameKey("  PokeBash   TCG  ")).toBe("pokebash tcg");
  });

  it("does not copy a personal display name into the account legal name", async () => {
    const services = createServices();
    vi.mocked(services.db.query)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ display_name_key: "pokebash tcg" }] });
    const app = buildIdentityApi(services);

    const response = await app.request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        registrationConsent: registrationConsent(),
      }),
    });

    expect(response.status).toBe(201);
    const eventStore = services.eventStore as InMemoryEventStore;
    const [accountStreamId] = eventStore.streamIdsWithPrefix("identity.account-");
    const accountId = accountStreamId.slice("identity.account-".length) as AccountId;

    // Registration composes this command literally and folds it through the
    // Account decider, so what it appended must be exactly what that decider
    // yields for it: the personal display name stays the display name and never
    // becomes the account's legal name.
    expect(
      (eventStore.streams.get(accountStreamId) ?? []).map((event) => ({ type: event.eventType, data: event.payload })),
    ).toEqual(
      decideAccount(initialAccountState, {
        type: "CreateAccount",
        accountId,
        name: "",
        accountType: "personal",
        displayName: "PokeBash TCG",
      }),
    );
  });

  it("rejects duplicate personal account display names before writing identity records", async () => {
    const services = createServices();
    vi.mocked(services.db.query).mockResolvedValueOnce({ rows: [{ account_id: "acc_existing" }] });
    const app = buildIdentityApi(services);

    const response = await app.request("/internal/auth/personal-identities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@pokebash.example",
        displayName: "PokeBash TCG",
        registrationConsent: registrationConsent(),
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "display_name_already_taken",
        message: "Display name is already taken.",
      },
    });
    expect((services.eventStore as InMemoryEventStore).streamIdsWithPrefix("identity.")).toEqual([]);
  });

  it("registers passkey credential facts without requiring an actor request context", async () => {
    const services = createServices();
    const app = buildIdentityApi(services);

    const response = await app.request("/internal/auth/users/usr_1/passkey-credential", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialId: "crd_1" }),
    });

    expect(response.status).toBe(200);
    expect(services.users.commandHandler).toHaveBeenCalledTimes(2);
    expect(services.users.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "EnableAuthMethod", authMethod: "passkey" },
      }),
    );
    expect(services.users.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RegisterPasskeyCredential", credentialId: "crd_1" },
      }),
    );
  });

  it("links social login facts without requiring a current user read model row", async () => {
    const services = createServices();
    const app = buildIdentityApi(services);

    const response = await app.request("/internal/auth/users/usr_platform_admin/social-login-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerName: "google",
        providerSubject: "google-subject",
        email: "ops@chasesets.com",
      }),
    });

    expect(response.status).toBe(200);
    expect(services.users.getUserBySocialLogin).toHaveBeenCalledWith({
      providerName: "google",
      providerSubject: "google-subject",
    });
    expect(services.users.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "EnableAuthMethod", authMethod: "social-login" },
      }),
    );
    expect(services.users.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({
          type: "LinkSocialLogin",
          providerName: "google",
          providerSubject: "google-subject",
          email: "ops@chasesets.com",
        }),
      }),
    );
  });
});
