import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { AuthApiEnv } from "../../../api";
import { SessionRefusalError } from "../domain/domain";
import { sessionRoutes } from "./route";
import type { SessionServices } from "./runtime";

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_a",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: [],
} as ResolvedActor;

function app(commandHandler: SessionServices["commandHandler"]) {
  const services = {
    commandHandler,
    getSession: vi.fn(async () => ({ session_id: "ses_1", user_id: "usr_1" })),
  } as unknown as SessionServices;
  const hono = new Hono<AuthApiEnv>();
  hono.use("*", async (c, next) => {
    c.set("actor", actor as never);
    c.set("context", {} as never);
    await next();
  });
  hono.route("/sessions", sessionRoutes(services));
  return hono;
}

function refusing(code: ConstructorParameters<typeof SessionRefusalError>[0]) {
  return vi.fn(async () => {
    throw new SessionRefusalError(code, "refused");
  }) as unknown as SessionServices["commandHandler"];
}

describe("session list route", () => {
  it.each([
    ["a user", "owner", { userId: "usr_1" }],
    ["a platform admin", "platform-admin", { search: "usr_other" }],
  ])("lists %s's sessions as the role allows", async (_who, roleKey, scope) => {
    const listSessions = vi.fn(async () => ({ items: [], total: 0 }));
    const services = { listSessions } as unknown as SessionServices;
    const hono = new Hono<AuthApiEnv>();
    hono.use("*", async (c, next) => {
      c.set("actor", { ...actor, roleKey } as never);
      await next();
    });
    hono.route("/sessions", sessionRoutes(services));

    expect((await hono.request("/sessions?search=usr_other&status=active")).status).toBe(200);
    expect(listSessions).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      status: "active",
      limit: undefined,
      offset: undefined,
    });
  });
});

describe("session write routes", () => {
  it.each([
    [
      "switch-account",
      "account-current",
      409,
      "session_account_current",
      "This session is already using that account.",
    ],
    [
      "switch-account",
      "account-unavailable",
      400,
      "session_account_unavailable",
      "This session cannot switch to that account.",
    ],
    ["switch-account", "account-required", 400, "validation_failed", "Choose an account to switch to."],
    ["switch-account", "not-active", 409, "session_not_active", "This session is no longer active."],
    ["revoke", "not-active", 409, "session_not_active", "This session is no longer active."],
  ] as const)("answers a %s refused for %s as %i %s", async (action, refusal, status, code, message) => {
    const response = await app(refusing(refusal)).request(`/sessions/ses_1/${action}`, {
      method: "POST",
      body: JSON.stringify({ accountId: "acc_a" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message } });
  });

  it("still answers a write's success and leaves other failures to the server", async () => {
    const ok = vi.fn(async () => ({
      version: 3,
      state: { status: "revoked" },
    })) as unknown as SessionServices["commandHandler"];
    const response = await app(ok).request("/sessions/ses_1/revoke", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "ses_1", version: 3, status: "revoked" });

    const broken = vi.fn(async () => {
      throw new Error("database unavailable");
    }) as unknown as SessionServices["commandHandler"];
    const failed = await app(broken).request("/sessions/ses_1/revoke", { method: "POST" });
    expect(failed.status).toBe(500);
  });
});
