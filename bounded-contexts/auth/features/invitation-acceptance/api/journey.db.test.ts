import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as authModule } from "../../../index";
import { module as identityModule } from "../../../../identity/index";
import { buildIdentityApi, type IdentityApiEnv } from "../../../../identity/api";
import { createIdentityServices } from "../../../../identity/support/runtime-support/services";
import { DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY } from "../../../../identity/features/account-capabilities/api/authority";
import { createIdentityAuthRequestClient } from "@chase-sets/identity/server";
import {
  acceptanceContext,
  seedAcceptance,
} from "../../../../identity/features/invitations/api/acceptance-test-support";
import { createAuthServices } from "../../../support/runtime-support/services";
import { insertChallenge, upsertPasswordCredential } from "../../../support/auth-support/store";
import { acceptInvitationAttempt, lookupInvitationAttempt } from "./journey";
import { readAttempt } from "./attempt-store";
import { ATTEMPT_STAGES } from "../domain/attempt";
import { authRetentionSweeps } from "../../../support/runtime-support/retention-policy";
import { invitationAttemptRollout } from "./rollout";
import { mintRegistrationConsentResolution } from "../../../../identity/features/consents/domain/registration-consent";
import { resolveRegistrationConsentSigningKeys } from "../../../../identity/support/runtime-support/registration-consent-signing";

vi.mock("./rollout", () => ({ invitationAttemptRollout: { active: true, requireAttempt: true } }));
vi.mock("../../../support/auth-support/webauthn", () => ({
  verifyPasskeyRegistration: vi.fn(async () => ({
    externalCredentialId: "synthetic-credential-handle",
    publicKey: "synthetic-public-key",
    signCount: 0,
    credentialDeviceType: "singleDevice",
    credentialBackedUp: false,
  })),
}));
const base = process.env.TEST_DATABASE_URL;
if (!base && process.env.CI) throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
const attemptId = "01c9f50d-cb3e-42ac-a0a8-8b5f887a01ea";
const token = "synthetic-invitation-token";
const request = new Request("http://localhost/invite/ivt_invited");

