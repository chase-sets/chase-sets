import { describe, expect, it, vi } from "vitest";
import type { AuthServices } from "./services";
import { bootstrapPlatformAdminPassword } from "./production-bootstrap";
import { resolveActorFromSessionId } from "./services";
import { buildAuthIdentityMembershipProjectionHandlers } from "../auth-support/identity-projection";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";

describe("platform admin password bootstrap", () => {
  it("upserts only the configured password credential", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const hashPassword = vi.fn(async (value: string) => `password:${value}`);
    const services = {
      db: { query },
      auth: { hashPassword },
    } as unknown as AuthServices;

    await bootstrapPlatformAdminPassword(services, {
      userId: "usr_platform_admin",
      credentialId: "crd_platform_admin_password",
      password: "rotate-me",
    });

    expect(hashPassword).toHaveBeenCalledWith("rotate-me");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("identity_password_credentials");
    expect(query.mock.calls[0]?.[0]).not.toContain("identity_session_tokens");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "crd_platform_admin_password",
      "usr_platform_admin",
      "password:rotate-me",
    ]);
    const handlers = buildAuthIdentityMembershipProjectionHandlers(services.db);
    await handlers["identity.membership.granted"]!(
      buildTransportEvent(
        "identity.membership.granted",
        {
          membershipId: "mbr_synthetic_bootstrap",
          userId: "usr_platform_admin",
          accountId: "acc_synthetic_bootstrap",
          roleKey: "platform-admin",
        },
        { streamId: "identity.membership-mbr_synthetic_bootstrap" },
      ),
    );
    const mirror = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO auth_identity_memberships"));
    const permissions: string[] = JSON.parse(String(mirror![1]![4]));
    const resolutionServices = {
      ...services,
      sessions: {
        getSession: vi.fn(async () => null),
        readAuthenticatedSession: vi.fn(async () => ({
          state: {
            id: "ses_synthetic_bootstrap",
            userId: "usr_platform_admin",
            accountId: "acc_synthetic_bootstrap",
            availableAccountIds: ["acc_synthetic_bootstrap"],
            authenticationMethod: "password",
            status: "active",
            expiresAt: "2099-01-01T00:00:00Z",
          },
          authenticatedAt: "2026-09-01T00:00:00Z",
        })),
      },
      identity: {
        getUser: vi.fn(async () => ({ primary_email: null })),
        getActiveMembershipForUserAccount: vi.fn(async () => ({
          membership_id: "mbr_synthetic_bootstrap",
          role_key: "platform-admin",
          role_permissions: permissions,
        })),
      },
    } as unknown as AuthServices;
    const actor = await resolveActorFromSessionId(resolutionServices, "ses_synthetic_bootstrap");
    expect(actor).not.toBeNull();
    expect(actor?.permissions).not.toContain("pricing.view");
    expect(actor?.permissions).not.toContain("pricing.manage");
  });
});
