import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  buildIdentityApi,
  createBootstrapContext,
  deriveGuestAccountDisplayNameConvergenceOperationKey,
  normalizeAccountDisplayNameKey,
} from "../api";
import { createAccountRuntime } from "../features/accounts/api/runtime";
import { createConsentRuntime } from "../features/consents/api/runtime";
import { createMembershipRuntime } from "../features/memberships/api/runtime";
import { createUserRuntime } from "../features/users/api/runtime";
import { identityAccountSchemaSql } from "../features/accounts/read-model/schema";
import type { IdentityServices } from "../support/runtime-support/services";

// Exercised against a real Postgres sandbox, never mocked. The reservation
// write and the Account append are two separate commits, and only a real
// database produces the `ON CONFLICT` arbitration, the `account_id` UNIQUE
// constraint, and the concurrent writers that decide whether a crash between
// them leaves a row nobody can ever reclaim.
const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["identity"] as const;

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for database-backed tests.");
  }
  return databaseBaseUrl;
}

const CONTACT_NAME = "Buyer Example";
const CONTACT_NAME_KEY = "buyer example";
const RESERVATION_ROW_COLUMNS = "display_name_key, account_id, display_name, operation_key";

type ReservationRow = Readonly<{
  display_name_key: string;
  account_id: string;
  display_name: string;
  operation_key: string | null;
}>;

