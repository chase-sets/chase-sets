import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { AUTH_ROLE_PERMISSIONS } from "./constants";
import {
  buildAuthIdentityAccountProjectionHandlers,
  buildAuthIdentityInvitationProjectionHandlers,
  buildAuthIdentityMembershipProjectionHandlers,
  buildAuthIdentityUserProjectionHandlers,
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
          updated_at: "2026-06-12T12:12:00.000Z",
        },
      ],
      memberships: [
        {
          membership_id: "mem_1",
          user_id: "usr_1",
          account_id: "acc_1",
          role_key: "manager",
          role_permissions: AUTH_ROLE_PERMISSIONS.manager,
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
          role_permissions: AUTH_ROLE_PERMISSIONS.manager,
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
