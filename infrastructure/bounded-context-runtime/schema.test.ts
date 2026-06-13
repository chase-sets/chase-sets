import { describe, expect, it } from "vitest";
import { eventSubscriptionSchemaSql } from "./index";

describe("bounded context runtime schema", () => {
  it("creates projection generation metadata for generation-aware rebuilds", () => {
    expect(eventSubscriptionSchemaSql).toContain("CREATE TABLE IF NOT EXISTS event_projection_group_generations");
    expect(eventSubscriptionSchemaSql).toContain("active_generation bigint NOT NULL DEFAULT 1");
    expect(eventSubscriptionSchemaSql).toContain("rebuilding_generation bigint NULL");
  });
});
