import { describe, expect, it, vi } from "vitest";
import type { IdentityServices } from "../support/runtime-support/services";
import {
  buildIdentityApi,
  createBootstrapContext,
  deriveGuestAccountDisplayNameConvergenceOperationKey,
  normalizeAccountDisplayNameKey,
} from "../api";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import type { IdentityRuntimeDeps } from "../support/runtime-support";
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

/**
 * The reservation table, with the two constraints that decide this behaviour
 * modelled rather than stubbed: `display_name_key` is the primary key the
 * `ON CONFLICT` predicate arbitrates, and `account_id` is a UNIQUE column the
 * `ON CONFLICT (display_name_key)` clause does not cover -- so an attempt that
 * ever reached it surfaces here as an error instead of quietly passing.
 * PostgreSQL's own behaviour under a real crash and a real concurrent writer is
 * proven in `internal-auth-routes.db.test.ts`.
 */
function createDisplayNameReservationTable() {
  const rows = new Map<
    string,
    Readonly<{ display_name_key: string; account_id: string; display_name: string; operation_key: string | null }>
  >();

  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("INSERT INTO identity_account_display_name_reservations")) {
      const [displayNameKey, accountId, displayName, operationKey] = params as [string, string, string, string];
      const held = rows.get(displayNameKey);
      if (held) {
        if (held.operation_key !== operationKey) {
          return { rows: [] };
        }
        rows.set(displayNameKey, { ...held, account_id: accountId, display_name: displayName });
        return { rows: [{ display_name_key: displayNameKey }] };
      }

      for (const row of rows.values()) {
        if (row.account_id === accountId) {
          throw new Error(
            'duplicate key value violates unique constraint "identity_account_display_name_reservations_account_id_key"',
          );
        }
      }
      rows.set(displayNameKey, {
        display_name_key: displayNameKey,
        account_id: accountId,
        display_name: displayName,
        operation_key: operationKey,
      });
      return { rows: [{ display_name_key: displayNameKey }] };
    }

    if (sql.includes("DELETE FROM identity_account_display_name_reservations")) {
      const [displayNameKey, operationKey, accountId] = params as [string, string, string];
      const held = rows.get(displayNameKey);
      if (held && held.operation_key === operationKey && held.account_id === accountId) {
        rows.delete(displayNameKey);
      }
      return { rows: [] };
    }

    return { rows: [] };
  });

  return { rows, query };
}

/**
 * Services whose Account aggregate is the real one: the real command handler
 * over a real append-only store with per-stream expected-version enforcement.
 * The `vi.fn()` handler the rest of this file uses cannot answer whether a
 * replay appends a second event, which is the whole question here.
 *
 * `interleaveBeforeAppend` runs inside the append the command handler issues,
 * after it has already decided from the state it loaded -- the only place a
 * competing writer can produce the load-and-append race deterministically. It
 * returns whether it fired, so the caller picks which append it races.
 */
function createConvergenceServices(
  options: Readonly<{
    interleaveBeforeAppend?: (
      eventStore: InMemoryEventStore,
      input: Parameters<InMemoryEventStore["appendToStream"]>[0],
    ) => Promise<boolean>;
  }> = {},
) {
  const eventStore = createInMemoryEventStore();
  const reservations = createDisplayNameReservationTable();
  const db = { query: reservations.query } as unknown as IdentityRuntimeDeps["db"];

  let interleaved = false;
  const instrumented: InMemoryEventStore = {
    ...eventStore,
    appendToStream: async (input) => {
      if (options.interleaveBeforeAppend && !interleaved) {
        interleaved = await options.interleaveBeforeAppend(eventStore, input);
      }
      return eventStore.appendToStream(input);
    },
  };

  const deps: IdentityRuntimeDeps = {
    eventStore: instrumented,
    db,
    // Account runtime construction never reaches the checkpoint store; only the
    // projection worker does, and this suite runs no projections.
    checkpointStore: {} as IdentityRuntimeDeps["checkpointStore"],
  };

  const services = {
    eventStore: instrumented,
    db,
    accounts: createAccountRuntime(deps),
    users: { commandHandler: vi.fn() },
    memberships: { commandHandler: vi.fn() },
    consents: { commandHandler: vi.fn() },
    projectors: [],
  } as unknown as IdentityServices;

  return { eventStore, reservations, services, app: buildIdentityApi(services) };
}