describeDb("guest account display-name convergence against Postgres", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>> | undefined;
  let eventStore: EventStore;
  let services: IdentityServices;
  const context: EventStoreContext = createBootstrapContext();

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "identity_guest_display_name",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.identity;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ identity: pool });
    await pool.query(eventCorePostgresSchemaSql);
    await pool.query(identityAccountSchemaSql);

    eventStore = createPostgresEventStore({ pool });
    const deps = {
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: pool }),
      db: pool,
    } as const;
    services = {
      eventStore,
      db: pool,
      accounts: createAccountRuntime(deps),
      users: createUserRuntime(deps),
      memberships: createMembershipRuntime(deps),
      consents: createConsentRuntime(deps),
      projectors: [],
    } as unknown as IdentityServices;
  });

  afterAll(async () => {
    if (pools) {
      await closeMultiContextTestPools(pools);
    }
  });

  function api(withServices: IdentityServices = services) {
    return buildIdentityApi(withServices);
  }

  async function requestJson(app: ReturnType<typeof buildIdentityApi>, path: string, body: Record<string, unknown>) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const json = text.trimStart().startsWith("{") ? (JSON.parse(text) as Record<string, never>) : {};
    return { status: response.status, body: json };
  }

  async function startGuestAccount(displayName = "Guest") {
    const created = await requestJson(api(), "/internal/auth/guest-accounts", { email: "", displayName });
    expect(created.status).toBe(201);
    return String(created.body.accountId);
  }

  function converge(accountId: string, displayName: string, withServices: IdentityServices = services) {
    return requestJson(api(withServices), `/internal/auth/guest-accounts/${accountId}/display-name`, { displayName });
  }

  async function reservations(): Promise<readonly ReservationRow[]> {
    const result = await pool.query<ReservationRow>(
      `SELECT ${RESERVATION_ROW_COLUMNS}
       FROM identity_account_display_name_reservations
       ORDER BY display_name_key`,
    );
    return result.rows;
  }

  async function accountEventTypes(accountId: string) {
    const stored = await eventStore.readStream({ streamId: `identity.account-${accountId}` });
    return stored.map((event) => event.eventType);
  }

  function operationKeyFor(accountId: string) {
    return deriveGuestAccountDisplayNameConvergenceOperationKey({ accountId, displayNameKey: CONTACT_NAME_KEY });
  }

  /**
   * The artifact a crash between the two commits leaves behind: the reservation
   * is in the table, bound to this convergence's own derived operation key, and
   * the Account stream carries no convergence event. Written directly rather
   * than by half-running the handler, because completing it is what the retry
   * has to do.
   */
  async function writeCrashedReservation(accountId: string) {
    await pool.query(
      `INSERT INTO identity_account_display_name_reservations (
         display_name_key, account_id, display_name, operation_key, created_at
       ) VALUES ($1, $2, $3, $4, now())`,
      [CONTACT_NAME_KEY, accountId, CONTACT_NAME, operationKeyFor(accountId)],
    );
  }

  function servicesWithFailingAppend(): IdentityServices {
    return {
      ...services,
      accounts: {
        ...services.accounts,
        commandHandler: async () => {
          throw new Error("Injected Account append failure.");
        },
      },
    } as unknown as IdentityServices;
  }

  it("reclaims its own reservation and converges exactly once after a crash between the reservation write and the Account append", async () => {
    const accountId = await startGuestAccount();
    await writeCrashedReservation(accountId);

    expect(await reservations()).toEqual([
      {
        display_name_key: CONTACT_NAME_KEY,
        account_id: accountId,
        display_name: CONTACT_NAME,
        operation_key: operationKeyFor(accountId),
      },
    ]);
    expect(await accountEventTypes(accountId)).toEqual(["identity.account.created"]);

    // The identical retry carries the same Identity-derived operation key, so
    // it reclaims that exact row through the `display_name_key` conflict
    // predicate. It must never reach the table's `account_id` UNIQUE
    // constraint, which the `ON CONFLICT (display_name_key)` clause does not
    // cover -- a unique violation here would surface as a 500, not a 200.
    const resumed = await converge(accountId, CONTACT_NAME);

    expect(resumed.status).toBe(200);
    expect(resumed.body).toEqual(expect.objectContaining({ accountId, displayName: CONTACT_NAME, converged: true }));
    expect(await accountEventTypes(accountId)).toEqual([
      "identity.account.created",
      "identity.account.profile-updated",
    ]);
    expect(await reservations()).toEqual([
      {
        display_name_key: normalizeAccountDisplayNameKey(CONTACT_NAME),
        account_id: accountId,
        display_name: CONTACT_NAME,
        operation_key: operationKeyFor(accountId),
      },
    ]);

    // Repeated: still exactly one event and one row.
    const replay = await converge(accountId, CONTACT_NAME);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(expect.objectContaining({ converged: false }));
    expect(await accountEventTypes(accountId)).toHaveLength(2);
    expect(await reservations()).toHaveLength(1);

    // A differently-keyed attempt against the same display name still refuses:
    // a second guest Account derives a different operation key, so the
    // `ON CONFLICT` state predicate matches no row.
    const rivalAccountId = await startGuestAccount();
    const rival = await converge(rivalAccountId, CONTACT_NAME);

    expect(rival.status).toBe(409);
    expect(rival.body).toEqual({
      error: { code: "display_name_already_taken", message: "Display name is already taken." },
    });
    expect(await accountEventTypes(rivalAccountId)).toEqual(["identity.account.created"]);
    expect(await reservations()).toHaveLength(1);
  });

  it("releases the reservation when the Account append definitively fails", async () => {
    const accountId = await startGuestAccount();

    const failed = await converge(accountId, CONTACT_NAME, servicesWithFailingAppend());

    expect(failed.status).toBe(500);
    // The append committed nothing, and the compensating release gave the row
    // back rather than leaving it held against a placeholder Account.
    expect(await accountEventTypes(accountId)).toEqual(["identity.account.created"]);
    expect(await reservations()).toEqual([]);

    // Which leaves the name genuinely free: another guest Account can take it.
    const otherAccountId = await startGuestAccount();
    const taken = await converge(otherAccountId, CONTACT_NAME);
    expect(taken.status).toBe(200);
    expect(await reservations()).toEqual([
      {
        display_name_key: CONTACT_NAME_KEY,
        account_id: otherAccountId,
        display_name: CONTACT_NAME,
        operation_key: operationKeyFor(otherAccountId),
      },
    ]);
  });

  it("converges once when two identical attempts race the same Account", async () => {
    const accountId = await startGuestAccount();

    const [left, right] = await Promise.all([converge(accountId, CONTACT_NAME), converge(accountId, CONTACT_NAME)]);

    // Both reservation writes reclaim the same operation's row; at most one
    // append can satisfy the expectedVersion taken from its own guard read.
    expect([left.status, right.status].filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    expect(await accountEventTypes(accountId)).toEqual([
      "identity.account.created",
      "identity.account.profile-updated",
    ]);
    // The losing attempt must not have released the winner's reservation.
    expect(await reservations()).toEqual([
      {
        display_name_key: CONTACT_NAME_KEY,
        account_id: accountId,
        display_name: CONTACT_NAME,
        operation_key: operationKeyFor(accountId),
      },
    ]);
  });

  it("refuses two different Accounts racing the same display name", async () => {
    const leftAccountId = await startGuestAccount();
    const rightAccountId = await startGuestAccount();

    const [left, right] = await Promise.all([
      converge(leftAccountId, CONTACT_NAME),
      converge(rightAccountId, CONTACT_NAME),
    ]);

    expect([left.status, right.status].sort()).toEqual([200, 409]);
    const winnerAccountId = left.status === 200 ? leftAccountId : rightAccountId;
    const loserAccountId = left.status === 200 ? rightAccountId : leftAccountId;

    expect(await accountEventTypes(winnerAccountId)).toEqual([
      "identity.account.created",
      "identity.account.profile-updated",
    ]);
    expect(await accountEventTypes(loserAccountId)).toEqual(["identity.account.created"]);
    expect(await reservations()).toEqual([
      {
        display_name_key: CONTACT_NAME_KEY,
        account_id: winnerAccountId,
        display_name: CONTACT_NAME,
        operation_key: operationKeyFor(winnerAccountId),
      },
    ]);
  });

  it("refuses empty, terminal, and already-renamed Accounts without writing a reservation row", async () => {
    // Empty history: no Account stream at all.
    const unknown = await converge("acc_never_created", CONTACT_NAME);
    expect(unknown.status).toBe(409);
    expect(unknown.body).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ reason: "account_not_found" }) }),
    );

    // Terminal history: a closed Account.
    const closedAccountId = await startGuestAccount();
    await services.accounts.commandHandler({
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
      context,
    });
    const closed = await converge(closedAccountId, CONTACT_NAME);
    expect(closed.status).toBe(409);
    expect(closed.body).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ reason: "account_closed" }) }),
    );

    // A guest Account that never carried the placeholder.
    const namedAccountId = await startGuestAccount("Rival Shop");
    const named = await converge(namedAccountId, CONTACT_NAME);
    expect(named.status).toBe(409);
    expect(named.body).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ reason: "display_name_not_placeholder" }) }),
    );

    // An already-converged Account asked for a different name.
    const convergedAccountId = await startGuestAccount();
    expect((await converge(convergedAccountId, CONTACT_NAME)).status).toBe(200);
    const renamed = await converge(convergedAccountId, "Someone Else");
    expect(renamed.status).toBe(409);
    expect(renamed.body).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ reason: "display_name_not_placeholder" }) }),
    );

    // Every refusal wrote nothing: the only reservation row in the table is the
    // one the single successful convergence took.
    expect(await reservations()).toEqual([
      {
        display_name_key: CONTACT_NAME_KEY,
        account_id: convergedAccountId,
        display_name: CONTACT_NAME,
        operation_key: operationKeyFor(convergedAccountId),
      },
    ]);
    expect(await accountEventTypes(closedAccountId)).toEqual(["identity.account.created", "identity.account.closed"]);
    expect(await accountEventTypes(namedAccountId)).toEqual(["identity.account.created"]);
  });

  it("refuses a display name held by a poisoned reservation row it does not own", async () => {
    const accountId = await startGuestAccount();
    // A row held by another account under an operation key this convergence can
    // never derive -- including the claim-less shape registration recovery
    // knows how to adopt, which this path deliberately does not.
    await pool.query(
      `INSERT INTO identity_account_display_name_reservations (
         display_name_key, account_id, display_name, operation_key, created_at
       ) VALUES ($1, $2, $3, $4, now())`,
      [CONTACT_NAME_KEY, "acc_squatter", CONTACT_NAME, null],
    );

    const refused = await converge(accountId, CONTACT_NAME);

    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: { code: "display_name_already_taken", message: "Display name is already taken." },
    });
    expect(await accountEventTypes(accountId)).toEqual(["identity.account.created"]);
    expect(await reservations()).toEqual([
      {
        display_name_key: CONTACT_NAME_KEY,
        account_id: "acc_squatter",
        display_name: CONTACT_NAME,
        operation_key: null,
      },
    ]);
  });
});
