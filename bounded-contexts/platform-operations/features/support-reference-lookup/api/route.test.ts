import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { PlatformOperationsApiEnv } from "../../../api";
import { createSupportReferenceLookupRoutes } from "./route";
import type { SupportReferenceLookupResult } from "./contracts";
import type { SupportReferenceLookupServices } from "./runtime";

function supportActor(
  permissions: readonly string[] = ["support.manage"],
): NonNullable<PlatformOperationsApiEnv["Variables"]["actor"]> {
  return {
    sessionId: "ses_support",
    tenantId: "tnt_chase_sets",
    userId: "usr_support",
    accountId: "acc_support",
    membershipId: "mem_support",
    roleKey: "platform-admin",
    permissions: [...permissions],
  };
}

function buildApp(options: {
  actor: PlatformOperationsApiEnv["Variables"]["actor"];
  services: SupportReferenceLookupServices;
}) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.use("*", async (c, next) => {
    c.set("actor", options.actor);
    await next();
  });
  app.route("/support-reference-lookup", createSupportReferenceLookupRoutes(options.services));

  return app;
}

function createServices(result: SupportReferenceLookupResult | null): SupportReferenceLookupServices {
  return {
    resolveSupportReference: vi.fn(async () => result),
  };
}

describe("support reference lookup routes", () => {
  it("returns a resolved reference for support managers", async () => {
    const services = createServices({
      contextName: "ordering",
      entityType: "order",
      displayReference: "ORD-E6K7M8N9",
      status: "pending-payment",
      summary: "Order ORD-E6K7M8N9",
      adminHref: "/orders/ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
    });

    const response = await buildApp({ actor: supportActor(), services }).request(
      "/support-reference-lookup/ORD-E6K7M8N9",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: { contextName: "ordering", entityType: "order", displayReference: "ORD-E6K7M8N9" },
    });
    expect(services.resolveSupportReference).toHaveBeenCalledWith("ORD-E6K7M8N9");
  });

  it("requires the support.manage permission", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: supportActor(["support.view"]), services }).request(
      "/support-reference-lookup/ORD-E6K7M8N9",
    );

    expect(response.status).toBe(403);
    expect(services.resolveSupportReference).not.toHaveBeenCalled();
  });

  it("requires an authenticated actor", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: null, services }).request("/support-reference-lookup/ORD-E6K7M8N9");

    expect(response.status).toBe(401);
    expect(services.resolveSupportReference).not.toHaveBeenCalled();
  });

  it("returns not found for unresolved references", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: supportActor(), services }).request(
      "/support-reference-lookup/ORD-MISSING",
    );

    expect(response.status).toBe(404);
  });

  it("rejects a blank reference before calling the resolver", async () => {
    const services = createServices(null);
    const response = await buildApp({ actor: supportActor(), services }).request("/support-reference-lookup/%20");

    expect(response.status).toBe(400);
    expect(services.resolveSupportReference).not.toHaveBeenCalled();
  });
});