type ConvergenceLane = ReturnType<typeof createConvergenceServices>;

async function postJson(app: ConvergenceLane["app"], path: string, body: Record<string, unknown>) {
  const response = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // An unhandled failure leaves Hono's plain-text body, which is itself the
  // observation in the load-and-append race case.
  const json = text.trimStart().startsWith("{") ? (JSON.parse(text) as Record<string, never>) : {};
  return { status: response.status, body: json, text };
}

async function startGuestAccount(app: ConvergenceLane["app"], displayName = "Guest") {
  const created = await postJson(app, "/internal/auth/guest-accounts", { email: "", displayName });
  expect(created.status).toBe(201);
  return String(created.body.accountId);
}

function convergeDisplayName(app: ConvergenceLane["app"], accountId: string, displayName: string) {
  return postJson(app, `/internal/auth/guest-accounts/${accountId}/display-name`, { displayName });
}

const CONTACT_NAME = "Buyer Example";
const CONTACT_NAME_KEY = "buyer example";

describe("guest account display-name convergence", () => {
  it("converges a guest display name at most once under replay and a concurrent stream advance", async () => {
    const { app, eventStore, reservations } = createConvergenceServices();
    const accountId = await startGuestAccount(app);
    const streamId = `identity.account-${accountId}`;

    const first = await convergeDisplayName(app, accountId, `  ${CONTACT_NAME}  `);

    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      accountId,
      displayName: CONTACT_NAME,
      converged: true,
      snapshots: [{ aggregate: "account", id: accountId, version: 2, status: "active" }],
    });
    expect(eventStore.eventTypesFor(streamId)).toEqual([
      "identity.account.created",
      "identity.account.profile-updated",
    ]);
    expect((eventStore.streams.get(streamId) ?? [])[1].payload).toEqual({ name: "", displayName: CONTACT_NAME });

    // Exactly one reservation row, keyed by the normalized display name, held by
    // the guest Account and bound to the Identity-derived operation key.
    expect([...reservations.rows.values()]).toEqual([
      {
        display_name_key: normalizeAccountDisplayNameKey(CONTACT_NAME),
        account_id: accountId,
        display_name: CONTACT_NAME,
        operation_key: deriveGuestAccountDisplayNameConvergenceOperationKey({
          accountId,
          displayNameKey: CONTACT_NAME_KEY,
        }),
      },
    ]);

    // No User and no Membership is created anywhere by a rename.
    expect(eventStore.streamIdsWithPrefix("identity.user-")).toEqual([]);
    expect(eventStore.streamIdsWithPrefix("identity.membership-")).toEqual([]);

    // Repeated: the reservation is reclaimed through its own operation key and
    // the aggregate appends nothing, returning the committed state and version.
    const replay = await convergeDisplayName(app, accountId, CONTACT_NAME);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      accountId,
      displayName: CONTACT_NAME,
      converged: false,
      snapshots: [{ aggregate: "account", id: accountId, version: 2, status: "active" }],
    });
    expect(eventStore.eventTypesFor(streamId)).toHaveLength(2);
    expect(reservations.rows.size).toBe(1);
  });

  it("loses the load-and-append race rather than clobbering the newer Account state", async () => {
    let racedStreamId = "";
    const raced = createConvergenceServices({
      interleaveBeforeAppend: async (store, input) => {
        // Race the convergence append, not the guest Account creation.
        if (input.events[0]?.eventType !== "identity.account.profile-updated") {
          return false;
        }
        await store.appendToStream({
          streamId: racedStreamId,
          expectedVersion: 1,
          events: [
            {
              eventType: "identity.account.profile-updated",
              payload: { name: "", displayName: "Someone Else" },
            },
          ],
          context: createBootstrapContext(),
        });
        return true;
      },
    });

    const accountId = await startGuestAccount(raced.app);
    racedStreamId = `identity.account-${accountId}`;

    const conflicted = await convergeDisplayName(raced.app, accountId, CONTACT_NAME);

    // The append is rejected by the expectedVersion taken from the guard read.
    expect(conflicted.status).toBe(500);
    expect(raced.eventStore.eventTypesFor(racedStreamId)).toEqual([
      "identity.account.created",
      "identity.account.profile-updated",
    ]);
    expect(raced.eventStore.streams.get(racedStreamId)?.at(-1)?.payload).toEqual({
      name: "",
      displayName: "Someone Else",
    });
    // The definitively failed append gave its reservation back rather than
    // leaving a row nobody can reclaim.
    expect(raced.reservations.rows.size).toBe(0);
  });

  it("refuses guest display-name convergence outside the unclaimed placeholder state", async () => {
    const closed = createConvergenceServices();
    const closedAccountId = await startGuestAccount(closed.app);
    await closed.services.accounts.commandHandler({
      streamId: `identity.account-${closedAccountId}`,
      command: {
        type: "CloseAccount",
        enforcement: {
          version: 1,
          enforcementActionId: "enf_01ARYZ6S41TSV4RRFFQ69G5FAV" as never,
          reason: "operator-other",
          reference: null,
        },
      },
      context: createBootstrapContext(),
    });

    const renamed = createConvergenceServices();
    const renamedAccountId = await startGuestAccount(renamed.app, "Rival Shop");

    const converged = createConvergenceServices();
    const convergedAccountId = await startGuestAccount(converged.app);
    expect((await convergeDisplayName(converged.app, convergedAccountId, CONTACT_NAME)).status).toBe(200);

    const unknown = createConvergenceServices();

    const matrix = [
      {
        label: "closed",
        lane: closed,
        accountId: closedAccountId,
        requested: CONTACT_NAME,
        reason: "account_closed",
        events: 2,
      },
      {
        label: "display name is not the placeholder",
        lane: renamed,
        accountId: renamedAccountId,
        requested: CONTACT_NAME,
        reason: "display_name_not_placeholder",
        events: 1,
      },
      {
        label: "already converged, different name",
        lane: converged,
        accountId: convergedAccountId,
        requested: "Someone Else",
        reason: "display_name_not_placeholder",
        events: 2,
      },
      {
        label: "unknown account id",
        lane: unknown,
        accountId: "acc_never_created",
        requested: CONTACT_NAME,
        reason: "account_not_found",
        events: 0,
      },
    ] as const;

    for (const row of matrix) {
      const reservationsBefore = row.lane.reservations.rows.size;
      const refusal = await convergeDisplayName(row.lane.app, row.accountId, row.requested);

      expect(refusal.status, row.label).toBe(409);
      expect(refusal.body, row.label).toEqual({
        error: {
          code: "guest_display_name_convergence_refused",
          reason: row.reason,
          message: "Guest account display name cannot be updated from its current state.",
        },
      });
      // Nothing appended, and no reservation row taken by a refusal.
      expect(row.lane.eventStore.eventTypesFor(`identity.account-${row.accountId}`), row.label).toHaveLength(
        row.events,
      );
      expect(row.lane.reservations.rows.size, row.label).toBe(reservationsBefore);
    }
  });

  it("classifies a colliding guest display name without appending", async () => {
    const { app, eventStore, reservations, services } = createConvergenceServices();
    const holderAccountId = await startGuestAccount(app);
    const guestAccountId = await startGuestAccount(app);

    expect((await convergeDisplayName(app, holderAccountId, CONTACT_NAME)).status).toBe(200);
    expect(reservations.rows.size).toBe(1);

    const collision = await convergeDisplayName(app, guestAccountId, CONTACT_NAME);

    expect(collision.status).toBe(409);
    expect(collision.body).toEqual({
      error: {
        code: "display_name_already_taken",
        message: "Display name is already taken.",
      },
    });

    // Collision is decided by the reservation table, never by display text: the
    // guest Account keeps the placeholder and its stream is untouched.
    expect(eventStore.eventTypesFor(`identity.account-${guestAccountId}`)).toEqual(["identity.account.created"]);
    expect(await services.accounts.getAccountState(guestAccountId)).toEqual(
      expect.objectContaining({ displayName: "Guest", name: "" }),
    );
    expect([...reservations.rows.values()]).toHaveLength(1);
    expect([...reservations.rows.values()][0].account_id).toBe(holderAccountId);
  });
});
