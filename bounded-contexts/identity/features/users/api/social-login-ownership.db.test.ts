import { Hono } from "hono";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import {
  composeModuleSchemaSql,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
  closeMultiContextTestPools,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { module as identityModule } from "../../../index";
import { createIdentityServices, type IdentityServices } from "../../../support/runtime-support/services";
import { buildIdentityApi, type IdentityApiEnv } from "../../../api";
import { createIdentityBootstrapContext } from "../../../support/runtime-support/bootstrap-context";
import { decideUser, evolveUser, initialUserState } from "../domain/domain";

describe("social login ownership invariants", () => {
  it("keeps a provider subject claim normalized and refuses target-provider unlink", () => {
    const created = decideUser(initialUserState, {
      type: "CreateUser",
      userId: "usr_social_ownership" as never,
      displayName: "Ownership",
      primaryEmail: "ownership@example.test",
    }).reduce(evolveUser, initialUserState);
    const withPassword = decideUser(created, { type: "EnableAuthMethod", authMethod: "password" }).reduce(
      evolveUser,
      created,
    );
    const linked = decideUser(withPassword, {
      type: "LinkSocialLogin",
      providerName: "google",
      providerSubject: " subject-1 ",
      email: "ownership@example.test",
      linkedAt: "2026-10-20T00:00:00.000Z",
    }).reduce(evolveUser, withPassword);
    expect(linked.socialLoginLinks[0]?.providerSubject).toBe("subject-1");
    expect(() =>
      decideUser(linked, {
        type: "UnlinkSocialLogin",
        providerName: "google",
        providerSubject: "subject-1",
        authenticationMethod: "google",
        authenticatedAt: "2026-10-20T00:00:00.000Z",
        now: "2026-10-20T00:05:00.000Z",
      }),
    ).toThrow("A different authentication method is required.");
  });
});

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;

describeDb("social login ownership PostgreSQL authority", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: IdentityServices;
  const actor: ResolvedActor = {
    sessionId: "ses_social_ownership" as never,
    tenantId: "tnt_social_ownership" as never,
    userId: "usr_social_legacy_2" as never,
    accountId: "acc_social_ownership" as never,
    membershipId: "mbr_social_ownership" as never,
    roleKey: "owner",
    permissions: ["security.manage"],
    authenticationMethod: "password",
    authenticatedAt: new Date().toISOString(),
  };
  const context = createIdentityBootstrapContext() as EventStoreContext;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_social_ownership");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
    pool = pools.identity;
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pool.query(composeModuleSchemaSql(identityModule));
    services = createIdentityServices(pool, { capabilityAdministrationAuthority: { kind: "deny-all" } });
  });

  it("backfills a populated legacy link and refuses a second owner before append", async () => {
    const store = createPostgresEventStore({ pool });
    const seedUser = async (
      userId: string,
      events: readonly { eventType: string; payload: Record<string, unknown> }[],
    ) => {
      await store.appendToStream({
        streamId: `identity.user-${userId}`,
        expectedVersion: "no_stream",
        context,
        events,
      });
    };
    await seedUser("usr_social_legacy_1", [
      {
        eventType: "identity.user.created",
        payload: {
          userId: "usr_social_legacy_1",
          displayName: "Legacy",
          givenName: "Legacy",
          familyName: "One",
          primaryEmail: "legacy@example.test",
        },
      },
      {
        eventType: "identity.user.social-login-linked",
        payload: {
          providerName: "google",
          providerSubject: "legacy-subject",
          email: "legacy@example.test",
          linkedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    await seedUser("usr_social_legacy_2", [
      {
        eventType: "identity.user.created",
        payload: {
          userId: "usr_social_legacy_2",
          displayName: "Second",
          givenName: "Second",
          familyName: "User",
          primaryEmail: "second@example.test",
        },
      },
    ]);
    const app = new Hono<IdentityApiEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    app.route("/", buildIdentityApi(services));
    const response = await app.request("/internal/auth/users/usr_social_legacy_2/social-login-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerName: "google", providerSubject: "legacy-subject", email: "second@example.test" }),
    });
    expect(response.status).toBe(409);
    const claim = await pool.query<{ user_id?: string; status?: string }>(
      `SELECT payload->>'userId' AS user_id, payload->>'status' AS status
         FROM event_store_events WHERE event_type = 'identity.social-login-ownership.claimed'`,
    );
    expect(claim.rows).toEqual([{ user_id: "usr_social_legacy_1", status: "claimed" }]);
    const takeover = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM event_store_events
        WHERE stream_id = 'identity.user-usr_social_legacy_2' AND event_type = 'identity.user.social-login-linked'`,
    );
    expect(takeover.rows[0]?.count).toBe("0");
    const marker = await pool.query(
      `SELECT 1 FROM event_store_events WHERE stream_id = 'identity.social-login-ownership-backfill'`,
    );
    expect(marker.rowCount).toBe(1);
  });
});
