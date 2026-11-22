import { afterEach, expect, it, vi } from "vitest";
import { ExperienceApiError } from "../../support/request-support/platform-feedback-client";
import { loader } from "./csat-dashboard";

afterEach(() => vi.unstubAllGlobals());

function load(query: string) {
  const url = new URL(`https://admin.test/admin/csat-dashboard?${query}`);
  return loader({ request: new Request(url), params: {}, context: {}, url, pattern: "/admin/csat-dashboard" });
}

it("shows the filters with Customer Feedback's reason when it refuses them", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { code: "validation_failed", reason: "range-order" } }, { status: 400 }),
      ),
  );
  await expect(load("from=2026-10-20&to=2026-10-10&surveyVersion=csat.v1&ratings=5&states=submitted")).resolves.toEqual(
    {
      refusal: "range-order",
      filters: expect.objectContaining({
        from: "2026-10-20",
        to: "2026-10-10",
        surveyVersion: expect.objectContaining({ surveyVersion: "csat.v1" }),
        ratings: [5],
        states: ["submitted"],
      }),
    },
  );
});

it("still throws a read failure that is not a refused filter", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValueOnce(Response.json({ error: { code: "internal_error" } }, { status: 500 }));
  const failure = load("from=2026-10-20");
  await expect(failure).rejects.toBeInstanceOf(ExperienceApiError);
  await expect(failure).rejects.toMatchObject({ status: 500, body: { error: { code: "internal_error" } } });
  fetcher.mockResolvedValueOnce(
    Response.json({ error: { code: "validation_failed", reason: "unknown-reason" } }, { status: 400 }),
  );
  await expect(load("from=2026-10-20")).rejects.toMatchObject({ status: 400 });
});

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
  expect(options).toMatchObject({ method: "GET", credentials: "include" });
  expect(new Headers(options?.headers).get("cookie")).toBe("chase_sets_session=synthetic");
  expect(new Headers(options?.headers).get("content-type")).toBe("application/json");
});
