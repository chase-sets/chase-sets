import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthServices } from "../runtime-support/services";
import { registerPhoneCodeRoutes } from "./phone-code-routes";
import type { AuthApiEnv } from "./support";

function buildApp(services: unknown) {
  const app = new Hono<AuthApiEnv>();
  app.use("*", async (c, next) => {
    c.set("context", {
      tenantId: "tnt_test" as never,
      audit: {
        performedByUserId: "usr_test" as never,
        forAccountId: "acc_test" as never,
      },
      trace: { traceId: "trc_test" as never },
    });
    await next();
  });
  registerPhoneCodeRoutes(app, services as AuthServices);
  return app;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("phone code auth routes", () => {
  it("normalizes phone numbers and enqueues an SMS security notification", async () => {
    const enqueueNotification = vi.fn(async () => undefined);
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    const services = {
      db: { query },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
      },
      notificationOutbox: { enqueueNotification },
    };
    const app = buildApp(services);

    const response = await app.request("/phone-code/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "(312) 555-0101" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(
      expect.objectContaining({
        phone: "+13125550101",
        tokenId: expect.stringMatching(/^cmd_/),
        expiresAt: expect.any(String),
      }),
    );
    expect(body.code).toBeUndefined();
    expect(services.identity.getUserByPhone).toHaveBeenCalledWith("+13125550101");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO identity_phone_code_tokens"),
      expect.arrayContaining(["+13125550101"]),
    );
    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          messageType: "auth.phone-code.requested",
          criticality: "security",
          channels: [
            expect.objectContaining({
              channel: "sms",
              to: { e164: "+13125550101" },
            }),
          ],
        }),
      }),
    );
  });

  it("rejects invalid or expired codes without starting a session", async () => {
    const services = {
      db: { query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] })) },
      auth: {
        hashSecret: vi.fn((value: string) => `hashed:${value}`),
      },
      identity: {
        getUserByPhone: vi.fn(async () => null),
        listActiveMembershipsForUser: vi.fn(async () => []),
      },
      notificationOutbox: { enqueueNotification: vi.fn() },
    };
    const app = buildApp(services);

    const response = await app.request("/phone-code/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "3125550101", code: "123456" }),
    });

    expect(response.status).toBe(401);
    expect(services.identity.listActiveMembershipsForUser).not.toHaveBeenCalled();
  });
});
