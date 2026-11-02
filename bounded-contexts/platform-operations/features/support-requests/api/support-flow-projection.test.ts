import { describe, expect, it } from "vitest";
import { supportFlowCatalog } from "../domain/flow-catalog";
import { projectSupportFlow } from "./support-flow-projection";

describe("projectSupportFlow", () => {
  it.each(supportFlowCatalog)("preserves %s catalog facts and applies command role rules", (definition) => {
    const support = projectSupportFlow(definition, "support", { escalated_at: null });
    expect(support.allowedResponses).toEqual(definition.allowedResponses);
    expect(support.allowedResolutions).toEqual(definition.allowedResolutions);
    expect(support.sellerResponseHours).toBe(definition.sellerResponseHours);
    expect(support.supportReviewHours).toBe(definition.supportReviewHours);

    const seller = projectSupportFlow(definition, "seller", { escalated_at: null });
    expect(seller.allowedResponses).toEqual(definition.allowedResponses);
    expect(seller.allowedResolutions).toEqual([]);
    expect(
      projectSupportFlow(definition, "seller", { escalated_at: "2026-01-01T00:00:00.000Z" }).allowedResponses,
    ).toEqual([]);

    expect(projectSupportFlow(definition, "buyer", { escalated_at: null }).allowedResponses).toEqual([]);
    expect(projectSupportFlow(definition, "buyer", { escalated_at: null }).allowedResolutions).toEqual([]);
  });
});
