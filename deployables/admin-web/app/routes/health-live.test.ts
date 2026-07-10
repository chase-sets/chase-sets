import { describe, expect, it, vi } from "vitest";
import { loader } from "./health-live";

describe("GET /health/live", () => {
  it("returns 200 with a DB-free ok payload and makes no upstream call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const response = await loader({
      request: new Request("https://admin.example/health/live"),
      params: {},
      context: undefined,
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
