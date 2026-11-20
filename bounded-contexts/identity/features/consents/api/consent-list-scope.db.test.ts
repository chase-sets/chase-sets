import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import type { IdentityApiEnv } from "../../../api";
import { module as identityModule } from "../../../index";
import { PLATFORM_ADMIN_ROLE_KEY } from "../../../support/runtime-support/common";
import { listConsents } from "../read-model/queries";
import { consentRoutes } from "./route";
import type { ConsentServices } from "./runtime";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for consent list scope tests.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const owner: ResolvedActor = {
  sessionId: "ses_owner",
  tenantId: "tnt_identity",
  userId: "usr_owner",
  accountId: "acc_shared",
  membershipId: "mbr_owner",
  roleKey: "owner",
  permissions: ["security.manage"],
};

/** Two users of one account, each with user and account consents, and the owner's from another account. */
const seeded = [
  ["cns_owner_user", "user", "usr_owner", "acc_shared"],
  ["cns_owner_user_elsewhere", "user", "usr_owner", "acc_elsewhere"],
  ["cns_owner_account", "account", "usr_owner", "acc_shared"],
  ["cns_owner_account_elsewhere", "account", "usr_owner", "acc_elsewhere"],
  ["cns_other_user", "user", "usr_other", "acc_shared"],
  ["cns_other_account", "account", "usr_other", "acc_shared"],
  ["cns_stranger_user", "user", "usr_stranger", "acc_stranger"],
] as const;
const ownersOwn = ["cns_owner_account", "cns_owner_user", "cns_owner_user_elsewhere"];

describeDb("consent list scope: the route against real PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "consent_list_scope_10707");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.identity.query(identityModule.schemaSql);
    for (const [consentId, subjectType, userId, accountId] of seeded) {
      await pools.identity.query(
        `INSERT INTO identity_consents (consent_id, subject_type, user_id, account_id, policy_key, policy_version, recorded_at)
         VALUES ($1, $2, $3, $4, 'terms-of-service', 'v1', '2026-07-01T00:00:00.000Z')`,
        [consentId, subjectType, userId, accountId],
      );
    }
  });
  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  function app(actor: ResolvedActor) {
    const services = {
      commandHandler: vi.fn(),
      recordTermsConsent: vi.fn(),
      getConsentState: vi.fn(async () => null),
      getConsent: vi.fn(async () => null),
      listConsents: (params) => listConsents(pools.identity, params),
      projectors: [],
    } satisfies ConsentServices;
    const mounted = new Hono<IdentityApiEnv>();
    mounted.use("*", async (c, next) => {
      const context: EventStoreContext = {
        tenantId: actor.tenantId as never,
        audit: { performedByUserId: actor.userId as never, forAccountId: actor.accountId as never },
        trace: {},
      };
      c.set("actor", actor);
      c.set("context", context);
      await next();
    });
    mounted.route("/consents", consentRoutes(services));
    mounted.onError(errorHandler);
    return mounted;
  }

  async function listedIds(actor: ResolvedActor, query: string) {
    const response = await app(actor).request(`/consents${query}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: { consent_id: string }[]; total: number };
    const ids = body.items.map((item) => item.consent_id).sort();
    expect(body.total).toBe(ids.length);
    return ids;
  }

  it.each([
    ["another user of the account", "?userId=usr_other&accountId=acc_shared"],
    ["another user only", "?userId=usr_stranger"],
    ["another account only", "?accountId=acc_stranger"],
    ["neither", ""],
  ])("gives a security manager only their own consents when the query names %s", async (_name, query) => {
    expect(await listedIds(owner, query)).toEqual(ownersOwn);
  });

  it("gives a platform admin only their own consents too", async () => {
    const admin = { ...owner, roleKey: PLATFORM_ADMIN_ROLE_KEY };

    expect(await listedIds(admin, "?userId=usr_stranger&accountId=acc_stranger")).toEqual(ownersOwn);
  });

  it("gives the other user of the account theirs and none of the owner's", async () => {
    const other = { ...owner, sessionId: "ses_other", userId: "usr_other", membershipId: "mbr_other", permissions: [] };

    expect(await listedIds(other, "?userId=usr_owner&accountId=acc_shared")).toEqual([
      "cns_other_account",
      "cns_other_user",
    ]);
  });
});
