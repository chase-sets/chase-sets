import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import { buildIdentityApi, normalizeAccountDisplayNameKey } from "../api";
import { mintRegistrationConsentResolution } from "../features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../support/runtime-support/registration-consent-signing";
import { decideAccount, initialAccountState } from "../features/accounts/domain/domain";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createInMemoryEventStore, type InMemoryEventStore } from "./in-memory-event-store";
import { registrationConsentBundlesFixture } from "./consent-activation-authority-fixtures";

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
    registrationConsentBundles: registrationConsentBundlesFixture(),
    db: {
      query: vi.fn(),
    },
    accounts: {
      commandHandler: vi.fn(async () => ({ version: 1, state: { status: "active" } })),
    },
    mutationPersistence: {
      transaction: vi.fn(async () => {
        throw new Error("synthetic transaction stop");
      }),
    },
    users: {
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

  const subjectMarker = "synthetic-subject-marker-10295";
  const emailMarker = "synthetic-email-marker-10295@example.test";

  it.each([
    ["link", "/internal/auth/users/usr_1/social-login-link", "not json"],
    ["link", "/internal/auth/users/usr_1/social-login-link", []],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "apple", providerSubject: subjectMarker, email: emailMarker },
    ],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "google", providerSubject: " ", email: emailMarker },
    ],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "google", providerSubject: "s".repeat(513), email: emailMarker },
    ],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "google", providerSubject: subjectMarker, email: "" },
    ],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "google", providerSubject: subjectMarker, email: "e".repeat(321) },
    ],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "google", providerSubject: 7, email: emailMarker },
    ],
    [
      "link",
      "/internal/auth/users/usr_1/social-login-link",
      { providerName: "google", providerSubject: subjectMarker, email: emailMarker, userId: "usr_2" },
    ],
    ["resolve", "/internal/auth/social-login-subjects/resolve", { providerName: "google" }],
    [
      "resolve",
      "/internal/auth/social-login-subjects/resolve",
      { providerName: "facebook", providerSubject: subjectMarker, email: emailMarker },
    ],
    [
      "resolve",
      "/internal/auth/social-login-subjects/resolve",
      { providerName: "google", providerSubject: "s".repeat(513) },
    ],
  ] as const)("refuses a malformed Social Login %s body with 400 and no ownership work", async (_kind, path, body) => {
    const services = createServices();
    const app = buildIdentityApi(services);

    const response = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "validation_failed" } });
    expect(text).not.toContain(subjectMarker);
    expect(text).not.toContain(emailMarker);
    expect(services.mutationPersistence.transaction).not.toHaveBeenCalled();
    expect(services.db.query).not.toHaveBeenCalled();
    expect((services.eventStore as InMemoryEventStore).streamIdsWithPrefix("identity.")).toEqual([]);
  });

  it("decides a link only inside one mutation transaction whose scopes never carry the subject", async () => {
    const services = createServices();
    const app = buildIdentityApi(services);

    const response = await app.request("/internal/auth/users/usr_1/social-login-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerName: "google", providerSubject: ` ${subjectMarker} `, email: emailMarker }),
    });

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(subjectMarker);
    expect(services.mutationPersistence.transaction).toHaveBeenCalledTimes(1);
    const [scopes] = vi.mocked(services.mutationPersistence.transaction).mock.calls[0]!;
    expect(scopes).toEqual([
      "identity.social-login-ownership-catch-up",
      `identity:social-login-ownership:${createHash("sha256").update(`google:${subjectMarker}`).digest("hex")}`,
    ]);
    expect(JSON.stringify(scopes)).not.toContain(subjectMarker);
    expect(services.users.commandHandler).not.toHaveBeenCalled();
  });
});
