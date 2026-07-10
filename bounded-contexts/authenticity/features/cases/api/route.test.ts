import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AuthenticityApiEnv } from "../../../api";
import { AuthenticityDomainError } from "../../../support/runtime-support/common";
import { authenticityCaseRoutes } from "./route";
import type { AuthenticityCaseServices } from "./runtime";

const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_inspector" as never,
  },
};

function buildApp(services: Readonly<Record<string, unknown>>) {
  const app = new Hono<AuthenticityApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { accountId: "acc_inspector", permissions: ["authenticity.view", "authenticity.manage"] });
    c.set("context", context);
    await next();
  });
  app.route("/cases", authenticityCaseRoutes(services as unknown as AuthenticityCaseServices));
  return app;
}

describe("authenticity case routes", () => {
  it("opens a case and returns the committed snapshot", async () => {
    const openCase = vi.fn(async () => ({ caseId: "case_1", version: 1 }));
    const getCase = vi.fn(async () => ({ case_id: "case_1", status: "awaiting-inbound" }));
    const app = buildApp({ openCase, getCase });

    const response = await app.fetch(
      new Request("http://authenticity.test/cases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_1",
          sellerAccountId: "acc_seller",
          buyerAccountId: "acc_buyer",
          orderSnapshot: { orderId: "ord_1", listingId: "lst_1", catalogItemId: "cat_1", expectedConditionLabel: "NM" },
          authenticityPlan: { planId: "plan_1", feeAmount: "8.00", feeCurrency: "USD" },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ case: { case_id: "case_1", status: "awaiting-inbound" } });
    expect(openCase).toHaveBeenCalledWith(expect.objectContaining({ orderId: "ord_1" }), context);
  });

  it("maps an illegal transition to a 409 response", async () => {
    const receiveCase = vi.fn(async () => {
      throw new AuthenticityDomainError("Only a case awaiting inbound delivery can be received.");
    });
    const app = buildApp({ receiveCase });

    const response = await app.fetch(new Request("http://authenticity.test/cases/case_1/receive", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "authenticity_case_invalid_transition",
        message: "Only a case awaiting inbound delivery can be received.",
      },
    });
  });

  it("returns 404 for a case that does not exist", async () => {
    const getCase = vi.fn(async () => null);
    const app = buildApp({ getCase });

    const response = await app.fetch(new Request("http://authenticity.test/cases/case_missing"));

    expect(response.status).toBe(404);
  });

  it("returns the per-order case status", async () => {
    const getCaseByOrderId = vi.fn(async () => ({ case_id: "case_1", order_id: "ord_1", status: "forwarded" }));
    const app = buildApp({ getCaseByOrderId });

    const response = await app.fetch(new Request("http://authenticity.test/cases/by-order/ord_1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.case).toMatchObject({ order_id: "ord_1", status: "forwarded" });
  });

  it("lists the operator queue excluding forwarded and returned cases by default", async () => {
    const listOperatorQueue = vi.fn(async () => [{ case_id: "case_1", status: "inspecting" }]);
    const app = buildApp({ listOperatorQueue });

    const response = await app.fetch(new Request("http://authenticity.test/cases"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ items: [{ case_id: "case_1", status: "inspecting" }], count: 1 });
    expect(listOperatorQueue).toHaveBeenCalledWith({ status: null, limit: 50, offset: 0 });
  });

  it("records a verdict using the acting inspector when none is supplied", async () => {
    const recordVerdict = vi.fn(async () => ({ caseId: "case_1", version: 4 }));
    const getCase = vi.fn(async () => ({ case_id: "case_1", status: "passed" }));
    const app = buildApp({ recordVerdict, getCase });

    await app.fetch(
      new Request("http://authenticity.test/cases/case_1/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          verdict: "passed",
          reasonCodes: [],
          checklistResults: [],
          evidencePhotoRefs: ["obj://evidence/1.jpg"],
        }),
      }),
    );

    expect(recordVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case_1", inspectorAccountId: "acc_inspector" }),
      context,
    );
  });
});
