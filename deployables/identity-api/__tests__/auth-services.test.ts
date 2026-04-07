import { describe, expect, it, vi } from "vitest";
import { startInteractiveAuth } from "../../../bounded-contexts/auth/services";

function createServices(overrides: {
  memberships: readonly { accountId: string }[];
}) {
  const queries: string[] = [];

  const services = {
    db: {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 1 };
      }),
    },
    auth: {
      issueOpaqueToken: vi.fn((prefix: string) => `${prefix}_token`),
      hashSecret: vi.fn((value: string) => `hash:${value}`),
    },
    identity: {
      listActiveMembershipsForUser: vi.fn(async () => overrides.memberships),
      getActiveMembershipForUserAccount: vi.fn(),
    },
    sessions: {
      commandHandler: vi.fn(async () => ({
        version: 1,
        state: { status: "active" },
      })),
      getSession: vi.fn(async () => ({
        session_id: "ses_1",
        user_id: "usr_1",
        account_id: overrides.memberships[0]?.accountId ?? "acc_1",
        available_account_ids: overrides.memberships.map((membership) => membership.accountId),
        authentication_method: "password",
        status: "active",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      })),
    },
    projectors: [],
  } as any;

  return {
    services,
    queries,
  };
}

describe("startInteractiveAuth", () => {
  it("starts a session immediately when only one membership is available", async () => {
    const { services, queries } = createServices({
      memberships: [{ accountId: "acc_1" }],
    });

    const result = await startInteractiveAuth(services, {
      userId: "usr_1",
      authenticationMethod: "password",
      context: {} as never,
    });

    expect(result.type).toBe("session-started");
    expect(services.sessions.commandHandler).toHaveBeenCalledTimes(1);
    expect(queries.some((sql) => sql.includes("identity_session_tokens"))).toBe(true);
    expect(queries.some((sql) => sql.includes("identity_account_selection_tokens"))).toBe(false);
  });

  it("requires account selection when multiple memberships are available", async () => {
    const { services, queries } = createServices({
      memberships: [{ accountId: "acc_1" }, { accountId: "acc_2" }],
    });

    const result = await startInteractiveAuth(services, {
      userId: "usr_1",
      authenticationMethod: "password",
      context: {} as never,
    });

    expect(result.type).toBe("account-selection-required");
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("identity_account_selection_tokens"))).toBe(true);
    expect(queries.some((sql) => sql.includes("identity_session_tokens"))).toBe(false);
  });
});
