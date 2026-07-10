import { describe, expect, it } from "vitest";
import { createInternalId } from "./typed-ids";

describe("createInternalId", () => {
  it("creates distinct, prefixed UUIDs", () => {
    const first = createInternalId("job");
    const second = createInternalId("job");

    expect(first).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^job_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
