import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { composeModuleSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import { module as identityModule } from "../../../index";
import { buildIdentityApi, createBootstrapContext } from "../../../api";
import { createIdentityServices, type IdentityServices } from "../../../support/runtime-support/services";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../account-capabilities/api/authority";
import { catchUpSocialLoginOwnership, SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM } from "./social-login-ownership";
import { identitySocialLoginSchemaMigrations, identityUserSchemaSql } from "../read-model/schema";
import { Hono } from "hono";
import type { IdentityApiEnv } from "../../../api";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for issue #10295 DB proof.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const SUBJECT = "synthetic-subject-marker-10295";
const EMAIL = "synthetic-email-marker-10295@example.test";
const linkKey = (subject: string, providerName = "google") =>
  createHash("sha256").update(`${providerName}:${subject}`, "utf8").digest("hex");
const claimStream = (subject: string) => `identity.social-login-ownership-${linkKey(subject)}`;

describeDb("issue-10295 Social Login Ownership Claim on PostgreSQL", () => {
  let pools: Readonly<Record<"identity", PgTransactionalPool>>;
  let pool: PgTransactionalPool;
  let services: IdentityServices;
  let app: ReturnType<typeof buildIdentityApi>;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["identity"], "identity_10295");
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
    services = createIdentityServices(pool, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    app = buildIdentityApi(services);
    for (const userId of ["usr_one10295", "usr_two10295", "usr_three10295"]) await seedUser(userId);
  });

  async function seedUser(userId: string) {
    await services.eventStore!.appendToStream({
      streamId: `identity.user-${userId}`,
      expectedVersion: "no_stream",
      context: createBootstrapContext(),
      events: [
        {
          eventType: "identity.user.created",
          payload: { userId, displayName: userId, givenName: "Synthetic", familyName: "User", primaryEmail: EMAIL },
        },
      ],
    });
  }
  /** A pre-claim link: the shipped path appended the link fact with no ownership claim. */
  async function seedLegacyLink(userId: string, subject = SUBJECT) {
    await services.eventStore!.appendToStream({
      streamId: `identity.user-${userId}`,
      expectedVersion: "any",
      context: createBootstrapContext(),
      events: [
        {
          eventType: "identity.user.social-login-linked",
          payload: {
            providerName: "google",
            providerSubject: subject,
            email: EMAIL,
            linkedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });
  }
  async function post(path: string, body: unknown) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  }
  const link = (userId: string, subject = SUBJECT) =>
    post(`/internal/auth/users/${userId}/social-login-link`, {
      providerName: "google",
      providerSubject: subject,
      email: EMAIL,
    });
  const resolve = (subject = SUBJECT) =>
    post("/internal/auth/social-login-subjects/resolve", { providerName: "google", providerSubject: subject });
  async function events(): Promise<readonly StoredEvent[]> {
    return services.eventStore!.readAll({ limit: 500 });
  }
  async function stream(streamId: string) {
    return (await events()).filter((event) => event.streamId === streamId);
  }
  async function eventCount() {
    return (await events()).length;
  }
  async function receiptCount() {
    return (await events()).filter(
      (event) => event.eventType === "identity.account-management-mutation-attempt.committed",
    ).length;
  }
  function catchUp(pageSize?: number) {
    return services.mutationPersistence.transaction([SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM], (tx) =>
      catchUpSocialLoginOwnership(services, tx, createBootstrapContext(), { pageSize }),
    );
  }
  async function failInsertsOf(eventType: string) {
    await pool.query(`CREATE FUNCTION issue10295_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = '${eventType}' THEN RAISE EXCEPTION 'synthetic atom fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER issue10295_fail BEFORE INSERT ON event_store_events FOR EACH ROW EXECUTE FUNCTION issue10295_fail()`);
  }
  async function replayUserProjection() {
    const projection = services.projectors.find((set) => set.projectionName === "identity-user-projection")!;
    for (const event of await events()) await projection.handlers[event.eventType]?.(toTransportEvent(event));
  }

  function authenticatedApi(actor: ResolvedActor | null) {
    const wrapper = new Hono<IdentityApiEnv>();
    wrapper.use("*", async (c, next) => {
      if (actor) {
        c.set("actor", actor);
        c.set("context", {
          tenantId: parseTypedId(actor.tenantId, "tnt"),
          audit: {
            performedByUserId: parseTypedId(actor.userId, "usr"),
            forAccountId: parseTypedId(actor.accountId, "acc"),
          },
        });
      }
      await next();
    });
    wrapper.route("/", buildIdentityApi(services));
    return wrapper;
  }
  function unlinkActor(): ResolvedActor {
    const context = createBootstrapContext();
    return {
      tenantId: context.tenantId,
      userId: "usr_one10295",
      accountId: context.audit.forAccountId!,
      membershipId: "mbr_synthetic_unlink",
      sessionId: "ses_synthetic_unlink",
      roleKey: "owner",
      permissions: ["security.manage"],
      authenticationMethod: "password",
      authenticatedAt: new Date().toISOString(),
    };
  }
  const unlinkAttempt = "9230f01b-7871-420b-9c32-37139f80f749";
  function unlinkRequest(body: unknown = { linkKey: linkKey(SUBJECT) }, attempt: string | null = unlinkAttempt) {
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(attempt ? { "Idempotency-Key": attempt } : {}) },
      body: JSON.stringify(body),
    };
  }
  async function seedUnlink(methods = ["password", "social-login"], secondLink = false) {
    for (const authMethod of methods)
      await services.eventStore!.appendToStream({
        streamId: "identity.user-usr_one10295",
        expectedVersion: "any",
        context: createBootstrapContext(),
        events: [{ eventType: "identity.user.auth-method-enabled", payload: { authMethod } }],
      });
    await link("usr_one10295");
    if (secondLink)
      await post("/internal/auth/users/usr_one10295/social-login-link", {
        providerName: "facebook",
        providerSubject: "synthetic-second-subject",
        email: EMAIL,
      });
  }

  it.each([false, true])(
    "authenticated unlink persists one receipt and %s other-link proof shape, preserves claim and remains revoked on replay/day after",
    async (secondLink) => {
      await seedUnlink(undefined, secondLink);
      const api = authenticatedApi(unlinkActor());
      const [firstResponse, concurrentResponse] = await Promise.all([
        api.request("/users/usr_one10295/social-login/unlink", unlinkRequest()),
        api.request("/users/usr_one10295/social-login/unlink", unlinkRequest()),
      ]);
      expect(firstResponse.status).toBe(200);
      expect(concurrentResponse.status).toBe(200);
      const first = await firstResponse.json();
      const concurrent = await concurrentResponse.json();
      expect(concurrent.receipt).toEqual(first.receipt);
      expect([first.newlyCommitted, concurrent.newlyCommitted].sort()).toEqual([false, true]);
      expect(Object.keys(first).sort()).toEqual(["current", "destination", "newlyCommitted", "outcome", "receipt"]);
      expect(first.receipt.events.map((proof: { type: string }) => proof.type)).toEqual([
        "identity.user.social-login-revocation-requested",
        "identity.user.social-login-revoked",
        ...(secondLink ? [] : ["identity.user.auth-method-disabled"]),
      ]);
      expect(Object.keys(first.receipt).sort()).toEqual([
        "action",
        "binding",
        "category",
        "committedVersion",
        "events",
        "hash",
        "owner",
        "priorVersion",
        "result",
        "schemaVersion",
        "target",
      ]);
      const count = await eventCount();
      const repeat = await api.request("/users/usr_one10295/social-login/unlink", unlinkRequest());
      expect(await repeat.json()).toEqual({
        ...first,
        newlyCommitted: false,
        destination: expect.stringMatching(/^\/account\/security\?afterWrite=/),
      });
      const lookup = await api.request(
        `/account-management/attempts?action=unlink-social-login&target=${linkKey(SUBJECT)}`,
        { headers: { "Idempotency-Key": unlinkAttempt } },
      );
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toEqual({
        ...first,
        newlyCommitted: false,
        destination: expect.stringMatching(/^\/account\/security\?afterWrite=/),
      });
      const fresh = await api.request(
        "/users/usr_one10295/social-login/unlink",
        unlinkRequest(undefined, "a230f01b-7871-420b-9c32-37139f80f749"),
      );
      expect(fresh.status).toBe(409);
      expect(await fresh.json()).toEqual({ outcome: "conflict", code: "social-login-link-not-active" });
      expect(await eventCount()).toBe(count);
      expect(
        (await events()).filter(
          (event) => event.eventType === "identity.account-management-mutation-attempt.committed",
        ),
      ).toHaveLength(1);
      expect((await stream(claimStream(SUBJECT))).map((event) => event.eventType)).toEqual([
        "identity.social-login-ownership.claimed",
      ]);
      await replayUserProjection();
      const lifecycle = (await stream("identity.user-usr_one10295")).filter(
        (event) => event.eventType.includes("revocation-requested") || event.eventType.endsWith("social-login-revoked"),
      );
      expect(lifecycle.map((event) => Object.keys(event.payload).sort())).toEqual([
        ["linkKey", "providerName", "requestedAt"],
        ["linkKey", "providerName", "revokedAt"],
      ]);
      const projection = services.projectors.find((set) => set.projectionName === "identity-user-projection")!;
      const oldLink = (await stream("identity.user-usr_one10295")).find(
        (event) => event.eventType === "identity.user.social-login-linked",
      )!;
      await projection.handlers[oldLink.eventType]!(toTransportEvent(oldLink));
      await replayUserProjection();
      expect(
        (await pool.query(`SELECT state FROM identity_user_social_login_links WHERE link_key = $1`, [linkKey(SUBJECT)]))
          .rows,
      ).toEqual([{ state: "revoked" }]);
      const dto = await (await api.request("/users/usr_one10295")).json();
      expect(Object.keys(dto.social_login_links[0]).sort()).toEqual(["linkKey", "linkedAt", "providerName", "state"]);
      expect(JSON.stringify(dto.social_login_links)).not.toContain(SUBJECT);
      expect(JSON.stringify(dto.social_login_links)).not.toContain(EMAIL);
      async function assertRevokedResolveAndRelinkAppendNothing() {
        const beforeResolve = await eventCount();
        const receiptsBeforeResolve = await receiptCount();
        expect(beforeResolve).toBe(count);
        expect(receiptsBeforeResolve).toBe(1);
        const resolution = await resolve();
        expect(resolution.status).toBe(200);
        expect(JSON.parse(resolution.text)).toEqual({
          status: "owned",
          userId: "usr_one10295",
          linkState: "revoked",
        });
        expect(await eventCount()).toBe(beforeResolve);
        expect(await receiptCount()).toBe(receiptsBeforeResolve);

        const beforeRelink = await eventCount();
        const receiptsBeforeRelink = await receiptCount();
        expect((await link("usr_one10295")).status).toBe(409);
        expect(await eventCount()).toBe(beforeRelink);
        expect(await receiptCount()).toBe(receiptsBeforeRelink);
        expect(await eventCount()).toBe(count);
      }
      await assertRevokedResolveAndRelinkAppendNothing();
      await assertRevokedResolveAndRelinkAppendNothing();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 86400000));
      try {
        await assertRevokedResolveAndRelinkAppendNothing();
        await assertRevokedResolveAndRelinkAppendNothing();
        expect(await eventCount()).toBe(count);
      } finally {
        vi.useRealTimers();
      }
      for (const surface of [JSON.stringify(first), JSON.stringify(lifecycle)]) {
        expect(surface).not.toContain(SUBJECT);
        expect(surface).not.toContain(EMAIL);
      }
    },
  );

  it("rejects missing authority, foreign admin URL, missing attempts and non-closed bodies before writes", async () => {
    await seedUnlink();
    const actor = unlinkActor();
    const count = await eventCount();
    for (const [authority, path, body, attempt, status] of [
      [null, "/users/usr_one10295/social-login/unlink", { linkKey: linkKey(SUBJECT) }, unlinkAttempt, 401],
      [
        { ...actor, permissions: [] },
        "/users/usr_one10295/social-login/unlink",
        { linkKey: linkKey(SUBJECT) },
        unlinkAttempt,
        403,
      ],
      [
        { ...actor, roleKey: "platform-admin" },
        "/users/usr_two10295/social-login/unlink",
        { linkKey: linkKey(SUBJECT) },
        unlinkAttempt,
        403,
      ],
      [actor, "/users/usr_one10295/social-login/unlink", { linkKey: linkKey(SUBJECT) }, null, 400],
      [
        actor,
        "/users/usr_one10295/social-login/unlink",
        { linkKey: linkKey(SUBJECT), actor: { marker: SUBJECT } },
        unlinkAttempt,
        400,
      ],
      [
        actor,
        "/users/usr_one10295/social-login/unlink",
        { linkKey: linkKey(SUBJECT), authenticationMethod: "password", authenticatedAt: new Date().toISOString() },
        unlinkAttempt,
        400,
      ],
    ] as const) {
      const response = await authenticatedApi(authority).request(path, unlinkRequest(body, attempt));
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain(SUBJECT);
      expect(text).not.toContain(EMAIL);
      expect(await eventCount()).toBe(count);
    }
  });

  it.each([
    "missing-time",
    "malformed-time",
    "date-only",
    "stale",
    "future",
    "missing-method",
    "target-method",
    "inactive-method",
    "last-method",
    "unknown-link",
    "foreign-link",
  ])("persists zero events and receipts for %s while isolating the named guard", async (guard) => {
    const inactive = guard === "inactive-method";
    const last = guard === "last-method";
    await seedUnlink(inactive || last ? ["social-login"] : undefined, inactive);
    let actor = unlinkActor();
    let target = linkKey(SUBJECT);
    let code = "recent-authentication-required";
    switch (guard) {
      case "missing-time":
        actor = { ...actor, authenticatedAt: undefined };
        break;
      case "malformed-time":
        actor = { ...actor, authenticatedAt: "marker-invalid" };
        break;
      case "date-only":
        actor = { ...actor, authenticatedAt: "2026-11-05" };
        break;
      case "stale":
        actor = { ...actor, authenticatedAt: new Date(Date.now() - 16 * 60000).toISOString() };
        break;
      case "future":
        actor = { ...actor, authenticatedAt: new Date(Date.now() + 60000).toISOString() };
        break;
      case "missing-method":
        actor = { ...actor, authenticationMethod: undefined };
        code = "authentication-method-not-different";
        break;
      case "target-method":
        actor = { ...actor, authenticationMethod: "google" };
        code = "authentication-method-not-different";
        break;
      case "inactive-method":
        code = "authentication-method-not-different";
        break;
      case "last-method":
        code = "last-authentication-method";
        break;
      case "unknown-link":
        target = "f".repeat(64);
        code = "social-login-link-not-active";
        break;
      case "foreign-link":
        await link("usr_two10295", "synthetic-foreign-subject");
        target = linkKey("synthetic-foreign-subject");
        code = "social-login-link-not-active";
        break;
    }
    const count = await eventCount();
    const response = await authenticatedApi(actor).request(
      "/users/usr_one10295/social-login/unlink",
      unlinkRequest({ linkKey: target }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ outcome: "conflict", code });
    expect(await eventCount()).toBe(count);
    expect(
      (await events()).filter((event) => event.eventType === "identity.account-management-mutation-attempt.committed"),
    ).toHaveLength(0);
  });

  it("resolves retained revocation-requested state explicitly and refuses relink without any append", async () => {
    await seedUnlink();
    await resolve();
    await services.eventStore!.appendToStream({
      streamId: "identity.user-usr_one10295",
      expectedVersion: "any",
      context: createBootstrapContext(),
      events: [
        {
          eventType: "identity.user.social-login-revocation-requested",
          payload: { providerName: "google", linkKey: linkKey(SUBJECT), requestedAt: new Date().toISOString() },
        },
      ],
    });
    const count = await eventCount();
    expect(JSON.parse((await resolve()).text)).toEqual({
      status: "owned",
      userId: "usr_one10295",
      linkState: "revocation-requested",
    });
    const refused = await link("usr_one10295");
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text)).toEqual({
      error: { code: "social_login_revoked", message: "Social login link is revoked." },
    });
    expect(await eventCount()).toBe(count);
  });

  it.each(["nested-unknown", "date-only", "out-of-order", "missing-third", "wrong-third", "extra-third"])(
    "fails closed on PostgreSQL retained lifecycle poison: %s",
    async (poison) => {
      await seedUnlink(undefined, poison === "extra-third");
      await resolve();
      const at = new Date().toISOString();
      const requested = {
        eventType: "identity.user.social-login-revocation-requested",
        payload: { providerName: "google", linkKey: linkKey(SUBJECT), requestedAt: at },
      };
      const revoked = {
        eventType: "identity.user.social-login-revoked",
        payload: { providerName: "google", linkKey: linkKey(SUBJECT), revokedAt: at },
      };
      const poisonEvents =
        poison === "nested-unknown"
          ? [{ ...requested, payload: { ...requested.payload, extra: { marker: SUBJECT } } }]
          : poison === "date-only"
            ? [{ ...requested, payload: { ...requested.payload, requestedAt: "2026-11-05" } }]
            : poison === "out-of-order"
              ? [revoked]
              : [
                  requested,
                  revoked,
                  ...(poison === "wrong-third" || poison === "extra-third"
                    ? [
                        {
                          eventType: "identity.user.auth-method-disabled",
                          payload: { authMethod: poison === "wrong-third" ? "password" : "social-login" },
                        },
                      ]
                    : []),
                ];
      await services.eventStore!.appendToStream({
        streamId: "identity.user-usr_one10295",
        expectedVersion: "any",
        context: createBootstrapContext(),
        events: poisonEvents,
      });
      const count = await eventCount();
      const response = await authenticatedApi(unlinkActor()).request(
        "/users/usr_one10295/social-login/unlink",
        unlinkRequest(),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ outcome: "indeterminate", code: "INDETERMINATE" });
      expect(await eventCount()).toBe(count);
      expect(
        (await events()).filter(
          (event) => event.eventType === "identity.account-management-mutation-attempt.committed",
        ),
      ).toHaveLength(0);
    },
  );

  it("backfills legacy link keys/state with fresh-equivalent nullability and CHECK constraints", async () => {
    await seedLegacyLink("usr_one10295");
    await replayUserProjection();
    const shape = () =>
      pool.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'identity_user_social_login_links' ORDER BY ordinal_position`,
      );
    const fresh = await shape();
    await pool.query(
      `ALTER TABLE identity_user_social_login_links DROP COLUMN link_key, DROP COLUMN state, DROP COLUMN revoked_at; UPDATE identity_users SET social_login_links = (SELECT jsonb_agg(link - 'state') FROM jsonb_array_elements(social_login_links) AS link) WHERE jsonb_array_length(social_login_links) > 0;`,
    );
    await pool.query(identityUserSchemaSql);
    await pool.query(identityUserSchemaSql);
    expect((await shape()).rows.find((column) => column.column_name === "link_key")).toMatchObject({
      is_nullable: "YES",
      column_default: null,
    });
    expect((await pool.query(`SELECT link_key, state, revoked_at FROM identity_user_social_login_links`)).rows).toEqual(
      [{ link_key: null, state: "active", revoked_at: null }],
    );
    for (const migration of identitySocialLoginSchemaMigrations)
      for (const statement of migration.statements) await pool.query(statement);
    const upgraded = await shape();
    expect(upgraded.rows.sort((a, b) => a.column_name.localeCompare(b.column_name))).toEqual(
      fresh.rows.sort((a, b) => a.column_name.localeCompare(b.column_name)),
    );
    expect((await pool.query(`SELECT link_key, state, revoked_at FROM identity_user_social_login_links`)).rows).toEqual(
      [{ link_key: linkKey(SUBJECT), state: "active", revoked_at: null }],
    );
    expect(JSON.parse((await resolve()).text)).toEqual({
      status: "owned",
      userId: "usr_one10295",
      linkState: "active",
    });
    await expect(pool.query(`UPDATE identity_user_social_login_links SET state = 'invalid'`)).rejects.toThrow();
    for (const migration of identitySocialLoginSchemaMigrations)
      for (const statement of migration.statements) await pool.query(statement);
  });

  it("issue-10295-ac1-race: racing Users get one owner and the loser appends nothing", async () => {
    const results = await Promise.all([link("usr_one10295"), link("usr_two10295")]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? "usr_one10295" : "usr_two10295";
    const loser = winner === "usr_one10295" ? "usr_two10295" : "usr_one10295";
    expect(JSON.parse(results.find((result) => result.status === 409)!.text)).toMatchObject({
      error: { code: "social_login_already_linked" },
    });
    expect((await stream(claimStream(SUBJECT))).map((event) => [event.eventType, event.payload])).toEqual([
      [
        "identity.social-login-ownership.claimed",
        { userId: winner, providerName: "google", linkKey: linkKey(SUBJECT) },
      ],
    ]);
    expect((await stream(`identity.user-${winner}`)).map((event) => event.eventType)).toEqual([
      "identity.user.created",
      "identity.user.auth-method-enabled",
      "identity.user.social-login-linked",
    ]);
    expect((await stream(`identity.user-${loser}`)).map((event) => event.eventType)).toEqual(["identity.user.created"]);
    // Three seeded Users plus the winner's claim, auth-method and link; the loser's transaction appended nothing.
    expect(await eventCount()).toBe(6);
  });

  it("issue-10295-ac1-idempotent: a same-owner retry returns the prior result and another owner gets 409, zero append", async () => {
    const first = await link("usr_one10295");
    expect(first.status).toBe(200);
    const count = await eventCount();
    const retry = await link("usr_one10295");
    expect(retry).toEqual(first);
    expect(JSON.parse(first.text)).toEqual({
      ok: true,
      userId: "usr_one10295",
      snapshots: [{ aggregate: "user", id: "usr_one10295", version: 3, status: "active" }],
    });
    const other = await link("usr_two10295");
    expect(other.status).toBe(409);
    expect(JSON.parse(other.text)).toMatchObject({ error: { code: "social_login_already_linked" } });
    expect(await eventCount()).toBe(count);
    expect(JSON.parse((await resolve()).text)).toEqual({
      status: "owned",
      userId: "usr_one10295",
      linkState: "active",
    });
  });

  it.each(["identity.user.social-login-linked", "identity.social-login-ownership.claimed"])(
    "issue-10295-ac1-atomic: an injected %s fault leaves no claim, auth-method or link event",
    async (eventType) => {
      const before = await events();
      await failInsertsOf(eventType);
      expect((await link("usr_one10295")).status).toBe(500);
      expect(await events()).toEqual(before);
      await pool.query("DROP TRIGGER issue10295_fail ON event_store_events; DROP FUNCTION issue10295_fail()");
      expect((await link("usr_one10295")).status).toBe(200);
    },
  );

  it("issue-10295-ac1-ac5-replay: truncate+replay keeps the first owner row, signals once subject-free, and never halts", async () => {
    expect((await link("usr_one10295")).status).toBe(200);
    await seedLegacyLink("usr_two10295");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let replay = 0; replay < 2; replay += 1) {
        await pool.query(
          "TRUNCATE identity_users, identity_user_emails, identity_user_phones, identity_user_social_login_links",
        );
        await replayUserProjection();
        const rows = await pool.query("SELECT provider_subject, user_id FROM identity_user_social_login_links");
        expect(rows.rows).toEqual([{ provider_subject: SUBJECT, user_id: "usr_one10295" }]);
      }
      const conflicts = warn.mock.calls.filter(([name]) => name === "social_login_link_conflict");
      expect(conflicts).toEqual(
        Array(2).fill([
          "social_login_link_conflict",
          { providerName: "google", linkKey: linkKey(SUBJECT), userIds: ["usr_one10295", "usr_two10295"] },
        ]),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(SUBJECT);
    } finally {
      warn.mockRestore();
    }
  });

  it("issue-10295-ac2-legacy: a legacy-only link refuses another User on the first post-deploy request and later", async () => {
    await seedLegacyLink("usr_one10295");
    const first = await link("usr_two10295");
    expect(first.status).toBe(409);
    expect(JSON.parse(first.text)).toMatchObject({ error: { code: "social_login_already_linked" } });
    expect((await stream("identity.user-usr_two10295")).map((event) => event.eventType)).toEqual([
      "identity.user.created",
    ]);
    expect((await stream(claimStream(SUBJECT))).map((event) => event.payload)).toEqual([
      { userId: "usr_one10295", providerName: "google", linkKey: linkKey(SUBJECT) },
    ]);
    const count = await eventCount();
    expect((await link("usr_two10295")).status).toBe(409);
    expect(JSON.parse((await resolve()).text)).toEqual({
      status: "owned",
      userId: "usr_one10295",
      linkState: "active",
    });
    expect((await link("usr_one10295")).status).toBe(200);
    expect(await eventCount()).toBe(count);
  });

  it("issue-10295-ac2-straggler: a straggler past the horizon is claimed, or repair-required when it contradicts a claim", async () => {
    expect((await link("usr_one10295")).status).toBe(200);
    expect(JSON.parse((await resolve()).text)).toEqual({
      status: "owned",
      userId: "usr_one10295",
      linkState: "active",
    });
    await seedLegacyLink("usr_three10295", "synthetic-straggler-10295");
    expect(JSON.parse((await resolve("synthetic-straggler-10295")).text)).toEqual({
      status: "owned",
      userId: "usr_three10295",
      linkState: "active",
    });

    await seedLegacyLink("usr_two10295");
    expect(JSON.parse((await resolve()).text)).toEqual({ status: "repair-required" });
    expect((await stream(claimStream(SUBJECT))).map((event) => event.eventType)).toEqual([
      "identity.social-login-ownership.claimed",
      "identity.social-login-ownership.repair-required",
    ]);
    const count = await eventCount();
    const refused = await link("usr_one10295");
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text)).toMatchObject({ error: { code: "social_login_repair_required" } });
    expect(await eventCount()).toBe(count);
  });

  it("issue-10295-ac2-two-user-rerun: two-User history is repair-required and a rerun appends nothing", async () => {
    await seedLegacyLink("usr_one10295");
    await seedLegacyLink("usr_two10295");
    expect(JSON.parse((await resolve()).text)).toEqual({ status: "repair-required" });
    expect((await stream(claimStream(SUBJECT))).map((event) => event.payload)).toEqual([
      { providerName: "google", linkKey: linkKey(SUBJECT), userIds: ["usr_one10295", "usr_two10295"] },
    ]);
    const count = await eventCount();
    expect(await catchUp()).toBeNull();
    expect(JSON.parse((await resolve()).text)).toEqual({ status: "repair-required" });
    expect((await link("usr_two10295")).status).toBe(409);
    expect(await eventCount()).toBe(count);
  });

  it("issue-10295-ac2-page-boundary: the only conflicting legacy link just past page one still marks repair-required", async () => {
    const projectionRows = await pool.query(
      "SELECT (SELECT count(*) FROM identity_users)::int AS users, (SELECT count(*) FROM identity_user_social_login_links)::int AS links",
    );
    expect(projectionRows.rows).toEqual([{ users: 0, links: 0 }]);
    await seedLegacyLink("usr_one10295", "synthetic-page-a-10295");
    await seedLegacyLink("usr_two10295", "synthetic-page-b-10295");
    await seedLegacyLink("usr_three10295", "synthetic-page-a-10295");

    expect(await catchUp(2)).toMatchObject({ claimed: 1, repairRequired: 1 });
    expect((await stream(claimStream("synthetic-page-a-10295"))).map((event) => event.eventType)).toEqual([
      "identity.social-login-ownership.repair-required",
    ]);
    expect((await stream(claimStream("synthetic-page-b-10295"))).map((event) => event.payload)).toEqual([
      { userId: "usr_two10295", providerName: "google", linkKey: linkKey("synthetic-page-b-10295") },
    ]);
    const record = await stream(SOCIAL_LOGIN_OWNERSHIP_CATCH_UP_STREAM);
    expect(record.map((event) => [event.eventType, event.payload.claimed, event.payload.repairRequired])).toEqual([
      ["identity.social-login-ownership.caught-up", 1, 1],
    ]);
    expect(await catchUp(2)).toBeNull();
  });

  it("issue-10295-ac4-closed-inputs: bad link/resolve input gets 400 and zero append; markers never leave the link fact", async () => {
    const before = await eventCount();
    for (const [path, body] of [
      ["/internal/auth/users/usr_one10295/social-login-link", "{"],
      ["/internal/auth/users/usr_one10295/social-login-link", { providerName: "google", providerSubject: SUBJECT }],
      [
        "/internal/auth/users/usr_one10295/social-login-link",
        { providerName: "github", providerSubject: SUBJECT, email: EMAIL },
      ],
      [
        "/internal/auth/users/usr_one10295/social-login-link",
        { providerName: "google", providerSubject: "x".repeat(513), email: EMAIL },
      ],
      [
        "/internal/auth/users/usr_one10295/social-login-link",
        { providerName: "google", providerSubject: SUBJECT, email: "x".repeat(321) },
      ],
      [
        "/internal/auth/users/usr_one10295/social-login-link",
        { providerName: "google", providerSubject: SUBJECT, email: EMAIL, extra: 1 },
      ],
      ["/internal/auth/social-login-subjects/resolve", { providerName: "google", providerSubject: "" }],
      ["/internal/auth/social-login-subjects/resolve", { providerName: "google", providerSubject: SUBJECT, extra: 1 }],
    ] as const) {
      const response = await post(path, body);
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toMatchObject({ error: { code: "validation_failed" } });
      expect(response.text).not.toContain(SUBJECT);
      expect(response.text).not.toContain(EMAIL);
    }
    expect(await eventCount()).toBe(before);

    const logged = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      await seedLegacyLink("usr_two10295");
      const responses = [await link("usr_one10295"), await resolve(), await link("usr_two10295")];
      for (const response of responses) {
        expect(response.text).not.toContain(SUBJECT);
        expect(response.text).not.toContain(EMAIL);
      }
      const ownershipEvents = (await events()).filter((event) => !event.streamId.startsWith("identity.user-"));
      const streamIds = (await pool.query<{ stream_id: string }>("SELECT stream_id FROM event_store_streams")).rows;
      for (const surface of [
        JSON.stringify(ownershipEvents),
        JSON.stringify(streamIds),
        JSON.stringify(logged.map((spy) => spy.mock.calls)),
      ]) {
        expect(surface).not.toContain(SUBJECT);
        expect(surface).not.toContain(EMAIL);
      }
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });
});
