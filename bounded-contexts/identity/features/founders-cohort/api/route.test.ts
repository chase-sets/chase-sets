import { describe, expect, it, vi } from "vitest";
import { buildIdentityPublicApi } from "../../../api";

describe("public founders cohort count", () => {
  it("exposes the claimed count and fixed cap without landing-page presentation", async () => {
    const app = buildIdentityPublicApi({
      foundersCohort: {
        getCount: vi.fn(async () => ({ claimed: 47, cap: 500, remaining: 453 })),
      },
    } as never);

    const response = await app.request("/founders-cohort");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ claimed: 47, cap: 500, remaining: 453 });
  });
});
