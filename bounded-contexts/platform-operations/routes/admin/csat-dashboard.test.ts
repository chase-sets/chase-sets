import { afterEach, expect, it, vi } from "vitest";
import { loader } from "./csat-dashboard";

afterEach(() => vi.unstubAllGlobals());

it("forwards the CSAT route filters and session to the correct context API", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ analytics: {}, queue: {}, filters: {} }));
  vi.stubGlobal("fetch", fetcher);
  await loader({
    request: new Request("https://admin.test/admin/csat-dashboard?states=submitted&ratings=5", {
      headers: { cookie: "chase_sets_session=synthetic" },
    }),
    params: {},
    context: {},
    url: new URL("https://admin.test/admin/csat-dashboard?states=submitted&ratings=5"),
    pattern: "/admin/csat-dashboard",
  });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(String(url)).toContain("/api/customer-feedback?states=submitted&ratings=5");
  expect(new Headers(options?.headers).get("cookie")).toBe("chase_sets_session=synthetic");
});
