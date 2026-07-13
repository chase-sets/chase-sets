import {
  createAccountUserTestActor,
  createAdminTestActor,
  createAnonymousTestActor,
  createTestApp,
  useMockReset,
} from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it, vi } from "vitest";
import { createAuthServicesFake } from "../auth-support/test-support";
import type { AuthServices } from "../runtime-support/services";
import { registerSessionApiRoutes } from "./session-routes";
import type { AuthApiEnv } from "./support";

function buildApp(services: AuthServices, actor: ReturnType<typeof createAccountUserTestActor> | null) {
  return createTestApp<AuthApiEnv>({
    actor,
    routes: (app) => {
      registerSessionApiRoutes(app, services);
    },
  });
}

function createServices(overrides: Readonly<{ listSessions?: ReturnType<typeof vi.fn> }> = {}) {
  return createAuthServicesFake({
    sessions: {
      commandHandler: vi.fn(async (input: { command: Record<string, unknown> }) => ({
        version: 2,
        state: {
          status: input.command.type === "RevokeSession" ? "revoked" : "active",
        },
      })),
      listSessions: overrides.listSessions ?? vi.fn(async () => ({ items: [], total: 0 })),
    },
  });
}

useMockReset();

describe("session auth routes", () => {
  it("requires authentication to read the current session", async () => {
    const services = createServices();
    const app = buildApp(services, createAnonymousTestActor());

    const response = await app.request("/session");

    expect(response.status).toBe(401);
  });

  it("returns the actor for an authenticated session", async () => {
    const services = createServices();
    const actor = createAccountUserTestActor();
    const app = buildApp(services, actor);

    const response = await app.request("/session");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ actor });
  });

  it("requires authentication to sign out", async () => {
    const services = createServices();
    const app = buildApp(services, createAnonymousTestActor());

    const response = await app.request("/sign-out", { method: "POST" });

    expect(response.status).toBe(401);
    expect(services.sessions.commandHandler).not.toHaveBeenCalled();
  });

  it("revokes the caller's own session on sign-out", async () => {
    const services = createServices();
    const actor = createAccountUserTestActor({ sessionId: "ses_owner" });
    const app = buildApp(services, actor);

    const response = await app.request("/sign-out", { method: "POST" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "ses_owner",
      version: 2,
      status: "revoked",
    });
    expect(services.sessions.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { type: "RevokeSession" },
      }),
    );
  });

  it("denies listing sessions without the security.manage permission", async () => {
    const listSessions = vi.fn(async () => ({ items: [], total: 0 }));
    const services = createServices({ listSessions });
    const actor = createAccountUserTestActor({ permissions: ["accounts.view"] });
    const app = buildApp(services, actor);

    const response = await app.request("/sessions");

    expect(response.status).toBe(403);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("denies reading a single session without the security.manage permission", async () => {
    const services = createServices();
    const actor = createAccountUserTestActor({ permissions: ["accounts.view"] });
    const app = buildApp(services, actor);

    const response = await app.request("/sessions/ses_1");

    expect(response.status).toBe(403);
  });

  it("denies anonymous access to /sessions before any permission check", async () => {
    const listSessions = vi.fn(async () => ({ items: [], total: 0 }));
    const services = createServices({ listSessions });
    const app = buildApp(services, createAnonymousTestActor());

    const response = await app.request("/sessions");

    expect(response.status).toBe(401);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("allows security.manage actors to list sessions", async () => {
    const listSessions = vi.fn(async () => ({ items: [{ session_id: "ses_1" }], total: 1 }));
    const services = createServices({ listSessions });
    const actor = createAdminTestActor();
    const app = buildApp(services, actor);

    const response = await app.request("/sessions");

    expect(response.status).toBe(200);
    expect(listSessions).toHaveBeenCalled();
  });
});
