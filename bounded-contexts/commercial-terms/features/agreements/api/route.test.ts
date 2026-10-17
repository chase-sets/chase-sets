import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CommercialTermsApiEnv } from "../../../api";
import { createAgreementRoutes } from "./route";
import type { AgreementServices } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

function createApp(services: Partial<AgreementServices>, permissions: readonly string[], roleKey = "platform-admin") {
  const app = new Hono<CommercialTermsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_admin",
      accountId: "acc_admin",
      membershipId: "mem_test",
      roleKey,
      permissions,
    });
    c.set("context", context);
    await next();
  });
  app.route("/", createAgreementRoutes(services as AgreementServices));
  return app;
}

describe("commercial terms agreement routes", () => {
  const agreementBody = {
    label: "Preferred",
    marketplaceSalesFeePercentageBps: 550,
    marketplaceSalesFeeFixedAmount: "0.00",
    shippingAllowancePercentageBps: 700,
    status: "active",
    effectiveFrom: "2026-05-01T00:00:00.000Z",
  };
  const accountActors = ["owner", "manager"].flatMap((role) =>
    [
      { target: "own", accountId: "acc_admin" },
      { target: "another", accountId: "acc_seller" },
    ].map((account) => ({ role, ...account })),
  );

  it.each(accountActors)("$role cannot create an agreement for $target account", async ({ role, accountId }) => {
    const createAgreement = vi.fn();
    const app = createApp({ createAgreement }, ["commercial-terms.manage", "commercial-terms.view"], role);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({ ...agreementBody, accountId }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authorization_forbidden" } });
    expect(createAgreement).not.toHaveBeenCalled();
  });

  it.each(accountActors)("$role cannot revise an agreement for $target account", async ({ role, accountId }) => {
    const reviseAgreement = vi.fn();
    const app = createApp({ reviseAgreement }, ["commercial-terms.manage", "commercial-terms.view"], role);

    const response = await app.request(`/cag_${accountId}`, {
      method: "PUT",
      body: JSON.stringify({ ...agreementBody, accountId }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authorization_forbidden" } });
    expect(reviseAgreement).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT"])("requires the dedicated permission even for a platform admin using %s", async (method) => {
    const createAgreement = vi.fn();
    const reviseAgreement = vi.fn();
    const app = createApp({ createAgreement, reviseAgreement }, ["commercial-terms.manage", "commercial-terms.view"]);

    const response = await app.request(method === "POST" ? "/" : "/cag_1", {
      method,
      body: JSON.stringify({ ...agreementBody, accountId: "acc_seller" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "authorization_forbidden" } });
    expect(createAgreement).not.toHaveBeenCalled();
    expect(reviseAgreement).not.toHaveBeenCalled();
  });

  it("platform admin creates an agreement", async () => {
    const createAgreement = vi.fn(async () => ({ agreementId: "cag_created", version: 1 }));
    const app = createApp({ createAgreement }, ["commercial-terms.agreements.manage"]);

    const response = await app.request("/", {
      method: "POST",
      body: JSON.stringify({
        label: "Preferred",
        accountId: "acc_seller",
        marketplaceSalesFeePercentageBps: 550,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 700,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ id: "cag_created", version: 1 });
    expect(createAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "Preferred",
        accountId: "acc_seller",
        marketplaceSalesFeePercentageBps: 550,
        createdByUserId: "usr_admin",
      }),
      context,
    );
  });

  it("requires agreement manage permission for agreement revisions", async () => {
    const reviseAgreement = vi.fn();
    const app = createApp({ reviseAgreement }, ["commercial-terms.view"]);

    const response = await app.request("/cag_1", {
      method: "PUT",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(403);
    expect(reviseAgreement).not.toHaveBeenCalled();
  });

  it("revises account agreement terms through the admin API", async () => {
    const reviseAgreement = vi.fn(async () => ({ agreementId: "cag_1", version: 2 }));
    const app = createApp({ reviseAgreement }, ["commercial-terms.agreements.manage"]);

    const response = await app.request("/cag_1", {
      method: "PUT",
      body: JSON.stringify({
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        effectiveUntil: "2027-05-01T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "cag_1", version: 2 });
    expect(reviseAgreement).toHaveBeenCalledWith(
      "cag_1",
      expect.objectContaining({
        label: "Preferred renewal",
        marketplaceSalesFeePercentageBps: 600,
        shippingAllowancePercentageBps: 800,
        revisedByUserId: "usr_admin",
      }),
      context,
    );
  });

  it("rejects partial agreement revisions that omit the fee percentage", async () => {
    const reviseAgreement = vi.fn();
    const app = createApp({ reviseAgreement }, ["commercial-terms.agreements.manage"]);

    const response = await app.request("/cag_1", {
      method: "PUT",
      body: JSON.stringify({
        label: "Preferred renewal",
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
        status: "active",
        effectiveFrom: "2026-05-01T00:00:00.000Z",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    expect(reviseAgreement).not.toHaveBeenCalled();
  });
});
