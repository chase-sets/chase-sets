import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { buildSessionProjectionHandlers } from "../../features/sessions/read-model/projection";
import { authSchemaSql } from "../runtime-support/schema";
import { ROLE_PERMISSIONS } from "@chase-sets/auth-context";
import authManifest from "../../context.json";
import {
  buildAuthIdentityAccountProjectionHandlers,
  buildAuthIdentityInvitationProjectionHandlers,
  buildAuthIdentityMembershipProjectionHandlers,
  buildAuthIdentityUserProjectionHandlers,
  authSocialLoginSchemaMigrations,
} from "./identity-projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;
const contextNames = ["auth"] as const;

describeDb("auth projection row identity", () => {
  let pool: PgTransactionalPool;
  let pools: Readonly<Record<(typeof contextNames)[number], PgTransactionalPool>>;

  beforeAll(async () => {
    const databaseUrls = createMultiContextTestDatabaseUrls(
      requireDatabaseBaseUrl(),
      contextNames,
      "auth_projection_rows",
    );
    await ensureMultiContextTestDatabases(requireDatabaseBaseUrl(), databaseUrls);
    pools = createMultiContextTestPools(databaseUrls);
    pool = pools.auth;
  });

  beforeEach(async () => {
    nextGlobalPosition = 0;
    await resetMultiContextTestSchemas({ auth: pool });
    await pool.query(authSchemaSql);
  });

  afterAll(async () => {
    await closeMultiContextTestPools(pools);
  });

  it("delivers manifest-backed revocation and disabled-method facts without linked replay reactivation", async () => {
    const handlers = buildAuthIdentityUserProjectionHandlers(pool);
    const subscription = authManifest.eventSubscriptions.find(
      (entry) => entry.projectionName === "auth-identity-user-projection",
    )!;
    expect(subscription.subscriptionVersion).toBe(2);
    const userId = "usr_lifecycle";
    const streamId = `identity.user-${userId}`;
    const linked = {
      providerName: "google",
      providerSubject: "synthetic-lifecycle-subject",
      email: "marker@example.test",
      linkedAt: "2026-06-12T12:11:00.000Z",
    };
    const linkKey = createHash("sha256")
      .update(`${linked.providerName}:${linked.providerSubject}`, "utf8")
      .digest("hex");
    const deliver = async (type: string, data: TransportEvent["data"]) => {
      expect(subscription.eventTypes).toContain(type);
      await project(handlers, event(type, streamId, data));
    };
    await deliver("identity.user.created", {
      userId,
      displayName: "Synthetic",
      givenName: "",
      familyName: "",
      primaryEmail: linked.email,
    });
    await deliver("identity.user.auth-method-enabled", { authMethod: "social-login" });
    await deliver("identity.user.social-login-linked", linked);
    await deliver("identity.user.social-login-revocation-requested", {
      providerName: "google",
      linkKey,
      requestedAt: "2026-06-12T12:12:00.000Z",
    });
    expect((await pool.query(`SELECT state FROM auth_identity_user_social_login_links`)).rows).toEqual([
      { state: "revocation-requested" },
    ]);
    await deliver("identity.user.social-login-revoked", {
      providerName: "google",
      linkKey,
      revokedAt: "2026-06-12T12:13:00.000Z",
    });
    await deliver("identity.user.auth-method-disabled", { authMethod: "social-login" });
    await deliver("identity.user.social-login-linked", linked);
    await deliver("identity.user.social-login-revoked", {
      providerName: "google",
      linkKey,
      revokedAt: "2026-06-12T12:13:00.000Z",
    });
    const row = (await pool.query(`SELECT state, revoked_at FROM auth_identity_user_social_login_links`)).rows[0];
    expect(row.state).toBe("revoked");
    expect(row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at).toBe(
      "2026-06-12T12:13:00.000Z",
    );
    expect(
      (
        await pool.query(`SELECT auth_methods, social_login_links FROM auth_identity_users WHERE user_id = $1`, [
          userId,
        ])
      ).rows,
    ).toEqual([
      {
        auth_methods: [],
        social_login_links: [
          {
            ...linked,
            state: "revoked",
            requestedAt: "2026-06-12T12:12:00.000Z",
            revokedAt: "2026-06-12T12:13:00.000Z",
          },
        ],
      },
    ]);
  });

  it("upgrades populated legacy Auth links to fresh-equivalent constraints and active state", async () => {
    const shape = () =>
      pool.query(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'auth_identity_user_social_login_links' ORDER BY column_name`,
      );
    const fresh = await shape();
    await pool.query(
      `ALTER TABLE auth_identity_user_social_login_links DROP COLUMN link_key, DROP COLUMN state, DROP COLUMN revoked_at; INSERT INTO auth_identity_user_social_login_links (provider_name, provider_subject, user_id, email, linked_at) VALUES ('google', 'legacy-subject', 'usr_legacy', 'legacy@example.test', '2026-01-01T00:00:00Z');`,
    );
    await pool.query(authSchemaSql);
    await pool.query(authSchemaSql);
    expect((await shape()).rows.find((column) => column.column_name === "link_key")).toMatchObject({
      is_nullable: "YES",
      column_default: null,
    });
    expect(
      (await pool.query(`SELECT link_key, state, revoked_at FROM auth_identity_user_social_login_links`)).rows,
    ).toEqual([{ link_key: null, state: "active", revoked_at: null }]);
    for (const migration of authSocialLoginSchemaMigrations)
      for (const statement of migration.statements) await pool.query(statement);
    expect((await shape()).rows).toEqual(fresh.rows);
    expect(
      (await pool.query(`SELECT link_key, state, revoked_at FROM auth_identity_user_social_login_links`)).rows,
    ).toEqual([
      {
        link_key: createHash("sha256").update("google:legacy-subject").digest("hex"),
        state: "active",
        revoked_at: null,
      },
    ]);
    await expect(pool.query(`UPDATE auth_identity_user_social_login_links SET state = 'invalid'`)).rejects.toThrow();
    for (const migration of authSocialLoginSchemaMigrations)
      for (const statement of migration.statements) await pool.query(statement);
  });

  it("projects representative auth rows exactly as the pre-toolkit SQL did", async () => {
    const accountHandlers = buildAuthIdentityAccountProjectionHandlers(pool);
    const userHandlers = buildAuthIdentityUserProjectionHandlers(pool);
    const membershipHandlers = buildAuthIdentityMembershipProjectionHandlers(pool);
    const invitationHandlers = buildAuthIdentityInvitationProjectionHandlers(pool);
    const sessionHandlers = buildSessionProjectionHandlers(pool);

    await project(
      accountHandlers,
      event("identity.account.created", "identity.account-acc_1", {
        accountId: "acc_1",
        name: "seller-one",
        displayName: "Seller One",
        accountType: "seller",
      }),
    );
    await project(
      accountHandlers,
      event("identity.account.profile-updated", "identity.account-acc_1", {
        name: "seller-uno",
        displayName: "Seller Uno",
      }),
    );
    await project(accountHandlers, event("identity.account.suspended", "identity.account-acc_1", {}));
    await project(accountHandlers, event("identity.account.reactivated", "identity.account-acc_1", {}));

    await project(
      userHandlers,
      event("identity.user.created", "identity.user-usr_1", {
        userId: "usr_1",
        displayName: "Original User",
        givenName: "Original",
        familyName: "User",
        primaryEmail: "Primary@Example.COM",
      }),
    );
    await project(
      userHandlers,
      event("identity.user.profile-updated", "identity.user-usr_1", {
        displayName: "Test User",
        givenName: "Test",
        familyName: "User",
      }),
    );
    await project(
      userHandlers,
      event("identity.user.contact-method-added", "identity.user-usr_1", {
        contactMethodId: "cm_phone",
        contactMethodType: "phone",
        value: "(555) 111-2222",
      }),
    );
    await project(
      userHandlers,
      event("identity.user.contact-method-verified", "identity.user-usr_1", {
        contactMethodId: "cm_phone",
        verifiedAt: "2026-06-12T12:07:00.000Z",
      }),
    );
    await project(
      userHandlers,
      event("identity.user.auth-method-enabled", "identity.user-usr_1", { authMethod: "password" }),
    );
    await project(
      userHandlers,
      event("identity.user.password-credential-attached", "identity.user-usr_1", {
        credentialId: "pwd_1",
      }),
    );
    await project(
      userHandlers,
      event("identity.user.passkey-registered", "identity.user-usr_1", {
        credentialId: "psk_1",
      }),
    );
    await project(
      userHandlers,
      event("identity.user.social-login-linked", "identity.user-usr_1", {
        providerName: "google",
        providerSubject: "google_sub_1",
        email: " Social@Example.COM ",
        linkedAt: "2026-06-12T12:11:00.000Z",
      }),
    );
    await project(userHandlers, event("identity.user.suspended", "identity.user-usr_1", {}));
    await project(userHandlers, event("identity.user.reactivated", "identity.user-usr_1", {}));

    await project(
      membershipHandlers,
      event("identity.membership.granted", "identity.membership-mem_1", {
        membershipId: "mem_1",
        userId: "usr_1",
        accountId: "acc_1",
        roleKey: "owner",
      }),
    );
    await project(
      membershipHandlers,
      event("identity.membership.role-changed", "identity.membership-mem_1", {
        roleKey: "manager",
      }),
    );
    await project(membershipHandlers, event("identity.membership.revoked", "identity.membership-mem_1", {}));
    await project(membershipHandlers, event("identity.membership.reinstated", "identity.membership-mem_1", {}));

    await project(
      invitationHandlers,
      event("identity.invitation.created", "identity.invitation-inv_1", {
        invitationId: "inv_1",
        accountId: "acc_1",
        email: " Invitee@Example.COM ",
        roleKey: "viewer",
        expiresAt: "2026-06-20T00:00:00.000Z",
      }),
    );
    await project(
      invitationHandlers,
      event("identity.invitation.resent", "identity.invitation-inv_1", {
        expiresAt: "2026-06-21T00:00:00.000Z",
      }),
    );
    await project(
      invitationHandlers,
      event("identity.invitation.accepted", "identity.invitation-inv_1", {
        userId: "usr_1",
      }),
    );

    await project(
      sessionHandlers,
      event("auth.session.started", "auth.session-ses_1", {
        sessionId: "ses_1",
        userId: "usr_1",
        accountId: "acc_1",
        availableAccountIds: ["acc_1", "acc_2"],
        authenticationMethod: "password",
        expiresAt: "2026-06-13T00:00:00.000Z",
      }),
    );
    await pool.query(
      `INSERT INTO identity_session_lookup (
         token_hash,
         session_id,
         user_id,
         account_id,
         status,
         expires_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
      ["tok_1", "ses_1", "usr_1", "acc_1", "2026-06-13T00:00:00.000Z", "2026-06-12T12:18:00.000Z"],
    );
    await project(
      sessionHandlers,
      event("auth.session.account-switched", "auth.session-ses_1", {
        accountId: "acc_2",
      }),
    );
    await project(sessionHandlers, event("auth.session.revoked", "auth.session-ses_1", {}));
    await project(sessionHandlers, event("auth.session.expired", "auth.session-ses_1", {}));

    const snapshot = await readAuthProjectionSnapshot(pool);

    // Row-identity proof: these expected rows are hand-computed from the pre-toolkit handlers' SQL for this event stream.
    expect(snapshot).toEqual({
      accounts: [
        {
          account_id: "acc_1",
          name: "seller-uno",
          display_name: "Seller Uno",
          account_type: "seller",
          status: "active",
          updated_at: "2026-06-12T12:04:00.000Z",
        },
      ],
      users: [
        {
          user_id: "usr_1",
          display_name: "Test User",
          given_name: "Test",
          family_name: "User",
          primary_email: "Primary@Example.COM",
          status: "active",
          contact_methods: [
            {
              contactMethodId: "usr_1-primary-email",
              type: "email",
              value: "Primary@Example.COM",
              verifiedAt: null,
            },
            {
              contactMethodId: "cm_phone",
              type: "phone",
              value: "(555) 111-2222",
              verifiedAt: "2026-06-12T12:07:00.000Z",
            },
          ],
          auth_methods: ["password"],
          password_credential_id: "pwd_1",
          passkey_credential_ids: ["psk_1"],
          social_login_links: [
            {
              providerName: "google",
              providerSubject: "google_sub_1",
              email: " Social@Example.COM ",
              linkedAt: "2026-06-12T12:11:00.000Z",
              state: "active",
            },
          ],
          updated_at: "2026-06-12T12:14:00.000Z",
        },
      ],
      userEmails: [
        {
          email: "primary@example.com",
          user_id: "usr_1",
          contact_method_id: "usr_1-primary-email",
          is_verified: false,
          updated_at: "2026-06-12T12:08:00.000Z",
        },
      ],
      userPhones: [
        {
          phone: "+15551112222",
          user_id: "usr_1",
          contact_method_id: "cm_phone",
          is_verified: true,
          updated_at: "2026-06-12T12:08:00.000Z",
        },
      ],
      socialLoginLinks: [
        {
          provider_name: "google",
          provider_subject: "google_sub_1",
          user_id: "usr_1",
          email: "social@example.com",
          linked_at: "2026-06-12T12:11:00.000Z",
          link_key: createHash("sha256").update("google:google_sub_1").digest("hex"),
          state: "active",
          revoked_at: null,
          updated_at: "2026-06-12T12:12:00.000Z",
        },
      ],
      memberships: [
        {
          membership_id: "mem_1",
          user_id: "usr_1",
          account_id: "acc_1",
          role_key: "manager",
          role_permissions: ROLE_PERMISSIONS.manager,
          status: "active",
          updated_at: "2026-06-12T12:18:00.000Z",
        },
      ],
      userMemberships: [
        {
          membership_id: "mem_1",
          user_id: "usr_1",
          account_id: "acc_1",
          role_key: "manager",
          role_permissions: ROLE_PERMISSIONS.manager,
          status: "active",
          updated_at: "2026-06-12T12:18:00.000Z",
        },
      ],
      invitations: [
        {
          invitation_id: "inv_1",
          account_id: "acc_1",
          email: "invitee@example.com",
          role_key: "viewer",
          status: "accepted",
          expires_at: "2026-06-21T00:00:00.000Z",
          accepted_by_user_id: "usr_1",
          invited_by_user_id: "usr_actor",
          updated_at: "2026-06-12T12:21:00.000Z",
        },
      ],
      sessions: [
        {
          session_id: "ses_1",
          user_id: "usr_1",
          account_id: "acc_2",
          available_account_ids: ["acc_1", "acc_2"],
          authentication_method: "password",
          status: "expired",
          expires_at: "2026-06-13T00:00:00.000Z",
          // Set once from the started event and left untouched by the
          // subsequent account-switch/revoke/expire mutations below, unlike
          // updated_at -- the recent-auth ("step-up") fact this row exists to
          // preserve.
          started_at: "2026-06-12T12:22:00.000Z",
          // The started event above predates the Session Generation floor
          // (no `sessionGeneration`), so the row projects generation 0.
          session_generation: 0,
          updated_at: "2026-06-12T12:25:00.000Z",
        },
      ],
      sessionLookup: [
        {
          token_hash: "tok_1",
          session_id: "ses_1",
          user_id: "usr_1",
          account_id: "acc_2",
          status: "expired",
          expires_at: "2026-06-13T00:00:00.000Z",
          updated_at: "2026-06-12T12:25:00.000Z",
        },
      ],
    });
  });

  it("keeps the first Social Login Link row and signals once, subject-free, when a replay names a second User", async () => {
    const handlers = buildAuthIdentityUserProjectionHandlers(pool);
    const subject = "synthetic-auth-replay-subject-marker-10295";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const linked = (userId: string) =>
      event("identity.user.social-login-linked", `identity.user-${userId}`, {
        providerName: "google",
        providerSubject: subject,
        email: `${userId}@example.test`,
        linkedAt: "2026-06-12T12:00:00.000Z",
      });
    try {
      for (const userId of ["usr_first", "usr_second"]) {
        await project(
          handlers,
          event("identity.user.created", `identity.user-${userId}`, {
            userId,
            displayName: userId,
            givenName: "Synthetic",
            familyName: "User",
            primaryEmail: `${userId}@example.test`,
          }),
        );
      }
      await project(handlers, linked("usr_first"));
      await project(handlers, linked("usr_second"));
      await project(handlers, linked("usr_first"));

      const rows = await pool.query(
        `SELECT provider_subject, user_id, email FROM auth_identity_user_social_login_links`,
      );
      expect(rows.rows).toEqual([{ provider_subject: subject, user_id: "usr_first", email: "usr_first@example.test" }]);
      const conflicts = warn.mock.calls.filter(([name]) => name === "social_login_link_conflict");
      expect(conflicts).toEqual([
        [
          "social_login_link_conflict",
          {
            providerName: "google",
            linkKey: createHash("sha256").update(`google:${subject}`).digest("hex"),
            userIds: ["usr_first", "usr_second"],
          },
        ],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(subject);
    } finally {
      warn.mockRestore();
    }
  });

  it("projects current pricing presets on membership grant and role change", async () => {
    const handlers = buildAuthIdentityMembershipProjectionHandlers(pool);
    for (const roleKey of ["owner", "manager", "fulfillment", "viewer", "platform-admin"]) {
      const membershipId = "mbr_synthetic_pricing_" + roleKey;
      for (const type of ["identity.membership.granted", "identity.membership.role-changed"]) {
        await project(
          handlers,
          event(type, "identity.membership-" + membershipId, {
            membershipId,
            userId: "usr_synthetic_pricing",
            accountId: "acc_synthetic_pricing",
            roleKey,
          }),
        );
        for (const table of ["auth_identity_memberships", "auth_identity_user_memberships"]) {
          const result = await pool.query<{ role_permissions: string[] }>(
            `SELECT role_permissions FROM ${table} WHERE membership_id = $1`,
            [membershipId],
          );
          expect(result.rows).toHaveLength(1);
          const pricing = result.rows[0]!.role_permissions.filter((key) => key.startsWith("pricing.")).sort();
          expect(pricing).toEqual(
            roleKey === "platform-admin"
              ? []
              : ["owner", "manager"].includes(roleKey)
                ? ["pricing.manage", "pricing.view"]
                : ["pricing.view"],
          );
        }
      }
    }
  });
});

function requireDatabaseBaseUrl(): string {
  if (!databaseBaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for auth projection row identity tests.");
  }

  return databaseBaseUrl;
}

let nextGlobalPosition = 0;

function event(type: string, streamId: string, data: TransportEvent["data"]): TransportEvent {
  nextGlobalPosition += 1;
  const recordedAt = `2026-06-12T12:${String(nextGlobalPosition).padStart(2, "0")}:00.000Z`;

  return buildTransportEvent(type, data, {
    id: `evt_${nextGlobalPosition}`,
    streamId,
    streamVersion: nextGlobalPosition,
    globalPosition: String(nextGlobalPosition),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_actor", forAccountId: "acc_actor" },
    timing: { occurredAt: recordedAt, recordedAt },
  });
}

async function project(handlers: ProjectorHandlerMap, projectedEvent: TransportEvent): Promise<void> {
  const handler = handlers[projectedEvent.type];
  if (!handler) {
    throw new Error(`Missing projection handler for ${projectedEvent.type}.`);
  }

  await handler(projectedEvent);
}

async function readAuthProjectionSnapshot(pool: PgTransactionalPool) {
  const [
    accounts,
    users,
    userEmails,
    userPhones,
    socialLoginLinks,
    memberships,
    userMemberships,
    invitations,
    sessions,
    sessionLookup,
  ] = await Promise.all([
    pool.query(`SELECT * FROM auth_identity_accounts ORDER BY account_id`),
    pool.query(`SELECT * FROM auth_identity_users ORDER BY user_id`),
    pool.query(`SELECT * FROM auth_identity_user_emails ORDER BY email`),
    pool.query(`SELECT * FROM auth_identity_user_phones ORDER BY phone`),
    pool.query(`SELECT * FROM auth_identity_user_social_login_links ORDER BY provider_name, provider_subject`),
    pool.query(`SELECT * FROM auth_identity_memberships ORDER BY membership_id`),
    pool.query(`SELECT * FROM auth_identity_user_memberships ORDER BY membership_id`),
    pool.query(`SELECT * FROM auth_identity_invitations ORDER BY invitation_id`),
    pool.query(`SELECT * FROM identity_sessions ORDER BY session_id`),
    pool.query(`SELECT * FROM identity_session_lookup ORDER BY token_hash`),
  ]);

  return normalizeRows({
    accounts: accounts.rows,
    users: users.rows,
    userEmails: userEmails.rows,
    userPhones: userPhones.rows,
    socialLoginLinks: socialLoginLinks.rows,
    memberships: memberships.rows,
    userMemberships: userMemberships.rows,
    invitations: invitations.rows,
    sessions: sessions.rows,
    sessionLookup: sessionLookup.rows,
  });
}

function normalizeRows<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
