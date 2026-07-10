import { describe, expect, it, vi } from "vitest";
import { createAuthenticityCaseMcpHandlers } from "./mcp";
import type { AuthenticityCaseServices } from "./runtime";

describe("authenticity case MCP handlers", () => {
  it("looks up a case by order id through the get-case-status tool", async () => {
    const getCaseByOrderId = vi.fn(async () => ({ case_id: "case_1", order_id: "ord_1", status: "inspecting" }));
    const services = { getCaseByOrderId } as unknown as AuthenticityCaseServices;
    const handlers = createAuthenticityCaseMcpHandlers(services);

    const result = await handlers.toolHandlers["authenticity.get-case-status"]!({
      actor: { accountId: "acc_1" },
      arguments: { orderId: "ord_1" },
    } as never);

    expect(getCaseByOrderId).toHaveBeenCalledWith("ord_1");
    expect(result).toMatchObject({ case_id: "case_1", status: "inspecting" });
  });

  it("reads a case resource by uri", async () => {
    const getCase = vi.fn(async () => ({ case_id: "case_1", status: "received" }));
    const services = { getCase } as unknown as AuthenticityCaseServices;
    const handlers = createAuthenticityCaseMcpHandlers(services);

    const result = await handlers.resourceHandlers["chase-sets://authenticity/cases/{caseId}"]!({
      actor: { accountId: "acc_1" },
      uri: "chase-sets://authenticity/cases/case_1",
    } as never);

    expect(getCase).toHaveBeenCalledWith("case_1");
    expect(result).toMatchObject({ case_id: "case_1", status: "received" });
  });

  it("rejects an unsupported resource uri", async () => {
    const services = { getCase: vi.fn() } as unknown as AuthenticityCaseServices;
    const handlers = createAuthenticityCaseMcpHandlers(services);

    await expect(
      handlers.resourceHandlers["chase-sets://authenticity/cases/{caseId}"]!({
        actor: { accountId: "acc_1" },
        uri: "chase-sets://authenticity/nope",
      } as never),
    ).rejects.toThrow("Unsupported authenticity case resource URI.");
  });
});