(base ? describe : describe.skip)("invitation-acceptance-stage-recovery", () => {
  let pools: Readonly<Record<"identity" | "auth", PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(base!, ["identity", "auth"], "invitation_acceptance_recovery");
    await ensureMultiContextTestDatabases(base!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    Object.assign(invitationAttemptRollout, { active: true });
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(authModule, pools.auth);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });
  async function fixture(kind: "password" | "passkey", existing: boolean, storedPassword = false) {
    const services = createAuthServices(pools.auth);
    const identity = createIdentityServices(pools.identity, {
      capabilityAdministrationAuthority: DENY_ALL_CAPABILITY_ADMINISTRATION_AUTHORITY,
    });
    await seedAcceptance(identity.eventStore!, existing);
    const invitation = await identity.invitations.getInvitationState("ivt_invited");
    await identity.invitations.commandHandler({
      streamId: "identity.invitation-ivt_invited",
      command: {
        type: "IssueInvitationAcceptanceToken",
        tokenHash: services.auth.hashSecret(token),
        expiresAt: new Date(Math.min(Date.now() + 3600_000, Date.parse(invitation!.expiresAt!))).toISOString(),
      },
      context: acceptanceContext,
    });
    if (existing) {
      await pools.identity.query(
        "INSERT INTO identity_users (user_id, display_name, given_name, family_name, primary_email, status) VALUES ('usr_recipient','Recipient','','','recipient@example.com','active')",
      );
      await pools.identity.query(
        "INSERT INTO identity_user_emails (email,user_id,contact_method_id) VALUES ('recipient@example.com','usr_recipient','ctm_recipient')",
      );
    }
    await pools.auth.query(
      "INSERT INTO auth_identity_accounts (account_id,name,display_name,account_type,status) VALUES ('acc_invited','Invited','Invited','business','active')",
    );
    await insertChallenge(pools.auth, {
      challengeId: "cmd_ceremony",
      email: "recipient@example.com",
      userId: null,
      purpose: "passkey-register",
      challengeValue: "synthetic-challenge",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    const app = new Hono<IdentityApiEnv>();
    app.use("*", async (c, next) => {
      c.set("context", acceptanceContext);
      await next();
    });
    app.route("/api/identity", buildIdentityApi(identity));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init));
    const client = createIdentityAuthRequestClient(request);
    const input = {
      attemptId,
      invitationId: "ivt_invited",
      token,
      ...(kind === "password"
        ? { password: "synthetic-correct-horse-password" }
        : { challengeId: "cmd_ceremony", challenge: "synthetic-challenge", webauthnResponse: "{}" }),
    };
    if (storedPassword) {
      await client.enablePasswordCredential({ userId: "usr_recipient", credentialId: "crd_existing" });
      await upsertPasswordCredential(pools.auth, {
        userId: "usr_recipient",
        credentialId: "crd_existing",
        secretHash: await services.auth.hashPassword("synthetic-correct-horse-password"),
      });
    }
    return { services, client, input, identity };
  }
  it("F4 stored-password wrong proof has zero owner, credential, Membership and Session effects", async () => {
    const f = await fixture("password", true, true);
    const identityEvents = (
      await pools.identity.query("SELECT event_id FROM event_store_events ORDER BY global_position")
    ).rows;
    const credentials = (await pools.auth.query("SELECT credential_id, secret_hash FROM identity_password_credentials"))
      .rows;
    await expect(
      acceptInvitationAttempt(
        f.services,
        f.client,
        { ...f.input, password: "synthetic-wrong-password" },
        request,
        acceptanceContext,
      ),
    ).rejects.toMatchObject({ code: "invitation_attempt_invalid" });
    expect(
      (await pools.identity.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows,
    ).toEqual(identityEvents);
    expect(
      (await pools.auth.query("SELECT credential_id, secret_hash FROM identity_password_credentials")).rows,
    ).toEqual(credentials);
    expect((await pools.auth.query("SELECT session_id FROM identity_session_tokens")).rows).toEqual([]);
    expect(
      (await pools.auth.query("SELECT event_id FROM event_store_events WHERE event_type = 'auth.session.started'"))
        .rows,
    ).toEqual([]);
  });
  it("F4 second-Consent activation between preflight and registration refuses without partials on deterministic retry", async () => {
    const f = await fixture("password", false);
    const resolve = f.client.resolveRegistrationConsent;
    let calls = 0;
    const resolution = mintRegistrationConsentResolution({
      requirements: [
        { policyKey: "terms-of-service", version: "synthetic-v1", href: "/terms" },
        { policyKey: "privacy-policy", version: "synthetic-v1", href: "/privacy" },
      ],
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    });
    const client = { ...f.client, resolveRegistrationConsent: async () => (++calls === 1 ? resolve() : resolution) };
    const baseline = (await pools.identity.query("SELECT event_id FROM event_store_events ORDER BY global_position"))
      .rows;
    for (let retry = 0; retry < 2; retry++) {
      await expect(
        acceptInvitationAttempt(f.services, client, f.input, request, acceptanceContext),
      ).rejects.toMatchObject({ status: 400 });
      expect(
        (await pools.identity.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows,
      ).toEqual(baseline);
      expect((await pools.auth.query("SELECT credential_id FROM identity_password_credentials")).rows).toEqual([]);
      expect((await pools.auth.query("SELECT session_id FROM identity_session_tokens")).rows).toEqual([]);
      expect((await readAttempt(f.services.eventStore, attemptId, acceptanceContext))?.stage).toBe(
        "registration-started",
      );
    }
    expect(calls).toBe(3);
  });
  it("F4 real registration batch fault leaves no participants and retry completes once", async () => {
    const f = await fixture("password", false);
    const store = f.identity.eventStore!;
    const append = store.appendToStreams!.bind(store);
    const baseline = (await pools.identity.query("SELECT event_id FROM event_store_events ORDER BY global_position"))
      .rows;
    const fault = vi.spyOn(store, "appendToStreams").mockImplementation(async (inputs) => {
      if (inputs.some((input) => input.events.some((event) => event.eventType === "identity.user.created")))
        throw new Error("synthetic registration batch fault");
      return append(inputs);
    });
    try {
      await expect(
        acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext),
      ).rejects.toMatchObject({ status: 500 });
      expect(
        (await pools.identity.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows,
      ).toEqual(baseline);
      expect((await pools.auth.query("SELECT credential_id FROM identity_password_credentials")).rows).toEqual([]);
      expect((await pools.auth.query("SELECT session_id FROM identity_session_tokens")).rows).toEqual([]);
    } finally {
      fault.mockRestore();
    }
    expect((await acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext)).type).toBe(
      "session-started",
    );
    expect(
      (await pools.identity.query("SELECT event_id FROM event_store_events WHERE event_type = 'identity.user.created'"))
        .rows,
    ).toHaveLength(1);
    expect(
      (
        await pools.identity.query(
          "SELECT event_id FROM event_store_events WHERE event_type = 'identity.consent.recorded'",
        )
      ).rows,
    ).toEqual([]);
    expect((await pools.auth.query("SELECT session_id FROM identity_session_tokens")).rows).toHaveLength(1);
  });
  it("refuses a real signed unaffirmed nonempty Consent before writes", async () => {
    const f = await fixture("password", false);
    const resolution = mintRegistrationConsentResolution({
      requirements: [{ policyKey: "terms-of-service", version: "synthetic-v1", href: "/terms" }],
      resolvedAt: new Date().toISOString(),
      signingKeys: resolveRegistrationConsentSigningKeys(),
    });
    const client = { ...f.client, resolveRegistrationConsent: async () => resolution };
    await expect(acceptInvitationAttempt(f.services, client, f.input, request, acceptanceContext)).rejects.toThrow();
    expect((await pools.auth.query("SELECT event_id FROM event_store_events")).rows).toEqual([]);
    expect((await pools.auth.query("SELECT attempt_id FROM auth_invitation_acceptance_attempts")).rows).toEqual([]);
    expect((await pools.auth.query("SELECT credential_id FROM identity_password_credentials")).rows).toEqual([]);
    expect(
      (await pools.identity.query("SELECT event_id FROM event_store_events WHERE event_type = 'identity.user.created'"))
        .rows,
    ).toEqual([]);
  });
  it("a concurrent attempt lock loser writes nothing and retained owner state remains resumable", async () => {
    const f = await fixture("password", false);
    const connection = await pools.auth.connect();
    const key = `auth:invitation-acceptance:${acceptanceContext.tenantId}:${f.input.invitationId}`;
    try {
      await connection.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [key]);
      await expect(
        acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext),
      ).rejects.toThrow();
      expect((await pools.auth.query("SELECT event_id FROM event_store_events")).rows).toEqual([]);
    } finally {
      await connection.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      connection.release();
    }
    expect((await acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext)).type).toBe(
      "session-started",
    );
    expect((await acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext)).type).toBe(
      "accepted-reauth-required",
    );
    expect((await pools.auth.query("SELECT session_id FROM identity_session_tokens")).rows).toHaveLength(1);
  });
  for (const kind of ["password", "passkey"] as const)
    for (const existing of [false, true])
      for (const storedPassword of kind === "password" && existing ? [false, true] : [false]) {
        it.each(ATTEMPT_STAGES)(
          `${kind} ${existing ? "existing" : "new"}${storedPassword ? " stored-password" : ""} User recovers a pre-%s checkpoint fault through real owner HTTP and Postgres`,
          async (stage) => {
            const f = await fixture(kind, existing, storedPassword);
            let faulted = false;
            const store = f.services.eventStore;
            const services = {
              ...f.services,
              eventStore: {
                ...store,
                appendToStream: async (input: Parameters<typeof store.appendToStream>[0]) => {
                  if (!faulted && input.events[0]?.payload.stage === stage) {
                    faulted = true;
                    throw new Error("synthetic checkpoint fault");
                  }
                  return store.appendToStream(input);
                },
              },
            };
            await expect(
              acceptInvitationAttempt(services, f.client, f.input, request, acceptanceContext),
            ).rejects.toThrow();
            const resumed = await acceptInvitationAttempt(
              createAuthServices(pools.auth),
              f.client,
              f.input,
              request,
              acceptanceContext,
            );
            expect(resumed.type).toBe(stage === "completed" ? "accepted-reauth-required" : "session-started");
            const state = await readAttempt(store, attemptId, acceptanceContext);
            expect(state?.stage).toBe("completed");
            const counts = await pools.auth.query<{ count: string }>(
              "SELECT count(*) FROM event_store_events WHERE event_type = 'auth.session.started'",
            );
            expect(counts.rows[0].count).toBe("1");
            expect(
              (await pools.auth.query<{ count: string }>("SELECT count(*) FROM identity_session_tokens")).rows[0].count,
            ).toBe("1");
            const membership = await pools.identity.query<{ count: string }>(
              "SELECT count(*) FROM event_store_events WHERE stream_id = $1 AND event_type = 'identity.membership.granted'",
              [`identity.membership-${state!.binding.membershipId}`],
            );
            expect(membership.rows[0].count).toBe("1");
            if (!existing) {
              const founders = await pools.identity.query<{ payload: { betaAccessStartedAt: string } }>(
                "SELECT payload FROM event_store_events WHERE event_type = 'identity.account.founders-window-opened'",
              );
              expect(founders.rows).toHaveLength(1);
              expect(founders.rows[0].payload.betaAccessStartedAt).toBe(state!.registrationStartedAt);
            }
            if (storedPassword) {
              expect(state!.binding.credentialId).toBe("crd_existing");
              expect((await pools.auth.query("SELECT credential_id FROM identity_password_credentials")).rows).toEqual([
                { credential_id: "crd_existing" },
              ]);
            }
            const events = await pools.auth.query("SELECT payload FROM event_store_events WHERE stream_id = $1", [
              `auth.invitation-acceptance-${attemptId}`,
            ]);
            expect(JSON.stringify(events.rows)).not.toMatch(
              /synthetic-invitation-token|synthetic-correct-horse-password|synthetic-challenge|synthetic-public-key/,
            );
          },
        );
      }
  it("retained restart and day-after lookup remain inert with the original credential and Session", async () => {
    const f = await fixture("password", true);
    await acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext);
    const tokens = (await pools.auth.query("SELECT session_id, token_hash FROM identity_session_tokens")).rows;
    const events = (await pools.auth.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows;
    try {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 86400_000);
      const restarted = createAuthServices(pools.auth);
      expect(await lookupInvitationAttempt(restarted, f.client, f.input, acceptanceContext)).toEqual({
        type: "accepted-reauth-required",
        attemptId,
      });
      expect((await acceptInvitationAttempt(restarted, f.client, f.input, request, acceptanceContext)).type).toBe(
        "accepted-reauth-required",
      );
      expect((await pools.auth.query("SELECT session_id, token_hash FROM identity_session_tokens")).rows).toEqual(
        tokens,
      );
      expect((await pools.auth.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows).toEqual(
        events,
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("invitation-acceptance-compatibility-floor honors recorded attempts after deactivation and only sweeps old terminals", async () => {
    const f = await fixture("password", true);
    await acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext);
    Object.assign(invitationAttemptRollout, { active: false });
    expect(await lookupInvitationAttempt(f.services, f.client, f.input, acceptanceContext)).toEqual({
      type: "accepted-reauth-required",
      attemptId,
    });
    expect((await acceptInvitationAttempt(f.services, f.client, f.input, request, acceptanceContext)).type).toBe(
      "accepted-reauth-required",
    );
    await pools.auth.query(
      "INSERT INTO auth_invitation_acceptance_attempts (attempt_id,created_at) VALUES ('synthetic-nonterminal',now()-interval '60 days')",
    );
    await pools.auth.query(
      "INSERT INTO auth_invitation_acceptance_attempts (attempt_id,terminal_at) VALUES ('synthetic-old-terminal',now()-interval '31 days')",
    );
    const sweep = authRetentionSweeps.find((sweep) => sweep.name === "terminal-invitation-acceptance-attempts")!;
    const eligible = await pools.auth.query<{ attempt_id: string }>(
      `SELECT candidate.attempt_id FROM auth_invitation_acceptance_attempts candidate WHERE ${sweep.predicateSql}`,
    );
    expect(eligible.rows.map((row) => row.attempt_id)).toEqual(["synthetic-old-terminal"]);
  });
});
